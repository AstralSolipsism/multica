package handler

// GitHub setup callback binding gate (OL-955, fork).
//
// The public /api/github/setup callback used to persist the
// (workspace_id, installation_id) binding armed with nothing but a signed
// state that named the workspace. Any workspace owner/admin who learned a
// numeric installation_id could mint their own state (the Connect endpoint
// is admin-gated for THEIR workspace) and bind someone else's GitHub
// organization to it. This gate aligns the callback with the OL-928 review
// decision (option A) plus the owner decision on the zero-binding branch
// (option 1, OL-955 review):
//
//   - installation already bound: only a manager of a bound workspace (the
//     operator recovered from the signed state, never from headers) may add
//     another binding. Same allowlist as the OL-928 reuse API — one query,
//     ListManagedGitHubInstallationIDsByUser.
//   - zero bindings (first install): GitHub must confirm the installation
//     exists on this App and is active (fetchGitHubInstallationAccountStrict,
//     reused from OL-928). Anything the App cannot verify — unconfigured
//     credentials, network error, 5xx, rate limiting, bad payload — is
//     REFUSED with a retryable error so unallocated or foreign IDs cannot
//     be squatted. The residual window (an active, currently-unbound
//     installation whose numeric id is known) needs GitHub user
//     authorization and is tracked in OL-1069.

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
)

// ── Setup state with operator (fork extension of upstream's state) ──────────
//
// Upstream's signStateForReturn/verifyStateWithReturn sign 3- or 4-part
// tokens (workspace, optional returnTo, nonce). The setup callback is a
// public route whose X-User-ID header is client-forgeable, so the operator
// identity the binding gate relies on travels inside the state instead:
//
//	<ws>.<returnTo>.<operator>.<nonce>.<sig>
//
// Legacy 3/4-part tokens verify too (empty operator) — states minted before
// this change must not strand an in-flight install.

// signGitHubSetupState signs a 5-part setup state naming the operator who
// started the flow (the authenticated caller of the admin-gated Connect
// endpoint). operatorID may be empty, which produces the legacy 4-part
// shape without an operator segment.
func signGitHubSetupState(workspaceID, returnTo, operatorID string) (string, error) {
	if operatorID == "" {
		return signStateForReturn(workspaceID, returnTo)
	}
	secret := githubWebhookSecret()
	if secret == "" {
		return "", errors.New("github integration is not configured")
	}
	if !isAllowedGitHubReturnTo(returnTo) {
		return "", errors.New("invalid github return target")
	}
	if _, err := parseStrictUUID(operatorID); err != nil {
		return "", errors.New("invalid operator id")
	}
	nonceBytes := make([]byte, 12)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", err
	}
	payload := workspaceID + "." + returnTo + "." + operatorID + "." + hex.EncodeToString(nonceBytes)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return payload + "." + hex.EncodeToString(mac.Sum(nil)), nil
}

// verifyGitHubSetupState validates a state minted by signGitHubSetupState
// and recovers the workspace, return target, and operator (invalid UUID when
// the token carries none). The operator is only ever read from this signed
// token, never from request headers.
func verifyGitHubSetupState(token string) (workspaceID, returnTo string, operator pgtype.UUID, ok bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 5 {
		ws, ret, legacyOK := verifyStateWithReturn(token)
		return ws, ret, pgtype.UUID{}, legacyOK
	}
	secret := githubWebhookSecret()
	if secret == "" {
		return "", "", pgtype.UUID{}, false
	}
	workspaceID, returnTo, operatorID := parts[0], parts[1], parts[2]
	if !isAllowedGitHubReturnTo(returnTo) {
		return "", "", pgtype.UUID{}, false
	}
	operator, err := parseStrictUUID(operatorID)
	if err != nil {
		return "", "", pgtype.UUID{}, false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join(parts[:4], ".")))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(parts[4])) {
		return "", "", pgtype.UUID{}, false
	}
	return workspaceID, returnTo, operator, true
}

// ── Binding gate ────────────────────────────────────────────────────────────

// github_error redirect codes the frontend renders (not_authorized and
// unknown_installation names are pinned for OL-929).
const (
	githubSetupErrNotAuthorized   = "not_authorized"
	githubSetupErrUnknown         = "unknown_installation"
	githubSetupErrSuspended       = "installation_suspended"
	githubSetupErrVerifyTransient = "verification_unavailable"
)

// reviewGitHubSetupBinding decides whether /api/github/setup may persist the
// (workspace, installation_id) binding. It returns a github_error redirect
// code to refuse with, or "" when the binding may proceed. On success via
// the zero-binding branch it also returns the GitHub-verified account
// metadata so the row is written with real data instead of the "unknown"
// placeholder (one GitHub call instead of two).
func (h *Handler) reviewGitHubSetupBinding(
	ctx context.Context,
	operator pgtype.UUID,
	installationID int64,
) (account githubInstallationAccount, errCode string) {
	bound, err := h.Queries.ListGitHubInstallationsByInstallationID(ctx, installationID)
	if err != nil {
		slog.Error("github: setup gate failed to list bindings", "err", err, "installation_id", installationID)
		return account, githubSetupErrVerifyTransient
	}
	if len(bound) > 0 {
		if !operator.Valid {
			return account, githubSetupErrNotAuthorized
		}
		// Same allowlist as the OL-928 reuse API: installations bound to a
		// workspace where the operator is owner/admin.
		allowed, err := h.Queries.ListManagedGitHubInstallationIDsByUser(ctx, operator)
		if err != nil {
			slog.Error("github: setup gate failed to list managed installations", "err", err, "installation_id", installationID)
			return account, githubSetupErrVerifyTransient
		}
		for _, id := range allowed {
			if id == installationID {
				return account, ""
			}
		}
		slog.Warn("github: setup callback refused cross-workspace binding",
			"installation_id", installationID, "bound_workspaces", len(bound))
		return account, githubSetupErrNotAuthorized
	}
	// Zero-binding branch (owner decision, option 1): refuse anything the
	// App cannot verify — unconfigured credentials included.
	account, err = fetchGitHubInstallationAccountStrict(ctx, installationID)
	switch {
	case err == nil:
		return account, ""
	case errors.Is(err, errGitHubInstallationNotFound):
		return account, githubSetupErrUnknown
	case errors.Is(err, errGitHubInstallationSuspended):
		return account, githubSetupErrSuspended
	default:
		slog.Warn("github: setup gate cannot verify installation, refusing (retryable)",
			"err", err, "installation_id", installationID)
		return account, githubSetupErrVerifyTransient
	}
}
