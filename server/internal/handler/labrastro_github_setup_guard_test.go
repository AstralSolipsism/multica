package handler

// Adversarial regression tests for the OL-955 setup-callback binding gate:
// an admin of an UNRELATED workspace who knows a numeric installation_id
// must not be able to bind someone else's GitHub organization to their
// workspace through /api/github/setup, while legitimate first installs and
// manager rebinds keep working.

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

// setupGuardFixture builds two workspaces: victim (where the installation is
// already bound) and attacker (whose admin mints the state that used to be
// enough to steal the binding). Returns the installation_id used.
func setupGuardFixture(t *testing.T, ctx context.Context) (installationID int64) {
	t.Helper()
	t.Setenv("GITHUB_WEBHOOK_SECRET", "setup-guard-secret")
	t.Setenv("GITHUB_APP_ID", "")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", "")
	t.Setenv("FRONTEND_ORIGIN", "https://app.example.test")

	installationID = int64(90955 + len("OL955"))
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
	})
	return installationID
}

func callSetupCallback(t *testing.T, state string, installationID int64) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/github/setup?installation_id=%d&state=%s", installationID, url.QueryEscape(state)), nil)
	rec := httptest.NewRecorder()
	testHandler.GitHubSetupCallback(rec, req)
	return rec
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
	installationID := setupGuardFixture(t, ctx)

	victimWS := dbfx.Workspace(t, "Setup guard victim", "setup-guard-victim", testutil.Cols{"issue_prefix": "SGV"})
	attackerWS := dbfx.Workspace(t, "Setup guard attacker", "setup-guard-attacker", testutil.Cols{"issue_prefix": "SGA"})
	attackerUser := dbfx.User(t, "Setup Guard Attacker", "setup-guard-attacker@multica.ai")
	dbfx.Member(t, attackerWS, attackerUser, "owner")

	// Victim's existing binding — the row the attacker tries to shadow.
	dbfx.Insert(t, "github_installation", testutil.Cols{
		"workspace_id":    victimWS,
		"installation_id": installationID,
		"account_login":   "victim-org",
		"account_type":    "Organization",
	})

	// Attacker mints a state for THEIR workspace, naming THEMSELVES as the
	// operator (exactly what the admin-gated Connect endpoint would sign).
	state, err := signStateForReturn(attackerWS, githubReturnToGitHub, attackerUser)
	if err != nil {
		t.Fatalf("signStateForReturn: %v", err)
	}

	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_error=not_authorized") {
		t.Fatalf("redirect = %q, want github_error=not_authorized", loc)
	}

	var count int
	dbfx.QueryRow(t,
		`SELECT COUNT(*) FROM github_installation WHERE installation_id = $1`,
		installationID,
	).Scan(&count)
	if count != 1 {
		t.Fatalf("binding count = %d, want 1 (attacker must not gain a binding)", count)
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
	installationID := setupGuardFixture(t, ctx)

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
}

// TestSetupCallback_AllowsManagerRebind covers the legitimate rebinding
// path: the operator named in the signed state is owner of a workspace the
// installation is already bound to, so binding it to one more workspace is
// allowed (#4855 multi-workspace installs keep working).
func TestSetupCallback_AllowsManagerRebind(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	installationID := setupGuardFixture(t, ctx)

	homeWS := dbfx.Workspace(t, "Manager home", "setup-guard-home", testutil.Cols{"issue_prefix": "SGH"})
	secondWS := dbfx.Workspace(t, "Manager second", "setup-guard-second", testutil.Cols{"issue_prefix": "SGS"})
	manager := dbfx.User(t, "Setup Guard Manager", "setup-guard-manager@multica.ai")
	dbfx.Member(t, homeWS, manager, "owner")
	dbfx.Member(t, secondWS, manager, "admin")
	dbfx.Insert(t, "github_installation", testutil.Cols{
		"workspace_id":    homeWS,
		"installation_id": installationID,
		"account_login":   "manager-org",
		"account_type":    "Organization",
	})

	state, err := signStateForReturn(secondWS, githubReturnToGitHub, manager)
	if err != nil {
		t.Fatalf("signStateForReturn: %v", err)
	}
	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_connected=1") {
		t.Fatalf("redirect = %q, want github_connected=1", loc)
	}

	var count int
	dbfx.QueryRow(t,
		`SELECT COUNT(*) FROM github_installation WHERE installation_id = $1`,
		installationID,
	).Scan(&count)
	if count != 2 {
		t.Fatalf("binding count = %d, want 2 (manager rebind must succeed)", count)
	}
}

