package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/quotasource"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// User-scoped subscription quota sources (OL-1205 scenario 3, final
// baseline). A quota source is a user-registered third-party subscription
// credential polled server-side; it is NOT bound to any machine or runtime
// and renders as a standalone card above the runtimes list. All management
// routes are account-scoped (/api/me/*) and owner-fenced: a row is only ever
// addressed by id AND owner_id, so non-owners (admins included) get 404.

const (
	// quotaSourceMaxPerUser caps source sprawl per account.
	quotaSourceMaxPerUser = 20
	// quotaSourceRefreshCooldown bounds manual refresh frequency.
	quotaSourceRefreshCooldown = 30 * time.Second
	// quotaSourcePollInterval is the scheduler's regular cadence.
	quotaSourcePollInterval = 5 * time.Minute
	// quotaSourceMaxBackoff caps the failure backoff.
	quotaSourceMaxBackoff = 30 * time.Minute
)

// QuotaSourceResponse is the owner-facing view of one source. The credential
// itself never appears; credential_hint is the stored last-4 mask.
type QuotaSourceResponse struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Name           string  `json:"name"`
	BaseURL        *string `json:"base_url"`
	CredentialHint string  `json:"credential_hint"`
	// OpenCodeMode and WorkspaceID describe how an opencode source queries
	// the account: "payg" (console session Cookie) or "go" (Zen API key).
	// They live inside the sealed credential envelope, so legacy rows report
	// mode "go" and no workspace.
	OpenCodeMode string                        `json:"opencode_mode,omitempty"`
	WorkspaceID  string                        `json:"workspace_id,omitempty"`
	Enabled      bool                          `json:"enabled"`
	Visibility   string                        `json:"visibility"`
	Quota        *protocol.QuotaSourceSnapshot `json:"quota,omitempty"`
	LastPolledAt *time.Time                    `json:"last_polled_at,omitempty"`
	LastError    *QuotaSourceError             `json:"last_error,omitempty"`
	CreatedAt    time.Time                     `json:"created_at"`
	UpdatedAt    time.Time                     `json:"updated_at"`
}

type QuotaSourceError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// quotaSourceSnapshotHasPayload reports whether a stored snapshot carries
// any renderable payload: windows (glm, zenmux, opencode Go), account pools,
// balances (deepseek, opencode) or a probe result (jev_free, opencode
// pay-as-you-go). The legacy filter only accepted windows, which would drop
// every new kind's snapshot.
func quotaSourceSnapshotHasPayload(snap *protocol.QuotaSourceSnapshot) bool {
	return len(snap.Windows) > 0 || len(snap.AccountPools) > 0 ||
		len(snap.Balances) > 0 || snap.Probe != nil
}

func (h *Handler) quotaSourceToResponse(ctx context.Context, row db.QuotaSource) QuotaSourceResponse {
	resp := QuotaSourceResponse{
		ID:             uuidToString(row.ID),
		Kind:           row.Kind,
		Name:           row.Name,
		CredentialHint: row.CredentialHint,
		Enabled:        row.Enabled,
		Visibility:     row.Visibility,
		CreatedAt:      row.CreatedAt.Time,
		UpdatedAt:      row.UpdatedAt.Time,
	}
	if row.Kind == "opencode" {
		if plaintext, err := h.openQuotaSourceCredential(ctx, row); err == nil {
			credential := quotasource.ParseOpenCodeCredential(string(plaintext))
			resp.OpenCodeMode = credential.Mode
			resp.WorkspaceID = credential.WorkspaceID
		}
	}
	resp.BaseURL = ptrFromText(row.BaseUrl)
	if row.LastPolledAt.Valid {
		t := row.LastPolledAt.Time
		resp.LastPolledAt = &t
	}
	if code := ptrFromText(row.LastErrorCode); code != nil && *code != "" {
		msg := ""
		if m := ptrFromText(row.LastErrorMessage); m != nil {
			msg = *m
		}
		resp.LastError = &QuotaSourceError{Code: *code, Message: msg}
	}
	if row.Snapshot != nil {
		var snap protocol.QuotaSourceSnapshot
		if err := json.Unmarshal(row.Snapshot, &snap); err == nil && quotaSourceSnapshotHasPayload(&snap) {
			resp.Quota = &snap
		}
	}
	return resp
}

