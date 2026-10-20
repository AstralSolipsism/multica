package handler

// GitHub setup callback binding guard (OL-955, fork).
//
// The public /api/github/setup callback used to persist the
// (workspace_id, installation_id) binding armed with nothing but a signed
// state that named the workspace. Any workspace owner/admin who learned a
// numeric installation_id could mint their own state (the Connect endpoint
// is admin-gated for THEIR workspace) and bind someone else's GitHub
// organization to it. This gate aligns the callback with the OL-928 review
// decision (option A): rebinding an ALREADY-BOUND installation requires the
// signed operator of the flow to be owner/admin of one of its bound
// workspaces. Zero-binding first installs keep working — that compat
// requirement is what separates this path from OL-928's direct-bind API.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// errGitHubSetupInstallationUnknown marks a GitHub-confirmed miss: the
// installation does not exist on this deployment's App (404) or is suspended.
// Distinct from any transient failure, which must not block a legit install.
var errGitHubSetupInstallationUnknown = errors.New("github installation not installed on this app or suspended")

// reviewGitHubSetupBinding decides whether /api/github/setup may persist the
// (workspace, installation_id) binding. It returns a github_error redirect
// code to refuse with, or "" when the binding may proceed.
//
//   - installation already bound: the operator (recovered from the signed
//     state, never from headers) must be owner/admin of a bound workspace.
//   - zero bindings (first install): allowed. When App JWT auth is
//     configured, a GitHub-confirmed 404/suspended installation is refused;
//     transient GitHub failures degrade open, mirroring the best-effort
//     account enrichment in fetchInstallationAccount.
func (h *Handler) reviewGitHubSetupBinding(ctx context.Context, operator pgtype.UUID, installationID int64) string {
	bound, err := h.Queries.ListGitHubInstallationsByInstallationID(ctx, installationID)
	if err != nil {
		slog.Error("github: setup gate failed to list bindings", "err", err, "installation_id", installationID)
		return "persist_failed"
	}
	if len(bound) == 0 {
		if isGitHubRepositoryBrowseConfigured() {
			if err := verifyGitHubSetupInstallation(ctx, installationID); err != nil {
				if errors.Is(err, errGitHubSetupInstallationUnknown) {
					return "unknown_installation"
				}
				slog.Warn("github: setup gate could not verify installation, proceeding", "err", err, "installation_id", installationID)
			}
		}
		return ""
	}
	if !operator.Valid {
		return "not_authorized"
	}
	for _, inst := range bound {
		member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
			UserID:      operator,
			WorkspaceID: inst.WorkspaceID,
		})
		if err != nil {
			continue
		}
		if roleAllowed(member.Role, "owner", "admin") {
			return ""
		}
	}
	slog.Warn("github: setup callback refused cross-workspace binding",
		"installation_id", installationID, "operator", uuidToString(operator), "bound_workspaces", len(bound))
	return "not_authorized"
}

// verifyGitHubSetupInstallation confirms via an App-JWT call that the
// installation exists on this deployment's App and is active. Returns
// errGitHubSetupInstallationUnknown on a confirmed 404/suspension, another
// error on transient failures (network, GitHub 5xx, decode), and nil when
// the installation checks out or App auth is unconfigured.
func verifyGitHubSetupInstallation(ctx context.Context, installationID int64) error {
	appJWT, err := signGitHubAppJWT(time.Now())
	if err != nil {
		return err
	}
	if appJWT == "" {
		return nil
	}
	endpoint := fmt.Sprintf(
		"%s/app/installations/%d",
		strings.TrimRight(githubAPIBase, "/"),
		installationID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	setGitHubAPIHeaders(req, appJWT)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, githubAPIResponseLimit))
		return errGitHubSetupInstallationUnknown
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, githubAPIResponseLimit))
		return fmt.Errorf("verify installation: github status %d", resp.StatusCode)
	}
	var body struct {
		SuspendedAt *string `json:"suspended_at"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, githubAPIResponseLimit)).Decode(&body); err != nil {
		return fmt.Errorf("decode installation: %w", err)
	}
	if body.SuspendedAt != nil && *body.SuspendedAt != "" {
		return errGitHubSetupInstallationUnknown
	}
	return nil
}
