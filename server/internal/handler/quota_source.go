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
	ID             string                     `json:"id"`
	Kind           string                     `json:"kind"`
	Name           string                     `json:"name"`
	BaseURL        *string                    `json:"base_url"`
	CredentialHint string                     `json:"credential_hint"`
	Enabled        bool                       `json:"enabled"`
	Visibility     string                     `json:"visibility"`
	Quota          *protocol.RuntimePlanQuota `json:"quota,omitempty"`
	LastPolledAt   *time.Time                 `json:"last_polled_at,omitempty"`
	LastError      *QuotaSourceError          `json:"last_error,omitempty"`
	CreatedAt      time.Time                  `json:"created_at"`
	UpdatedAt      time.Time                  `json:"updated_at"`
}

type QuotaSourceError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func quotaSourceToResponse(row db.QuotaSource) QuotaSourceResponse {
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
		var quota protocol.RuntimePlanQuota
		if err := json.Unmarshal(row.Snapshot, &quota); err == nil && quota.Windows != nil {
			resp.Quota = &quota
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
}

type quotaSourcePatchRequest struct {
	Name       *string `json:"name"`
	Credential *string `json:"credential"`
	BaseURL    *string `json:"base_url"`
	Enabled    *bool   `json:"enabled"`
	Visibility *string `json:"visibility"`
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

// probeQuotaSource runs one synchronous collection with the candidate
// credential/base_url (not yet stored). Returns the validated snapshot.
func (h *Handler) probeQuotaSource(ctx context.Context, driver quotasource.Driver, rawBaseURL, credential string) (*protocol.RuntimePlanQuota, error) {
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
		sources[i] = quotaSourceToResponse(rows[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"encryption_configured": h.QuotaSourceBox != nil,
		"sources":               sources,
	})
}

// CreateQuotaSource serves POST /api/me/quota-sources. The probe runs BEFORE
// the row is written: a failed probe never lands in the database.
func (h *Handler) CreateQuotaSource(w http.ResponseWriter, r *http.Request) {
	if h.requireQuotaSourceBox(w) == nil {
		return
	}
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
	req.Visibility = strings.TrimSpace(req.Visibility)
	if req.Visibility == "" {
		req.Visibility = "private"
	}
	driver := quotasource.DriverFor(req.Kind)
	if driver == nil {
		writeError(w, http.StatusBadRequest, "unsupported kind (want glm or zenmux)")
		return
	}
	if req.Name == "" || utf8.RuneCountInString(req.Name) > 64 {
		writeError(w, http.StatusBadRequest, "name must be 1-64 characters")
		return
	}
	if req.Visibility != "private" && req.Visibility != "shared" {
		writeError(w, http.StatusBadRequest, "visibility must be private or shared")
		return
	}
	if strings.TrimSpace(req.Credential) == "" {
		writeError(w, http.StatusBadRequest, "credential is required")
		return
	}
	if count, err := h.Queries.CountQuotaSourcesByOwner(r.Context(), parseUUID(userID)); err == nil && count >= quotaSourceMaxPerUser {
		writeError(w, http.StatusBadRequest, "quota source limit reached")
		return
	}

	// Synchronous probe: only a passing credential is persisted.
	quota, probeErr := h.probeQuotaSource(r.Context(), driver, derefOrEmpty(ptrFromText(textFromPtr(req.BaseURL))), req.Credential)
	if probeErr != nil {
		writeProbeError(w, probeErr)
		return
	}

	ciphertext, err := h.QuotaSourceBox.Seal([]byte(req.Credential))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encrypt credential")
		return
	}
	body, err := json.Marshal(quota)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to marshal snapshot")
		return
	}
	now := time.Now()
	row, err := h.Queries.CreateQuotaSource(r.Context(), db.CreateQuotaSourceParams{
		OwnerID:              parseUUID(userID),
		Kind:                 req.Kind,
		Name:                 req.Name,
		BaseUrl:              textFromPtr(req.BaseURL),
		CredentialCiphertext: ciphertext,
		CredentialHint:       credentialHint(req.Credential),
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
	writeJSON(w, http.StatusCreated, quotaSourceToResponse(row))
}

// UpdateQuotaSource serves PATCH /api/me/quota-sources/{id}. A changed
// credential or base_url (re)probes before the update lands; flipping
// enabled back to true also probes.
func (h *Handler) UpdateQuotaSource(w http.ResponseWriter, r *http.Request) {
	if h.requireQuotaSourceBox(w) == nil {
		return
	}
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

	// Resolve the effective post-update values.
	name := row.Name
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
		if name == "" || utf8.RuneCountInString(name) > 64 {
			writeError(w, http.StatusBadRequest, "name must be 1-64 characters")
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
	if req.Credential != nil {
		credential = strings.TrimSpace(*req.Credential)
		if credential == "" {
			writeError(w, http.StatusBadRequest, "credential must not be empty")
			return
		}
	}

	// Probe condition (final baseline): the credential changed, the base_url
	// changed by its NORMALIZED value (empty = driver default, so clearing a
	// custom address back to default counts, and re-sending the current
	// value does not), or the source is being re-enabled.
	credentialChanged := credential != ""
	baseURLChanged := !sameText(baseURL, row.BaseUrl)
	reEnabling := !row.Enabled && enabled
	var probeQuota *protocol.RuntimePlanQuota
	var probeErr error
	if credentialChanged || baseURLChanged || reEnabling {
		probeCred := credential
		if probeCred == "" {
			plaintext, err := h.openQuotaSourceCredential(r.Context(), row)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "stored credential unreadable")
				return
			}
			probeCred = plaintext
		}
		probeQuota, probeErr = h.probeQuotaSource(r.Context(), driver, derefOrEmpty(ptrFromText(baseURL)), probeCred)
		if probeErr != nil {
			writeProbeError(w, probeErr)
			return
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
	if credential != "" {
		ciphertext, err := h.QuotaSourceBox.Seal([]byte(credential))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encrypt credential")
			return
		}
		params.CredentialCiphertext = ciphertext
		params.CredentialHint = textFromString(credentialHint(credential))
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
	}
	updated, err := h.Queries.GetQuotaSourceForOwner(r.Context(), db.GetQuotaSourceForOwnerParams{
		ID: row.ID, OwnerID: row.OwnerID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload quota source")
		return
	}
	writeJSON(w, http.StatusOK, quotaSourceToResponse(updated))
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
	if h.requireQuotaSourceBox(w) == nil {
		return
	}
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
	writeJSON(w, http.StatusOK, quotaSourceToResponse(updated))
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
		ID           string                     `json:"id"`
		Kind         string                     `json:"kind"`
		Name         string                     `json:"name"`
		OwnerID      string                     `json:"owner_id"`
		Visibility   string                     `json:"visibility"`
		IsOwn        bool                       `json:"is_own"`
		Quota        *protocol.RuntimePlanQuota `json:"quota,omitempty"`
		LastPolledAt *time.Time                 `json:"last_polled_at,omitempty"`
		LastError    *QuotaSourceError          `json:"last_error,omitempty"`
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
			var quota protocol.RuntimePlanQuota
			if err := json.Unmarshal(row.Snapshot, &quota); err == nil && quota.Windows != nil {
				view.Quota = &quota
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
	if h.QuotaSourceBox == nil {
		return fmt.Errorf("encryption key not configured; skipping source %s", uuidToString(row.ID))
	}
	if !row.Enabled {
		return nil
	}
	h.refreshQuotaSourceRow(ctx, row)
	return nil
}