type quotaSourceCreateRequest struct {
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	Credential string  `json:"credential"`
	BaseURL    *string `json:"base_url"`
	Visibility string  `json:"visibility"`
	// opencode only: "payg" | "go" (empty = the legacy "go" default) and an
	// optional workspace id or console URL.
	OpenCodeMode string `json:"opencode_mode"`
	WorkspaceID  string `json:"workspace_id"`
}

type quotaSourcePatchRequest struct {
	Name       *string `json:"name"`
	Credential *string `json:"credential"`
	BaseURL    *string `json:"base_url"`
	Enabled    *bool   `json:"enabled"`
	Visibility *string `json:"visibility"`
	// opencode only. Nil leaves the stored mode/workspace untouched.
	OpenCodeMode *string `json:"opencode_mode"`
	WorkspaceID  *string `json:"workspace_id"`
}

// requireQuotaSourceBox writes the 503 and returns nil when encryption is
// not configured: no credential may ever be stored in plaintext.
func (h *Handler) requireQuotaSourceBox(w http.ResponseWriter) *secretbox.Box {
	if h.QuotaSourceBox == nil {
		writeErrorCode(w, http.StatusServiceUnavailable, "quota_source_encryption_unconfigured",
			"quota source encryption key is not configured (MULTICA_QUOTA_SOURCE_SECRET_KEY)")
		return nil
	}
	return h.QuotaSourceBox
}

// credentialHint returns the masked tail for display. Credentials shorter
// than 12 chars are never hinted — a 4-char tail would disclose a third of
// the secret.
func credentialHint(credential string) string {
	if len(credential) < 12 {
		return ""
	}
	return credential[len(credential)-4:]
}

// normalizedOpenCodeWorkspace canonicalizes an optional workspace id or
// console URL. Empty means the collector discovers the default workspace.
func normalizedOpenCodeWorkspace(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	id, err := quotasource.ParseOpenCodeWorkspaceID(trimmed)
	if err != nil {
		return "", fmt.Errorf("workspace_id must be a wrk_/org_ id or a console URL")
	}
	return id, nil
}

// probeQuotaSource runs one synchronous collection with the candidate
// credential/base_url (not yet stored). Returns the validated snapshot.
func (h *Handler) probeQuotaSource(ctx context.Context, driver quotasource.Driver, rawBaseURL, credential string) (*protocol.QuotaSourceSnapshot, error) {
	endpoint, err := quotasource.ValidateBaseURL(ctx, driver, rawBaseURL, nil)
	if err != nil {
		return nil, &quotasource.ProbeError{Code: "invalid_base_url", Err: err}
	}
	client := quotasource.NewHTTPClient(endpoint)
	return driver.Fetch(ctx, client, endpoint.String(), credential, time.Now())
}

