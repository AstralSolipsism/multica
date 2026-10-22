package handler

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Reusable GitHub App installations (OL-928, fork).
//
// When an account has already installed this deployment's GitHub App, GitHub
// parks the browser on its Configure page instead of redirecting back to
// /api/github/setup, so the (workspace_id, installation_id) binding can never
// be recorded through the normal Connect flow. These endpoints let a manager
// re-bind an installation they already manage to another workspace.
//
// Security (review decision, option A): a caller may only see and re-bind
// installations bound to some workspace where they are owner/admin — never
// the App's full installation list.

// GitHubAppInstallationResponse is the shape returned by the reusable
// installations list endpoint: installations the caller already manages
// elsewhere, flagged with whether they are already bound to the requesting
// workspace.
type GitHubAppInstallationResponse struct {
	InstallationID   int64   `json:"installation_id"`
	AccountLogin     string  `json:"account_login"`
	AccountType      string  `json:"account_type"`
	AccountAvatarURL *string `json:"account_avatar_url"`
	Connected        bool    `json:"connected"`
}

// ListGitHubAppInstallations (GET /api/workspaces/{id}/github/app-installations)
// lists installations the caller manages in some workspace (owner/admin there),
// each flagged with whether it is already bound to this workspace.
func (h *Handler) ListGitHubAppInstallations(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	userUUID, ok := requestUserUUIDOrBadRequest(w, r)
	if !ok {
		return
	}
	if !isGitHubRepositoryBrowseConfigured() {
		writeJSON(w, http.StatusOK, map[string]any{
			"installations": []GitHubAppInstallationResponse{},
			"configured":    false,
		})
		return
	}
	managed, err := h.Queries.ListManagedGitHubInstallationIDsByUser(r.Context(), userUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list installations")
		return
	}
	managedSet := make(map[int64]struct{}, len(managed))
	for _, id := range managed {
		managedSet[id] = struct{}{}
	}
	connected := map[int64]struct{}{}
	rows, err := h.Queries.ListGitHubInstallationsByWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list installations")
		return
	}
	for _, row := range rows {
		connected[row.InstallationID] = struct{}{}
	}
	// Fetch each managed installation directly (GET /app/installations/{id})
	// instead of the app-wide GET /app/installations list: only the caller's
	// managed set is needed, and the app-wide inventory is paginated — a
	// first-page-only fetch silently drops managed installations beyond the
	// first 100 (OL-957).
	out := make([]GitHubAppInstallationResponse, 0, len(managedSet))
	for id := range managedSet {
		account, err := fetchGitHubInstallationAccountStrict(r.Context(), id)
		if err != nil {
			// Stale binding rows (uninstalled on GitHub) and suspended
			// installations are skipped, not fatal: neither can be bound.
			if errors.Is(err, errGitHubInstallationNotFound) || errors.Is(err, errGitHubInstallationSuspended) {
				continue
			}
			slog.Warn("github: fetch installation failed", "err", err, "installation_id", id)
			writeError(w, http.StatusBadGateway, "failed to list github app installations")
			return
		}
		_, isConnected := connected[id]
		out = append(out, GitHubAppInstallationResponse{
			InstallationID:   id,
			AccountLogin:     account.login,
			AccountType:      account.accountType,
			AccountAvatarURL: account.avatar,
			Connected:        isConnected,
		})
	}
	// Map iteration order is random; sort so clients get a stable list.
	slices.SortFunc(out, func(a, b GitHubAppInstallationResponse) int {
		if c := strings.Compare(strings.ToLower(a.AccountLogin), strings.ToLower(b.AccountLogin)); c != 0 {
			return c
		}
		return cmp.Compare(a.InstallationID, b.InstallationID)
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"installations": out,
		"configured":    true,
	})
}

