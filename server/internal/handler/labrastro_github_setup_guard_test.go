package handler

// Adversarial regression tests for the OL-955 setup-callback binding gate.
//
// Already-bound installations: only a manager (owner/admin of a bound
// workspace — the OL-928 option A allowlist) may add another binding; anyone
// else, forged headers included, is refused and nothing is written.
//
// Zero-binding first installs (owner decision, option 1): GitHub must verify
// the installation exists on this App and is active. Anything unverified —
// unconfigured App credentials, network error, 5xx, rate limiting, suspended
// — is refused with a retryable error and nothing is written. The residual
// window (active but currently-unbound installation whose numeric id is
// known) needs GitHub user authorization and is tracked in OL-1069.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// setupGuardBaseInstallationID is the per-file base; every case offsets it so
// cases sharing a database stay independent. Cleanup covers the base row set.
const setupGuardBaseInstallationID = int64(90955)

// setupGuardFixture installs the env the gate reads and registers cleanup.
func setupGuardFixture(t *testing.T, ctx context.Context) int64 {
	t.Helper()
	t.Setenv("GITHUB_WEBHOOK_SECRET", "setup-guard-secret")
	t.Setenv("FRONTEND_ORIGIN", "https://app.example.test")
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id BETWEEN $1 AND $1 + 100`,
			setupGuardBaseInstallationID)
		testPool.Exec(ctx, `DELETE FROM github_pending_installation WHERE installation_id BETWEEN $1 AND $1 + 100`,
			setupGuardBaseInstallationID)
	})
	return setupGuardBaseInstallationID
}

// stubGitHubInstallation points githubAPIBase at a stub answering
// GET /app/installations/{id} with the given status and body, and fails the
// test on any other path. Every gate path goes through it, so no test in
// this file ever reaches the real api.github.com.
func stubGitHubInstallation(t *testing.T, installationID int64, status int, body string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != fmt.Sprintf("/app/installations/%d", installationID) {
			t.Errorf("unexpected GitHub call %s", r.URL.Path)
			http.Error(w, "unexpected", http.StatusTeapot)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	old := githubAPIBase
	githubAPIBase = srv.URL
	t.Cleanup(func() { githubAPIBase = old })
}

// setAppJWTForTest configures (or clears) App JWT credentials for a case.
func setAppJWTForTest(t *testing.T, configured bool) {
	t.Helper()
	if configured {
		pemBytes, _ := generateTestRSAKeyPEM(t)
		t.Setenv("GITHUB_APP_ID", "424242")
		t.Setenv("GITHUB_APP_PRIVATE_KEY", string(pemBytes))
		return
	}
	t.Setenv("GITHUB_APP_ID", "")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", "")
}

func callSetupCallback(t *testing.T, state string, installationID int64) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/github/setup?installation_id=%d&state=%s", installationID, url.QueryEscape(state)), nil)
	rec := httptest.NewRecorder()
	testHandler.GitHubSetupCallback(rec, req)
	return rec
}

func countBindings(t *testing.T, installationID int64) int {
	t.Helper()
	var n int
	dbfx.QueryRow(t,
		`SELECT COUNT(*) FROM github_installation WHERE installation_id = $1`,
		installationID,
	).Scan(&n)
	return n
}

func countWorkspaceBindings(t *testing.T, workspaceID string, installationID int64) int {
	t.Helper()
	var n int
	dbfx.QueryRow(t,
		`SELECT COUNT(*) FROM github_installation WHERE workspace_id = $1 AND installation_id = $2`,
		workspaceID, installationID,
	).Scan(&n)
	return n
}

// TestSetupCallback_RefusesUnrelatedAdminBinding is the core OL-955
// regression: the attacker is owner of their own workspace (state is signed
// for it by the admin-gated Connect flow), the installation is already bound
// to the victim workspace, and the attacker holds no membership there. The
// callback must refuse and must not write a second binding row.
func TestSetupCallback_RefusesUnrelatedAdminBinding(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	installationID := setupGuardFixture(t, ctx) + 1
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
	})
	setAppJWTForTest(t, true)
	stubGitHubInstallation(t, installationID, http.StatusOK, `{}`)

	victimWS := dbfx.Workspace(t, "Setup guard victim", "setup-guard-victim", testutil.Cols{"issue_prefix": "SGV"})
	attackerWS := dbfx.Workspace(t, "Setup guard attacker", "setup-guard-attacker", testutil.Cols{"issue_prefix": "SGA"})
	attackerUser := dbfx.User(t, "Setup Guard Attacker", "setup-guard-attacker@multica.ai")
	dbfx.Member(t, attackerWS, attackerUser, "owner")
	dbfx.Insert(t, "github_installation", testutil.Cols{
		"workspace_id":    victimWS,
		"installation_id": installationID,
		"account_login":   "victim-org",
		"account_type":    "Organization",
	})

	// Attacker mints a state for THEIR workspace, naming THEMSELVES as the
	// operator (exactly what the admin-gated Connect endpoint would sign).
	state, err := signGitHubSetupState(attackerWS, githubReturnToGitHub, attackerUser)
	if err != nil {
		t.Fatalf("signGitHubSetupState: %v", err)
	}

	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_error=not_authorized") {
		t.Fatalf("redirect = %q, want github_error=not_authorized", loc)
	}
	if n := countBindings(t, installationID); n != 1 {
		t.Fatalf("binding count = %d, want 1 (attacker must not gain a binding)", n)
	}
}

// TestSetupCallback_RefusesHeaderForgedIdentity pins that the operator
// identity cannot be supplied via headers on the public callback route: a
// forged X-User-ID naming a victim admin grants nothing.
func TestSetupCallback_RefusesHeaderForgedIdentity(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	installationID := setupGuardFixture(t, ctx) + 2
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
	})
	setAppJWTForTest(t, true)
	stubGitHubInstallation(t, installationID, http.StatusOK, `{}`)

	victimWS := dbfx.Workspace(t, "Header forge victim", "setup-guard-forged", testutil.Cols{"issue_prefix": "SGF"})
	victimAdmin := dbfx.User(t, "Header Forge Admin", "setup-guard-forged-admin@multica.ai")
	dbfx.Member(t, victimWS, victimAdmin, "owner")
	dbfx.Insert(t, "github_installation", testutil.Cols{
		"workspace_id":    victimWS,
		"installation_id": installationID,
		"account_login":   "forged-org",
		"account_type":    "Organization",
	})

	attackerWS := dbfx.Workspace(t, "Header forge attacker", "setup-guard-forged-attacker", testutil.Cols{"issue_prefix": "SGX"})
	// No operator in the state (legacy 3-part shape), plus a forged header
	// claiming to BE the victim admin.
	state, err := signState(attackerWS)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/github/setup?installation_id=%d&state=%s", installationID, url.QueryEscape(state)), nil)
	req.Header.Set("X-User-ID", victimAdmin)
	rec := httptest.NewRecorder()
	testHandler.GitHubSetupCallback(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_error=not_authorized") {
		t.Fatalf("redirect = %q, want github_error=not_authorized (header identity must be ignored)", loc)
	}
	if n := countBindings(t, installationID); n != 1 {
		t.Fatalf("binding count = %d, want 1", n)
	}
}

// TestSetupCallback_ManagerAllowlistMatrix covers the full allowlist —
// owner OR admin of ANY bound workspace (not just the oldest binding).
// Kills the "owner-only" and "first-binding-only" mutations.
func TestSetupCallback_ManagerAllowlistMatrix(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	cases := []struct {
		name       string
		firstRole  string // operator's role in the oldest bound workspace ("" = none)
		secondRole string // operator's role in a newer bound workspace ("" = not bound)
		wantOK     bool
	}{
		{name: "owner of the bound workspace", firstRole: "owner", wantOK: true},
		{name: "admin of the bound workspace", firstRole: "admin", wantOK: true},
		{name: "manages only the newer binding", firstRole: "", secondRole: "admin", wantOK: true},
		{name: "plain member everywhere", firstRole: "member", secondRole: "member", wantOK: false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			installationID := setupGuardFixture(t, ctx) + int64(10+i)
			t.Cleanup(func() {
				testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
			})
			setAppJWTForTest(t, true)
			stubGitHubInstallation(t, installationID, http.StatusOK, `{}`)

			suffix := fmt.Sprintf("matrix-%d", i)
			operator := dbfx.User(t, "Matrix operator "+suffix, "setup-guard-"+suffix+"@multica.ai")
			firstWS := dbfx.Workspace(t, "Matrix first "+suffix, "setup-guard-first-"+suffix, testutil.Cols{"issue_prefix": fmt.Sprintf("MF%d", i)})
			if tc.firstRole != "" {
				dbfx.Member(t, firstWS, operator, tc.firstRole)
			}
			dbfx.Insert(t, "github_installation", testutil.Cols{
				"workspace_id": firstWS, "installation_id": installationID,
				"account_login": "matrix-org", "account_type": "Organization",
			})
			if tc.secondRole != "" {
				secondWS := dbfx.Workspace(t, "Matrix second "+suffix, "setup-guard-second-"+suffix, testutil.Cols{"issue_prefix": fmt.Sprintf("MS%d", i)})
				dbfx.Member(t, secondWS, operator, tc.secondRole)
				// created_at bumped so it sorts after firstWS's row.
				testPool.Exec(ctx, `INSERT INTO github_installation (workspace_id, installation_id, account_login, account_type, created_at)
					VALUES ($1, $2, 'matrix-org', 'Organization', now() + interval '1 second')`, secondWS, installationID)
			}
			targetWS := dbfx.Workspace(t, "Matrix target "+suffix, "setup-guard-target-"+suffix, testutil.Cols{"issue_prefix": fmt.Sprintf("MT%d", i)})
			dbfx.Member(t, targetWS, operator, "owner")

			state, err := signGitHubSetupState(targetWS, githubReturnToGitHub, operator)
			if err != nil {
				t.Fatalf("signGitHubSetupState: %v", err)
			}
			loc := callSetupCallback(t, state, installationID).Header().Get("Location")
			got := countWorkspaceBindings(t, targetWS, installationID)
			if tc.wantOK && (!strings.Contains(loc, "github_connected=1") || got != 1) {
				t.Fatalf("redirect=%q target bindings=%d, want connected and 1", loc, got)
			}
			if !tc.wantOK && (!strings.Contains(loc, "github_error=not_authorized") || got != 0) {
				t.Fatalf("redirect=%q target bindings=%d, want not_authorized and 0", loc, got)
			}
		})
	}
}

// TestSetupCallback_FirstInstallVerifiedByAppJWT is the option-1 contract:
// with App JWT configured, a first install of an ACTIVE installation binds
// (with the GitHub-verified account metadata), a SUSPENDED one is refused.
func TestSetupCallback_FirstInstallVerifiedByAppJWT(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	cases := []struct {
		name        string
		suspendedAt string
		want        string
		wantRows    int
	}{
		{name: "active installation", suspendedAt: "null", want: "github_connected=1", wantRows: 1},
		{name: "suspended installation", suspendedAt: `"2026-10-01T00:00:00Z"`, want: "github_error=installation_suspended", wantRows: 0},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			installationID := setupGuardFixture(t, ctx) + int64(20+i)
			t.Cleanup(func() {
				testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
			})
			setAppJWTForTest(t, true)
			stubGitHubInstallation(t, installationID, http.StatusOK, fmt.Sprintf(
				`{"id":%d,"account":{"login":"fresh-org","type":"Organization"},"suspended_at":%s}`,
				installationID, tc.suspendedAt))

			ws := dbfx.Workspace(t, "Verified first install "+tc.name, fmt.Sprintf("setup-guard-verified-%d", i),
				testutil.Cols{"issue_prefix": fmt.Sprintf("SV%d", i)})
			state, err := signState(ws)
			if err != nil {
				t.Fatalf("signState: %v", err)
			}
			loc := callSetupCallback(t, state, installationID).Header().Get("Location")
			if got := countWorkspaceBindings(t, ws, installationID); !strings.Contains(loc, tc.want) || got != tc.wantRows {
				t.Fatalf("redirect=%q bindings=%d, want %s and %d", loc, got, tc.want, tc.wantRows)
			}
			// The row written on success carries the verified account data,
			// not the "unknown" placeholder.
			if tc.wantRows == 1 {
				var login string
				dbfx.QueryRow(t,
					`SELECT account_login FROM github_installation WHERE installation_id = $1`, installationID,
				).Scan(&login)
				if login != "fresh-org" {
					t.Fatalf("account_login = %q, want fresh-org (verified metadata must be persisted)", login)
				}
			}
		})
	}
}

// TestSetupCallback_FirstInstallRefusesUnverifiedIDs pins the option-1
// fail-closed rule: anything the App cannot verify is refused with a
// retryable error — unconfigured credentials, GitHub 404, rate limiting,
// 5xx, malformed payload. No row is written.
func TestSetupCallback_FirstInstallRefusesUnverifiedIDs(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	cases := []struct {
		name        string
		appJWT      bool
		githubCode  int
		githubBody  string
		wantErrCode string
	}{
		{name: "app auth not configured", appJWT: false, githubCode: http.StatusOK, githubBody: `{}`, wantErrCode: "verification_unavailable"},
		{name: "github confirms 404", appJWT: true, githubCode: http.StatusNotFound, githubBody: `{"message":"Not Found"}`, wantErrCode: "unknown_installation"},
		{name: "github rate limited (403)", appJWT: true, githubCode: http.StatusForbidden, githubBody: `{"message":"rate limit"}`, wantErrCode: "verification_unavailable"},
		{name: "github 5xx", appJWT: true, githubCode: http.StatusBadGateway, githubBody: `{}`, wantErrCode: "verification_unavailable"},
		{name: "malformed payload", appJWT: true, githubCode: http.StatusOK, githubBody: `not-json`, wantErrCode: "verification_unavailable"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			installationID := setupGuardFixture(t, ctx) + int64(30+i)
			t.Cleanup(func() {
				testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
			})
			setAppJWTForTest(t, tc.appJWT)
			stubGitHubInstallation(t, installationID, tc.githubCode, tc.githubBody)

			ws := dbfx.Workspace(t, "Unverified "+tc.name, fmt.Sprintf("setup-guard-unverified-%d", i),
				testutil.Cols{"issue_prefix": fmt.Sprintf("SU%d", i)})
			state, err := signState(ws)
			if err != nil {
				t.Fatalf("signState: %v", err)
			}
			loc := callSetupCallback(t, state, installationID).Header().Get("Location")
			if !strings.Contains(loc, "github_error="+tc.wantErrCode) {
				t.Fatalf("redirect = %q, want github_error=%s", loc, tc.wantErrCode)
			}
			if n := countBindings(t, installationID); n != 0 {
				t.Fatalf("binding count = %d, want 0 (unverified id must never persist)", n)
			}
		})
	}
}

// TestSetupCallback_AllowsManagerRebind covers the legitimate rebinding path:
// the operator named in the signed state manages a bound workspace, so
// binding it to one more workspace is allowed (#4855 multi-workspace). The
// audit column connected_by_id records the signed operator, not headers.
func TestSetupCallback_AllowsManagerRebind(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	installationID := setupGuardFixture(t, ctx) + 40
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
	})
	setAppJWTForTest(t, true)
	stubGitHubInstallation(t, installationID, http.StatusOK, `{}`)

	homeWS := dbfx.Workspace(t, "Manager home", "setup-guard-home", testutil.Cols{"issue_prefix": "SGH"})
	secondWS := dbfx.Workspace(t, "Manager second", "setup-guard-second-rebind", testutil.Cols{"issue_prefix": "SGR"})
	manager := dbfx.User(t, "Setup Guard Manager", "setup-guard-manager@multica.ai")
	dbfx.Member(t, homeWS, manager, "owner")
	dbfx.Insert(t, "github_installation", testutil.Cols{
		"workspace_id":    homeWS,
		"installation_id": installationID,
		"account_login":   "manager-org",
		"account_type":    "Organization",
	})

	state, err := signGitHubSetupState(secondWS, githubReturnToGitHub, manager)
	if err != nil {
		t.Fatalf("signGitHubSetupState: %v", err)
	}
	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_connected=1") {
		t.Fatalf("redirect = %q, want github_connected=1", loc)
	}
	if n := countBindings(t, installationID); n != 2 {
		t.Fatalf("binding count = %d, want 2 (manager rebind must succeed)", n)
	}
	var connectedBy *string
	dbfx.QueryRow(t,
		`SELECT connected_by_id::text FROM github_installation WHERE installation_id = $1 AND workspace_id = $2`,
		installationID, secondWS,
	).Scan(&connectedBy)
	if connectedBy == nil || *connectedBy != manager {
		t.Fatalf("connected_by_id = %v, want the signed operator %s", connectedBy, manager)
	}
}

// TestSetupCallback_MemberCannotRebind pins that plain membership (not
// owner/admin) of a bound workspace is not enough to rebind — matching the
// OL-928 option A allowlist exactly.
func TestSetupCallback_MemberCannotRebind(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	installationID := setupGuardFixture(t, ctx) + 41
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
	})
	setAppJWTForTest(t, true)
	stubGitHubInstallation(t, installationID, http.StatusOK, `{}`)

	homeWS := dbfx.Workspace(t, "Member home", "setup-guard-member-home", testutil.Cols{"issue_prefix": "SGM"})
	otherWS := dbfx.Workspace(t, "Member other", "setup-guard-member-other", testutil.Cols{"issue_prefix": "SGO"})
	plainMember := dbfx.User(t, "Setup Guard Member", "setup-guard-member@multica.ai")
	dbfx.Member(t, homeWS, plainMember, "member")
	dbfx.Insert(t, "github_installation", testutil.Cols{
		"workspace_id":    homeWS,
		"installation_id": installationID,
		"account_login":   "member-org",
		"account_type":    "Organization",
	})

	state, err := signGitHubSetupState(otherWS, githubReturnToGitHub, plainMember)
	if err != nil {
		t.Fatalf("signGitHubSetupState: %v", err)
	}
	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_error=not_authorized") {
		t.Fatalf("redirect = %q, want github_error=not_authorized (plain member cannot rebind)", loc)
	}
	if n := countBindings(t, installationID); n != 1 {
		t.Fatalf("binding count = %d, want 1", n)
	}
}

// TestSetupCallback_StateRoundTrip pins the fork's 5-part state format:
// the operator travels inside the token, survives verification, tampering
// any segment breaks it, and legacy 3/4-part tokens still verify with an
// empty operator.
func TestSetupCallback_StateRoundTrip(t *testing.T) {
	t.Setenv("GITHUB_WEBHOOK_SECRET", "state-roundtrip-secret")
	wsID := "11111111-2222-3333-4444-555555555555"
	operator := "99999999-8888-7777-6666-555555555554"

	tok, err := signGitHubSetupState(wsID, githubReturnToGitHub, operator)
	if err != nil {
		t.Fatalf("signGitHubSetupState: %v", err)
	}
	if parts := strings.Split(tok, "."); len(parts) != 5 {
		t.Fatalf("operator state has %d parts, want 5", len(parts))
	}
	gotWS, gotReturn, gotOperator, ok := verifyGitHubSetupState(tok)
	if !ok || gotWS != wsID || gotOperator.String() != operator || gotReturn != githubReturnToGitHub {
		t.Fatalf("round trip = (%q, %q, %v, %v), want (%q, %q, %s, true)",
			gotWS, gotReturn, gotOperator, ok, wsID, githubReturnToGitHub, operator)
	}

	// Swapping any segment breaks the signature.
	tampered := strings.Replace(tok, operator, "12345678-1234-1234-1234-123456789012", 1)
	if _, _, _, ok := verifyGitHubSetupState(tampered); ok {
		t.Error("tampered operator must fail verification")
	}
	tampered = strings.Replace(tok, "."+githubReturnToGitHub+".", ".repositories.", 1)
	if _, _, _, ok := verifyGitHubSetupState(tampered); ok {
		t.Error("tampered return target must fail verification")
	}

	// Legacy 3-part and 4-part shapes still verify (empty operator).
	legacy3, err := signState(wsID)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}
	if _, _, gotOperator, ok := verifyGitHubSetupState(legacy3); !ok || gotOperator.Valid {
		t.Fatalf("legacy 3-part state: ok=%v operator=%v, want ok=true operator invalid", ok, gotOperator)
	}
	legacy4, err := signStateForReturn(wsID, githubReturnToRepositories)
	if err != nil {
		t.Fatalf("signStateForReturn: %v", err)
	}
	if _, gotReturn, gotOperator, ok := verifyGitHubSetupState(legacy4); !ok || gotReturn != githubReturnToRepositories || gotOperator.Valid {
		t.Fatalf("legacy 4-part state: ok=%v return=%q operator=%v", ok, gotReturn, gotOperator)
	}

	// A non-UUID operator is refused at signing time.
	if _, err := signGitHubSetupState(wsID, githubReturnToGitHub, "not-a-uuid"); err == nil {
		t.Error("non-UUID operator must fail signing")
	}
}

// TestSetupCallback_ConnectStateCarriesOperator proves the admin-gated
// Connect endpoint embeds the authenticated caller into the state it signs.
func TestSetupCallback_ConnectStateCarriesOperator(t *testing.T) {
	t.Setenv("GITHUB_APP_SLUG", "multica-test")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "test-secret-123")
	wsID := "11111111-2222-3333-4444-555555555555"

	req := httptest.NewRequest(http.MethodGet, "/api/workspaces/"+wsID+"/github/connect", nil)
	req = withURLParam(req, "id", wsID)
	req.Header.Set("X-User-ID", testUserID)
	rec := httptest.NewRecorder()
	(&Handler{}).GitHubConnect(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GitHubConnect: %d (%s)", rec.Code, rec.Body.String())
	}
	var body GitHubConnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode connect response: %v", err)
	}
	u, err := url.Parse(body.URL)
	if err != nil {
		t.Fatalf("parse install URL: %v", err)
	}
	_, _, operator, ok := verifyGitHubSetupState(u.Query().Get("state"))
	if !ok || !operator.Valid || operator.String() != testUserID {
		t.Fatalf("connect state operator = (%v, %v), want (%q, true)", operator, ok, testUserID)
	}
}