// ListQuotaSources serves GET /api/me/quota-sources.
func (h *Handler) ListQuotaSources(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	rows, err := h.Queries.ListQuotaSourcesByOwner(r.Context(), parseUUID(userID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list quota sources")
		return
	}
	sources := make([]QuotaSourceResponse, len(rows))
	for i := range rows {
		sources[i] = h.quotaSourceToResponse(r.Context(), rows[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"encryption_configured": h.QuotaSourceBox != nil,
		"sources":               sources,
	})
}

// CreateQuotaSource serves POST /api/me/quota-sources. The probe runs BEFORE
// the row is written: a failed probe never lands in the database — except
// for credential-free kinds (jev_free), where a transient upstream failure
// (rate limit, 5xx, network) still lands the monitor row in its initial
// error state, so a throttled free channel cannot lock the user out of
// adding the monitor at all.
func (h *Handler) CreateQuotaSource(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req quotaSourceCreateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Kind = strings.TrimSpace(req.Kind)
	req.Name = strings.TrimSpace(req.Name)
	req.Credential = strings.TrimSpace(req.Credential)
	req.Visibility = strings.TrimSpace(req.Visibility)
	if req.Visibility == "" {
		req.Visibility = "private"
	}
	driver := quotasource.DriverFor(req.Kind)
	if driver == nil {
		writeError(w, http.StatusBadRequest, "unsupported kind (want glm, zenmux, deepseek, opencode or jev_free)")
		return
	}
	requiresCredential := driver.RequiresCredential()
	if requiresCredential && h.requireQuotaSourceBox(w) == nil {
		return
	}
	// The name is optional: blank falls back to the channel's short default
	// name so one account per channel needs no typing.
	if req.Name == "" {
		req.Name = quotasource.DefaultName(req.Kind)
	}
	if utf8.RuneCountInString(req.Name) > 64 {
		writeError(w, http.StatusBadRequest, "name must be at most 64 characters")
		return
	}
	if req.Visibility != "private" && req.Visibility != "shared" {
		writeError(w, http.StatusBadRequest, "visibility must be private or shared")
		return
	}
	if requiresCredential && strings.TrimSpace(req.Credential) == "" {
		writeError(w, http.StatusBadRequest, "credential is required")
		return
	}
	opencodeMode := ""
	opencodeWorkspace := ""
	if req.Kind == "opencode" {
		mode, ok := quotasource.NormalizeOpenCodeMode(req.OpenCodeMode)
		if !ok {
			writeError(w, http.StatusBadRequest, "opencode_mode must be payg or go")
			return
		}
		opencodeMode = mode
		if mode == quotasource.OpenCodeModePayAsYouGo {
			workspace, err := normalizedOpenCodeWorkspace(req.WorkspaceID)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			opencodeWorkspace = workspace
		}
	}
	if count, err := h.Queries.CountQuotaSourcesByOwner(r.Context(), parseUUID(userID)); err == nil && count >= quotaSourceMaxPerUser {
		writeError(w, http.StatusBadRequest, "quota source limit reached")
		return
	}

	// Synchronous probe: only a passing credential is persisted. An opencode
	// source probes the sealed envelope so the driver sees the chosen mode.
	probeCredential := req.Credential
	if req.Kind == "opencode" {
		probeCredential = quotasource.EncodeOpenCodeCredential(opencodeMode, opencodeWorkspace, req.Credential)
	}
	quota, probeErr := h.probeQuotaSource(r.Context(), driver, derefOrEmpty(ptrFromText(textFromPtr(req.BaseURL))), probeCredential)
	if probeErr != nil {
		if requiresCredential || !quotaSourceProbeTransient(probeErr) {
			writeProbeError(w, probeErr)
			return
		}
		// Credential-free monitor + transient upstream error: create the
		// row with the initial error state below instead of refusing.
		quota = nil
	}

	// Credential-free kinds never store a ciphertext nor echo a hint —
	// even when a stray credential rides along in the request; credentialed
	// kinds keep the sealed box and the masked tail.
	ciphertext := []byte{}
	hint := ""
	if requiresCredential {
		storedCredential := req.Credential
		if req.Kind == "opencode" {
			storedCredential = quotasource.EncodeOpenCodeCredential(opencodeMode, opencodeWorkspace, req.Credential)
		}
		sealed, err := h.QuotaSourceBox.Seal([]byte(storedCredential))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encrypt credential")
			return
		}
		ciphertext = sealed
		// The hint is the real secret's tail, never the envelope's JSON tail.
		hint = credentialHint(req.Credential)
	}
	var body []byte
	if quota != nil {
		if marshaled, err := json.Marshal(quota); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to marshal snapshot")
			return
		} else {
			body = marshaled
		}
	}
	now := time.Now()
	row, err := h.Queries.CreateQuotaSource(r.Context(), db.CreateQuotaSourceParams{
		OwnerID:              parseUUID(userID),
		Kind:                 req.Kind,
		Name:                 req.Name,
		BaseUrl:              textFromPtr(req.BaseURL),
		CredentialCiphertext: ciphertext,
		CredentialHint:       hint,
		Enabled:              true,
		Visibility:           req.Visibility,
		Snapshot:             body,
		LastPolledAt:         pgTimestamptz(now),
		NextPollAt:           pgTimestamptz(now.Add(quotaSourcePollInterval)),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create quota source")
		return
	}
	if probeErr != nil {
		h.recordQuotaSourceFailure(row, quotasource.ClassifyError(probeErr), sanitizeProviderError(probeErr))
		updated, err := h.Queries.GetQuotaSourceForOwner(r.Context(), db.GetQuotaSourceForOwnerParams{
			ID: row.ID, OwnerID: row.OwnerID,
		})
		if err == nil {
			row = updated
		}
	}
	writeJSON(w, http.StatusCreated, h.quotaSourceToResponse(r.Context(), row))
}

// quotaSourceProbeTransient reports whether a probe failure is an upstream
// hiccup rather than a user-input problem. Used only for credential-free
// kinds, whose rows may land despite these errors.
func quotaSourceProbeTransient(err error) bool {
	switch quotasource.ClassifyError(err) {
	case "rate_limited", "provider_error", "network_error", "unexpected_response":
		return true
	default:
		return false
	}
}

// UpdateQuotaSource serves PATCH /api/me/quota-sources/{id}. A changed
// credential or base_url (re)probes before the update lands; flipping
// enabled back to true also probes.
func (h *Handler) UpdateQuotaSource(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	row, err := h.Queries.GetQuotaSourceForOwner(r.Context(), db.GetQuotaSourceForOwnerParams{
		ID: id, OwnerID: parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "quota source not found")
		return
	}
	var req quotaSourcePatchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	driver := quotasource.DriverFor(row.Kind)
	if driver == nil {
		writeError(w, http.StatusInternalServerError, "unknown quota source kind")
		return
	}
	requiresCredential := driver.RequiresCredential()
	if requiresCredential && h.requireQuotaSourceBox(w) == nil {
		return
	}

	// Resolve the effective post-update values.
	name := row.Name
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
		// Blank means "use the channel's short default name".
		if name == "" {
			name = quotasource.DefaultName(row.Kind)
		}
		if utf8.RuneCountInString(name) > 64 {
			writeError(w, http.StatusBadRequest, "name must be at most 64 characters")
			return
		}
	}
	visibility := row.Visibility
	if req.Visibility != nil {
		visibility = strings.TrimSpace(*req.Visibility)
		if visibility != "private" && visibility != "shared" {
			writeError(w, http.StatusBadRequest, "visibility must be private or shared")
			return
		}
	}
	enabled := row.Enabled
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	baseURL := textFromPtr(req.BaseURL)
	if req.BaseURL == nil {
		baseURL = row.BaseUrl // not part of the patch: keep stored value
	}
	credential := ""
	if req.Credential != nil && requiresCredential {
		credential = strings.TrimSpace(*req.Credential)
		if credential == "" {
			writeError(w, http.StatusBadRequest, "credential must not be empty")
			return
		}
	}

	// OpenCode mode and workspace live inside the sealed credential envelope:
	// re-seal it when either changes so no schema migration is needed.
	storedOpenCode := quotasource.OpenCodeCredential{}
	opencodeMode := ""
	opencodeWorkspace := ""
	opencodeChanged := false
	if row.Kind == "opencode" {
		plaintext, err := h.openQuotaSourceCredential(r.Context(), row)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "stored credential unreadable")
			return
		}
		storedOpenCode = quotasource.ParseOpenCodeCredential(plaintext)
		opencodeMode = storedOpenCode.Mode
		opencodeWorkspace = storedOpenCode.WorkspaceID
		if req.OpenCodeMode != nil {
			mode, ok := quotasource.NormalizeOpenCodeMode(*req.OpenCodeMode)
			if !ok {
				writeError(w, http.StatusBadRequest, "opencode_mode must be payg or go")
				return
			}
			opencodeMode = mode
		}
		if req.WorkspaceID != nil {
			workspace, err := normalizedOpenCodeWorkspace(*req.WorkspaceID)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			opencodeWorkspace = workspace
		}
		if opencodeMode != quotasource.OpenCodeModePayAsYouGo {
			opencodeWorkspace = ""
		}
		opencodeChanged = opencodeMode != storedOpenCode.Mode || opencodeWorkspace != storedOpenCode.WorkspaceID
	}

	// Probe condition (final baseline): the credential changed, the base_url
	// changed by its NORMALIZED value (empty = driver default, so clearing a
	// custom address back to default counts, and re-sending the current
	// value does not), the OpenCode mode/workspace changed, or the source is
	// being re-enabled.
	credentialChanged := credential != ""
	baseURLChanged := !sameText(baseURL, row.BaseUrl)
	reEnabling := !row.Enabled && enabled
	var probeQuota *protocol.QuotaSourceSnapshot
	var probeErr error
	if credentialChanged || baseURLChanged || reEnabling || opencodeChanged {
		probeCred := credential
		if row.Kind == "opencode" {
			secret := credential
			if secret == "" {
				secret = storedOpenCode.Secret
			}
			probeCred = quotasource.EncodeOpenCodeCredential(opencodeMode, opencodeWorkspace, secret)
		} else if probeCred == "" {
			plaintext, err := h.openQuotaSourceCredential(r.Context(), row)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "stored credential unreadable")
				return
			}
			probeCred = plaintext
		}
		probeQuota, probeErr = h.probeQuotaSource(r.Context(), driver, derefOrEmpty(ptrFromText(baseURL)), probeCred)
		if probeErr != nil {
			// Credential-free kinds tolerate transient upstream errors on
			// edit too: the field update lands and the failure is recorded
			// as the poll error state instead of refusing the edit.
			if requiresCredential || !quotaSourceProbeTransient(probeErr) {
				writeProbeError(w, probeErr)
				return
			}
			probeQuota = nil
		}
	}

	params := db.UpdateQuotaSourceFieldsParams{
		ID:      row.ID,
		OwnerID: row.OwnerID,
		Name:    textFromString(name),
		// An explicit base_url (even an empty one = "back to driver
		// default") must overwrite the stored value; COALESCE alone cannot
		// tell a deliberate NULL from an absent field.
		BaseUrlSet: req.BaseURL != nil,
		BaseUrl:    baseURL,
		Enabled:    pgtype.Bool{Bool: enabled, Valid: true},
		Visibility: textFromString(visibility),
	}
	if !requiresCredential {
		// Credential-free kinds overwrite any stray stored credential and
		// hint (the empty strings are valid COALESCE args, so they stick).
		params.CredentialCiphertext = []byte{}
		params.CredentialHint = textFromString("")
	}
	if credential != "" {
		storedCredential := credential
		if row.Kind == "opencode" {
			storedCredential = quotasource.EncodeOpenCodeCredential(opencodeMode, opencodeWorkspace, credential)
		}
		ciphertext, err := h.QuotaSourceBox.Seal([]byte(storedCredential))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encrypt credential")
			return
		}
		params.CredentialCiphertext = ciphertext
		// The hint is the real secret's tail, never the envelope's JSON tail.
		params.CredentialHint = textFromString(credentialHint(credential))
	} else if row.Kind == "opencode" && opencodeChanged {
		storedCredential := quotasource.EncodeOpenCodeCredential(opencodeMode, opencodeWorkspace, storedOpenCode.Secret)
		ciphertext, err := h.QuotaSourceBox.Seal([]byte(storedCredential))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encrypt credential")
			return
		}
		params.CredentialCiphertext = ciphertext
	}
	if n, err := h.Queries.UpdateQuotaSourceFields(r.Context(), params); err != nil || n == 0 {
		writeError(w, http.StatusInternalServerError, "failed to update quota source")
		return
	}
	// A passing probe already produced a fresh snapshot: store it (this
	// also clears any stale last_error / failure counters from the previous
	// credential and re-arms polling; the re-enable case's next_poll_at may
	// otherwise sit far in the future).
	if probeQuota != nil {
		if body, err := json.Marshal(probeQuota); err == nil {
			_, _ = h.Queries.ApplyQuotaSourcePollSuccess(r.Context(), db.ApplyQuotaSourcePollSuccessParams{
				ID: row.ID, Snapshot: body, NextPollSecs: quotaSourcePollInterval.Seconds(),
			})
		}
	} else if probeErr != nil {
		h.recordQuotaSourceFailure(row, quotasource.ClassifyError(probeErr), sanitizeProviderError(probeErr))
	}
	updated, err := h.Queries.GetQuotaSourceForOwner(r.Context(), db.GetQuotaSourceForOwnerParams{
		ID: row.ID, OwnerID: row.OwnerID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload quota source")
		return
	}
	writeJSON(w, http.StatusOK, h.quotaSourceToResponse(r.Context(), updated))
}