// TestSetupCallback_FirstInstallStillWorks is the compat requirement from
// the issue: a workspace with no prior bindings (true first install) must
// not be blocked by the gate. Anonymous state (no operator) is fine there.
func TestSetupCallback_FirstInstallStillWorks(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	installationID := setupGuardFixture(t, ctx)

	freshWS := dbfx.Workspace(t, "First install ws", "setup-guard-fresh", testutil.Cols{"issue_prefix": "SGN"})

	state, err := signState(freshWS)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}
	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_connected=1") {
		t.Fatalf("redirect = %q, want github_connected=1 (first install must pass)", loc)
	}

	var count int
	dbfx.QueryRow(t,
		`SELECT COUNT(*) FROM github_installation WHERE installation_id = $1`,
		installationID,
	).Scan(&count)
	if count != 1 {
		t.Fatalf("binding count = %d, want 1 (first install must persist)", count)
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
	installationID := setupGuardFixture(t, ctx)

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

	state, err := signStateForReturn(otherWS, githubReturnToGitHub, plainMember)
	if err != nil {
		t.Fatalf("signStateForReturn: %v", err)
	}
	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_error=not_authorized") {
		t.Fatalf("redirect = %q, want github_error=not_authorized (plain member cannot rebind)", loc)
	}
}

// TestSetupCallback_RefusesForeignInstallationWhenAppAuthConfigured covers
// the probe hardening on first installs: with App JWT credentials
// configured, a guessed numeric installation_id that GitHub confirms as
// absent (404) or suspended must be refused instead of persisted.
func TestSetupCallback_RefusesForeignInstallationWhenAppAuthConfigured(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	installationID := setupGuardFixture(t, ctx)

	pemBytes, _ := generateTestRSAKeyPEM(t)
	t.Setenv("GITHUB_APP_ID", "424242")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", string(pemBytes))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, fmt.Sprintf("/app/installations/%d", installationID)) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "unexpected path "+r.URL.Path, http.StatusTeapot)
	}))
	t.Cleanup(srv.Close)
	oldBase := githubAPIBase
	githubAPIBase = srv.URL
	t.Cleanup(func() { githubAPIBase = oldBase })

	freshWS := dbfx.Workspace(t, "Probe ws", "setup-guard-probe", testutil.Cols{"issue_prefix": "SGP"})
	state, err := signState(freshWS)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}

	rec := callSetupCallback(t, state, installationID)
	if rec.Code != http.StatusFound {
		t.Fatalf("setup callback: expected 302, got %d (%s)", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github_error=unknown_installation") {
		t.Fatalf("redirect = %q, want github_error=unknown_installation", loc)
	}

	var count int
	dbfx.QueryRow(t,
		`SELECT COUNT(*) FROM github_installation WHERE installation_id = $1`,
		installationID,
	).Scan(&count)
	if count != 0 {
		t.Fatalf("binding count = %d, want 0 (confirmed-foreign installation must not persist)", count)
	}
}

// TestSetupCallback_StateRoundTrip pins the signed-state format extension:
// the operator travels inside the token, survives verification, and a
// tampered operator segment is rejected.
func TestSetupCallback_StateRoundTrip(t *testing.T) {
	t.Setenv("GITHUB_WEBHOOK_SECRET", "state-roundtrip-secret")
	wsID := "11111111-2222-3333-4444-555555555555"
	operator := "99999999-8888-7777-6666-555555555554"

	tok, err := signStateForReturn(wsID, githubReturnToGitHub, operator)
	if err != nil {
		t.Fatalf("signStateForReturn: %v", err)
	}
	if parts := strings.Split(tok, "."); len(parts) != 5 {
		t.Fatalf("operator state has %d parts, want 5", len(parts))
	}
	gotWS, gotReturn, gotOperator, ok := verifyStateWithReturn(tok)
	if !ok || gotWS != wsID || gotOperator != operator || gotReturn != githubReturnToGitHub {
		t.Fatalf("round trip = (%q, %q, %q, %v), want (%q, %q, %q, true)",
			gotWS, gotReturn, gotOperator, ok, wsID, githubReturnToGitHub, operator)
	}

	// Swapping the operator segment breaks the signature.
	tampered := strings.Replace(tok, operator, "12345678-1234-1234-1234-123456789012", 1)
	if _, _, _, ok := verifyStateWithReturn(tampered); ok {
		t.Error("tampered operator must fail verification")
	}

	// Legacy 3-part and 4-part shapes still verify.
	legacy3, err := signState(wsID)
	if err != nil {
		t.Fatalf("signState: %v", err)
	}
	if _, _, gotOperator, ok := verifyStateWithReturn(legacy3); !ok || gotOperator != "" {
		t.Fatalf("legacy 3-part state: ok=%v operator=%q, want ok=true operator empty", ok, gotOperator)
	}
	legacy4, err := signStateForReturn(wsID, githubReturnToRepositories, "")
	if err != nil {
		t.Fatalf("signStateForReturn: %v", err)
	}
	if _, gotReturn, gotOperator, ok := verifyStateWithReturn(legacy4); !ok || gotReturn != githubReturnToRepositories || gotOperator != "" {
		t.Fatalf("legacy 4-part state: ok=%v return=%q operator=%q", ok, gotReturn, gotOperator)
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
	_, _, operator, ok := verifyStateWithReturn(mustExtractState(t, body.URL))
	if !ok || operator != testUserID {
		t.Fatalf("connect state operator = (%q, %v), want (%q, true)", operator, ok, testUserID)
	}
}

func mustExtractState(t *testing.T, installURL string) string {
	t.Helper()
	u, err := url.Parse(installURL)
	if err != nil {
		t.Fatalf("parse install URL: %v", err)
	}
	return u.Query().Get("state")
}