// ConnectGitHubInstallation (POST /api/workspaces/{id}/github/installations)
// binds an already-existing GitHub App installation to the workspace without
// going through the browser install flow — the recovery path for accounts
// GitHub parks on its Configure page instead of redirecting back to us.
// The caller must already manage the installation in some workspace.
func (h *Handler) ConnectGitHubInstallation(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	var body struct {
		InstallationID int64 `json:"installation_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.InstallationID <= 0 {
		writeError(w, http.StatusBadRequest, "invalid installation_id")
		return
	}
	if !isGitHubRepositoryBrowseConfigured() {
		writeFeatureDisabled(w, "github_app_auth_not_configured", "github app authentication is not configured")
		return
	}
	userUUID, ok := requestUserUUIDOrBadRequest(w, r)
	if !ok {
		return
	}
	// Reuse allowlist (option A): the installation must already be bound to a
	// workspace this caller manages. 404, not 403 — the ID's existence must
	// not leak to callers who don't manage it.
	managed, err := h.Queries.ListManagedGitHubInstallationIDsByUser(r.Context(), userUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to connect installation")
		return
	}
	allowed := false
	for _, id := range managed {
		if id == body.InstallationID {
			allowed = true
			break
		}
	}
	if !allowed {
		writeError(w, http.StatusNotFound, "github installation not found")
		return
	}
	// Strictly verify the installation belongs to this App and is active
	// before binding: unlike the setup callback's best-effort
	// fetchInstallationAccount, a miss here must refuse rather than fall back
	// to a placeholder.
	account, err := fetchGitHubInstallationAccountStrict(r.Context(), body.InstallationID)
	if err != nil {
		if errors.Is(err, errGitHubInstallationNotFound) {
			writeError(w, http.StatusNotFound, "github installation not found")
			return
		}
		if errors.Is(err, errGitHubInstallationSuspended) {
			writeError(w, http.StatusUnprocessableEntity, "github installation is suspended")
			return
		}
		slog.Warn("github: verify installation failed", "err", err, "installation_id", body.InstallationID)
		writeError(w, http.StatusBadGateway, "failed to verify github installation")
		return
	}
	inst, err := h.Queries.CreateGitHubInstallation(r.Context(), db.CreateGitHubInstallationParams{
		WorkspaceID:      wsUUID,
		InstallationID:   body.InstallationID,
		AccountLogin:     account.login,
		AccountType:      coalesce(account.accountType, "User"),
		AccountAvatarUrl: ptrToText(account.avatar),
		ConnectedByID:    userUUID,
	})
	if err != nil {
		slog.Error("github: failed to persist installation", "err", err, "installation_id", body.InstallationID)
		writeError(w, http.StatusInternalServerError, "failed to connect installation")
		return
	}
	// The strict fetch just returned the current account metadata; only clear
	// any pending webhook snapshot instead of letting the older data overwrite
	// it (a renamed account would otherwise persist its previous login).
	if err := h.Queries.DeletePendingGitHubInstallation(r.Context(), inst.InstallationID); err != nil {
		slog.Warn("github: delete pending installation failed", "err", err, "installation_id", inst.InstallationID)
	}
	h.publish(protocol.EventGitHubInstallationCreated, workspaceID, "system", "", map[string]any{
		"installation": githubInstallationToBroadcast(inst),
	})
	writeJSON(w, http.StatusCreated, githubInstallationToResponse(inst))
}

var (
	errGitHubInstallationNotFound  = errors.New("github installation not found")
	errGitHubInstallationSuspended = errors.New("github installation is suspended")
)

// requestUserUUIDOrBadRequest resolves the authenticated caller's user UUID
// using the repo's standard two-step idiom (see UpsertClientUsage).
func requestUserUUIDOrBadRequest(w http.ResponseWriter, r *http.Request) (pgtype.UUID, bool) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return pgtype.UUID{}, false
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return pgtype.UUID{}, false
	}
	return userUUID, true
}

type githubInstallationAccount struct {
	login       string
	accountType string
	avatar      *string
}

// fetchGitHubInstallationAccountStrict is fetchInstallationAccount's strict
// sibling: any failure (404, suspension, other non-200, network error, decode
// error, missing account.login) is an error instead of a placeholder
// fallback. Suspended installations are refused too — the webhook deletes
// every binding on suspend, so binding one would dead-end repository
// browsing until GitHub sends `unsuspend`.
func fetchGitHubInstallationAccountStrict(ctx context.Context, installationID int64) (githubInstallationAccount, error) {
	var account githubInstallationAccount
	appJWT, err := signGitHubAppJWT(time.Now())
	if err != nil {
		return account, err
	}
	if appJWT == "" {
		return account, errors.New("github App JWT credentials unavailable")
	}
	endpoint := fmt.Sprintf(
		"%s/app/installations/%d",
		strings.TrimRight(githubAPIBase, "/"),
		installationID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return account, err
	}
	setGitHubAPIHeaders(req, appJWT)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return account, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, githubAPIResponseLimit))
		return account, errGitHubInstallationNotFound
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, githubAPIResponseLimit))
		return account, fmt.Errorf("verify installation: github status %d", resp.StatusCode)
	}
	var body struct {
		SuspendedAt *string `json:"suspended_at"`
		Account     struct {
			Login     string `json:"login"`
			Type      string `json:"type"`
			AvatarURL string `json:"avatar_url"`
		} `json:"account"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, githubAPIResponseLimit)).Decode(&body); err != nil {
		return account, fmt.Errorf("decode installation: %w", err)
	}
	if body.SuspendedAt != nil && *body.SuspendedAt != "" {
		return account, errGitHubInstallationSuspended
	}
	if body.Account.Login == "" {
		return account, errors.New("installation account login missing")
	}
	account.login = body.Account.Login
	account.accountType = body.Account.Type
	account.avatar = strPtrOrNil(body.Account.AvatarURL)
	return account, nil
}