// DeleteQuotaSource serves DELETE /api/me/quota-sources/{id}.
func (h *Handler) DeleteQuotaSource(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	if n, err := h.Queries.DeleteQuotaSource(r.Context(), db.DeleteQuotaSourceParams{
		ID: id, OwnerID: parseUUID(userID),
	}); err != nil || n == 0 {
		writeError(w, http.StatusNotFound, "quota source not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RefreshQuotaSource serves POST /api/me/quota-sources/{id}/refresh: one
// synchronous collection, 30s cooldown.
func (h *Handler) RefreshQuotaSource(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	row, err := h.Queries.GetQuotaSourceForOwner(r.Context(), db.GetQuotaSourceForOwnerParams{
		ID: id, OwnerID: parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "quota source not found")
		return
	}
	// Encryption only matters for kinds that store a credential.
	if driver := quotasource.DriverFor(row.Kind); driver != nil && driver.RequiresCredential() && h.QuotaSourceBox == nil {
		writeErrorCode(w, http.StatusServiceUnavailable, "quota_source_encryption_unconfigured",
			"quota source encryption key is not configured (MULTICA_QUOTA_SOURCE_SECRET_KEY)")
		return
	}
	if row.LastPolledAt.Valid && time.Since(row.LastPolledAt.Time) < quotaSourceRefreshCooldown {
		writeErrorCode(w, http.StatusTooManyRequests, "refresh_cooldown",
			"refreshed recently; retry later")
		return
	}
	h.refreshQuotaSourceRow(r.Context(), row)
	updated, err := h.Queries.GetQuotaSourceForOwner(r.Context(), db.GetQuotaSourceForOwnerParams{
		ID: row.ID, OwnerID: row.OwnerID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload quota source")
		return
	}
	writeJSON(w, http.StatusOK, h.quotaSourceToResponse(r.Context(), updated))
}

// refreshQuotaSourceRow runs one collection against the stored credential
// and writes the outcome (snapshot or error+backoff). Shared by the manual
// refresh route and the scheduler job.
func (h *Handler) refreshQuotaSourceRow(ctx context.Context, row db.QuotaSource) {
	driver := quotasource.DriverFor(row.Kind)
	if driver == nil {
		slog.Error("quota source: no driver for kind", "kind", row.Kind)
		return
	}
	credential, err := h.openQuotaSourceCredential(ctx, row)
	if err != nil {
		h.recordQuotaSourceFailure(row, "credential_unreadable", "stored credential could not be decrypted; re-enter it")
		return
	}
	rawBase := ""
	if base := ptrFromText(row.BaseUrl); base != nil {
		rawBase = *base
	}
	quota, err := h.probeQuotaSource(ctx, driver, rawBase, credential)
	if err != nil {
		code := quotasource.ClassifyError(err)
		h.recordQuotaSourceFailure(row, code, sanitizeProviderError(err))
		return
	}
	body, mErr := json.Marshal(quota)
	if mErr != nil {
		h.recordQuotaSourceFailure(row, "provider_error", "failed to marshal snapshot")
		return
	}
	if n, err := h.Queries.ApplyQuotaSourcePollSuccess(ctx, db.ApplyQuotaSourcePollSuccessParams{
		ID: row.ID, Snapshot: body, NextPollSecs: quotaSourcePollInterval.Seconds(),
	}); err != nil || n == 0 {
		slog.Warn("quota source: success write failed", "error", err)
	}
}

func (h *Handler) recordQuotaSourceFailure(row db.QuotaSource, code, message string) {
	// Exponential backoff: interval << failures, capped.
	streak := int64(row.ConsecutiveFailures) // this failure is streak+1
	if streak < 0 {
		streak = 0
	}
	delay := quotaSourcePollInterval * time.Duration(1<<min(streak, 4))
	if delay > quotaSourceMaxBackoff {
		delay = quotaSourceMaxBackoff
	}
	if len(message) > 300 {
		message = message[:300]
	}
	_, _ = h.Queries.ApplyQuotaSourcePollFailure(context.Background(), db.ApplyQuotaSourcePollFailureParams{
		ID:               row.ID,
		NextPollAt:       pgTimestamptz(time.Now().Add(delay)),
		LastErrorCode:    textFromString(code),
		LastErrorMessage: textFromString(message),
	})
}

// openQuotaSourceCredential decrypts the stored credential. The plaintext
// never leaves this call graph: not logged, not returned to clients.
func (h *Handler) openQuotaSourceCredential(ctx context.Context, row db.QuotaSource) (string, error) {
	// Credential-free kinds never stored anything to decrypt.
	if driver := quotasource.DriverFor(row.Kind); driver != nil && !driver.RequiresCredential() {
		return "", nil
	}
	if h.QuotaSourceBox == nil {
		return "", fmt.Errorf("encryption not configured")
	}
	plaintext, err := h.QuotaSourceBox.Open(row.CredentialCiphertext)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// sanitizeProviderError strips transport detail (which can echo the URL and
// key) down to the class + provider message.
func sanitizeProviderError(err error) string {
	var probe *quotasource.ProbeError
	if errors.As(err, &probe) && probe.Err != nil {
		return probe.Code + ": " + probe.Err.Error()
	}
	return quotasource.ClassifyError(err)
}

// writeProbeError answers a failed synchronous probe with 422 and a stable
// reason code.
func writeProbeError(w http.ResponseWriter, err error) {
	code := quotasource.ClassifyError(err)
	message := sanitizeProviderError(err)
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
		"error":   "quota source probe failed",
		"code":    "quota_source_probe_failed",
		"reason":  code,
		"message": message,
	})
}

// ListWorkspaceQuotaSources serves GET /api/runtimes/quota-sources
// (workspace-scoped, read-only): the subscription cards visible to the
// current member. private sources appear only for their owner; shared
// sources appear when the owner has at least one runtime visible to this
// member in this workspace.
func (h *Handler) ListWorkspaceQuotaSources(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	rows, err := h.Queries.ListVisibleQuotaSourcesForWorkspace(r.Context(), db.ListVisibleQuotaSourcesForWorkspaceParams{
		WorkspaceID: parseUUID(workspaceID),
		MemberID:    parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list quota sources")
		return
	}
	type cardView struct {
		ID           string                        `json:"id"`
		Kind         string                        `json:"kind"`
		Name         string                        `json:"name"`
		OwnerID      string                        `json:"owner_id"`
		Visibility   string                        `json:"visibility"`
		IsOwn        bool                          `json:"is_own"`
		Quota        *protocol.QuotaSourceSnapshot `json:"quota,omitempty"`
		LastPolledAt *time.Time                    `json:"last_polled_at,omitempty"`
		LastError    *QuotaSourceError             `json:"last_error,omitempty"`
	}
	cards := make([]cardView, 0, len(rows))
	for _, row := range rows {
		if !row.Enabled {
			continue
		}
		view := cardView{
			ID:         uuidToString(row.ID),
			Kind:       row.Kind,
			Name:       row.Name,
			OwnerID:    uuidToString(row.OwnerID),
			Visibility: row.Visibility,
			IsOwn:      uuidToString(row.OwnerID) == userID,
		}
		if row.Snapshot != nil {
			var snap protocol.QuotaSourceSnapshot
			if err := json.Unmarshal(row.Snapshot, &snap); err == nil && quotaSourceSnapshotHasPayload(&snap) {
				view.Quota = &snap
			}
		}
		if row.LastPolledAt.Valid {
			t := row.LastPolledAt.Time
			view.LastPolledAt = &t
		}
		// Error detail is owner-only; other members only see the card's data.
		if view.IsOwn {
			if code := ptrFromText(row.LastErrorCode); code != nil && *code != "" {
				msg := ""
				if m := ptrFromText(row.LastErrorMessage); m != nil {
					msg = *m
				}
				view.LastError = &QuotaSourceError{Code: *code, Message: msg}
			}
		}
		cards = append(cards, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sources": cards})
}

// textFromPtr converts an optional request string to pgtype.Text. An empty
// or whitespace-only value means "driver default" (NULL), matching the
// table's semantics and the probe path.
func textFromPtr(s *string) pgtype.Text {
	if s == nil || strings.TrimSpace(*s) == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: strings.TrimSpace(*s), Valid: true}
}

// ptrFromTextNormalized converts a stored optional base_url to *string with
// empty strings collapsed to nil, so stored and incoming values compare by
// their normalized form.
func ptrFromTextNormalized(t pgtype.Text) *string {
	if !t.Valid || strings.TrimSpace(t.String) == "" {
		return nil
	}
	v := strings.TrimSpace(t.String)
	return &v
}

// textFromString builds a valid pgtype.Text (never NULL).
func textFromString(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: true}
}

// ptrFromText converts a stored optional string to *string (nil when NULL).
func ptrFromText(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	v := t.String
	return &v
}

func pgTimestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}

// derefOrEmpty maps an optional base_url to its raw string; nil = default.
func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// sameText compares two optional strings by their normalized form (empty or
// whitespace = NULL = driver default).
func sameText(a, b pgtype.Text) bool {
	return sameOptionalString(ptrFromTextNormalized(a), ptrFromTextNormalized(b))
}

func sameOptionalString(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// PollDueSource implements scheduler.QuotaSourcePoller: one collection round
// for an already-loaded row.
func (h *Handler) PollDueSource(ctx context.Context, row db.QuotaSource) error {
	// Encryption only gates kinds that store a credential; jev_free rows
	// keep polling without MULTICA_QUOTA_SOURCE_SECRET_KEY.
	if driver := quotasource.DriverFor(row.Kind); driver == nil {
		return fmt.Errorf("no driver for kind %s; skipping source %s", row.Kind, uuidToString(row.ID))
	} else if driver.RequiresCredential() && h.QuotaSourceBox == nil {
		return fmt.Errorf("encryption key not configured; skipping source %s", uuidToString(row.ID))
	}
	if !row.Enabled {
		return nil
	}
	h.refreshQuotaSourceRow(ctx, row)
	return nil
}
