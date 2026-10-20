package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ghAppMockEnv configures App JWT credentials for App-authenticated GitHub
// calls and points the API base at an httptest server.
func ghAppMockEnv(t *testing.T, fn http.HandlerFunc) {
	t.Helper()
	pemBytes, _ := generateTestRSAKeyPEM(t)
	t.Setenv("GITHUB_APP_ID", "424242")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", string(pemBytes))
	srv := httptest.NewServer(fn)
	t.Cleanup(srv.Close)
	oldBase := githubAPIBase
	githubAPIBase = srv.URL
	t.Cleanup(func() { githubAPIBase = oldBase })
}

// appInstallationHandler serves GET /app/installations/{id} lookups from the
// given (id → login) inventory. The app-wide GET /app/installations list must
// never be requested — the endpoint walks the managed set instead (OL-957) —
// so a hit on the list route fails the test; that is also the regression
// guard for managed installations sitting beyond the list's first page.
func appInstallationHandler(t *testing.T, inventory map[int64]string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations" {
			t.Errorf("app-wide /app/installations list must not be called (OL-957)")
			http.NotFound(w, r)
			return
		}
		id, err := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/app/installations/"), 10, 64)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		login, ok := inventory[id]
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"account": map[string]any{"login": login, "type": "Organization"},
		})
	}
}

// bindingsIn counts rows for one installation in one workspace — the
// assertion target for every "must not persist" check: a row leaked into the
// target workspace is visible no matter what other workspaces hold.
func bindingsIn(ctx context.Context, wsID string, installationID int64) int {
	var n int
	testPool.QueryRow(ctx,
		`SELECT count(*) FROM github_installation WHERE workspace_id = $1 AND installation_id = $2`,
		wsID, installationID,
	).Scan(&n)
	return n
}

func TestListGitHubAppInstallations_UnconfiguredDegrades(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	t.Setenv("GITHUB_APP_ID", "")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", "")

	req := withURLParam(httptest.NewRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/github/app-installations", nil), "id", testWorkspaceID)
	req.Header.Set("X-User-ID", testUserID)
	w := httptest.NewRecorder()
	testHandler.ListGitHubAppInstallations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var body struct {
		Installations []GitHubAppInstallationResponse `json:"installations"`
		Configured    bool                            `json:"configured"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Configured {
		t.Error("configured must be false without App credentials")
	}
	if body.Installations == nil || len(body.Installations) != 0 {
		t.Errorf("installations must be an empty list, got %v", body.Installations)
	}
}

// TestListGitHubAppInstallations_EmptyManagedSetSkipsGitHub pins that a
// caller with no managed installations never reaches GitHub.
func TestListGitHubAppInstallations_EmptyManagedSetSkipsGitHub(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	outsider := createTestUserAndMember(t, "")
	var githubCalled bool
	ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
		githubCalled = true
		w.WriteHeader(http.StatusOK)
	})

	req := withURLParam(httptest.NewRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/github/app-installations", nil), "id", testWorkspaceID)
	req.Header.Set("X-User-ID", outsider)
	w := httptest.NewRecorder()
	testHandler.ListGitHubAppInstallations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var body struct {
		Installations []GitHubAppInstallationResponse `json:"installations"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if len(body.Installations) != 0 {
		t.Errorf("want empty list, got %+v", body.Installations)
	}
	if githubCalled {
		t.Error("GitHub must not be called when the caller manages no installations")
	}
}

func TestListGitHubAppInstallations_OnlyManagedAndConnectedFlags(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const managedID int64 = 111222333
	ghAppMockEnv(t, appInstallationHandler(t, map[int64]string{
		managedID: "AstralSolipsism",
	}))

	if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
		WorkspaceID:    parseUUID(testWorkspaceID),
		InstallationID: managedID,
		AccountLogin:   "AstralSolipsism",
		AccountType:    "User",
	}); err != nil {
		t.Fatalf("seed installation: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, managedID)
	})

	list := func(t *testing.T, wsID string) []GitHubAppInstallationResponse {
		t.Helper()
		req := withURLParam(httptest.NewRequest(http.MethodGet, "/api/workspaces/"+wsID+"/github/app-installations", nil), "id", wsID)
		req.Header.Set("X-User-ID", testUserID)
		w := httptest.NewRecorder()
		testHandler.ListGitHubAppInstallations(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		var body struct {
			Installations []GitHubAppInstallationResponse `json:"installations"`
			Configured    bool                            `json:"configured"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !body.Configured {
			t.Fatal("configured must be true with App credentials set")
		}
		return body.Installations
	}

	// Foreign installations (bound nowhere this caller manages) are absent.
	got := list(t, testWorkspaceID)
	if len(got) != 1 || got[0].InstallationID != managedID || !got[0].Connected || got[0].AccountLogin != "AstralSolipsism" {
		t.Errorf("want exactly the managed installation connected=true, got %+v", got)
	}

	// The same caller from a fresh workspace (no binding yet): the managed
	// installation stays visible but connected=false.
	wsB, err := testHandler.Queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{
		Name: "reuse-list-ws-b", Slug: "reuse-list-ws-b", IssuePrefix: "RLB",
	})
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM workspace WHERE id = $1`, wsB.ID) })
	got = list(t, uuidToString(wsB.ID))
	if len(got) != 1 || got[0].Connected {
		t.Errorf("from unbound workspace want managed installation connected=false, got %+v", got)
	}
}

// TestReuseAllowlistScopedToManagedWorkspaces is the option A regression:
// the reuse allowlist must be scoped to workspaces the caller administers,
// not to "owner/admin anywhere". Every caller owns their own workspace and
// targets it, so a leaked binding shows up as a new row there. Fails if the
// SQL drops the workspace join or the role filter, restricts to owner only,
// or the not-managed 404 stops returning.
func TestReuseAllowlistScopedToManagedWorkspaces(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const victimInst int64 = 70700707
	ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/app/installations":
			t.Errorf("app-wide /app/installations list must not be called (OL-957)")
			http.NotFound(w, r)
		case r.Method == http.MethodGet && r.URL.Path == fmt.Sprintf("/app/installations/%d", victimInst):
			writeJSON(w, 200, map[string]any{"account": map[string]any{"login": "victim-org", "type": "Organization"}})
		default:
			http.NotFound(w, r)
		}
	})
	mkWS := func(slug string) string {
		_, _ = testPool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, slug)
		id := dbfx.Insert(t, "workspace", testutil.Cols{"name": slug, "slug": slug, "description": "x", "issue_prefix": strings.ToUpper(slug[:3])})
		t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, id) })
		return id
	}
	mkUser := func(label string) string {
		var id string
		dbfx.QueryRow(t, `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`, label, "review-"+label+"@example.com").Scan(&id)
		t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, id) })
		return id
	}
	join := func(ws, user, role string) {
		dbfx.Exec(t, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, $3)`, ws, user, role)
	}
	victimWS := mkWS("rvictim")
	victimOwner := mkUser("rvictim-owner")
	join(victimWS, victimOwner, "owner")
	if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
		WorkspaceID: parseUUID(victimWS), InstallationID: victimInst, AccountLogin: "victim-org", AccountType: "Organization",
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM github_installation WHERE installation_id = $1`, victimInst)
	})

	router := chi.NewRouter()
	router.Route("/api/workspaces/{id}", func(r chi.Router) {
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequireWorkspaceRoleFromURL(testHandler.Queries, "id", "owner", "admin"))
			r.Get("/github/app-installations", testHandler.ListGitHubAppInstallations)
			r.Post("/github/installations", testHandler.ConnectGitHubInstallation)
		})
	})
	do := func(user, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("X-User-ID", user)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	listIDs := func(user, ws string) []int64 {
		rec := do(user, http.MethodGet, "/api/workspaces/"+ws+"/github/app-installations", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("list as %s: %d %s", user, rec.Code, rec.Body.String())
		}
		var body struct {
			Installations []GitHubAppInstallationResponse `json:"installations"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		var ids []int64
		for _, i := range body.Installations {
			ids = append(ids, i.InstallationID)
		}
		return ids
	}
	bindBody := fmt.Sprintf(`{"installation_id":%d}`, victimInst)

	cases := []struct {
		name       string
		roleInVict string // "" = not a member of the victim workspace
		wantListed bool
		wantBind   int
	}{
		{"outsider who owns their own workspace", "", false, http.StatusNotFound},
		{"plain member of the binding workspace", "member", false, http.StatusNotFound},
		{"admin (not owner) of the binding workspace", "admin", true, http.StatusCreated},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := mkUser(fmt.Sprintf("rcase%d", i))
			own := mkWS(fmt.Sprintf("rown%d", i))
			join(own, user, "owner")
			if tc.roleInVict != "" {
				join(victimWS, user, tc.roleInVict)
			}
			ids := listIDs(user, own)
			listed := len(ids) == 1 && ids[0] == victimInst
			if listed != tc.wantListed {
				t.Errorf("listed=%v (ids %v), want %v", listed, ids, tc.wantListed)
			}
			rec := do(user, http.MethodPost, "/api/workspaces/"+own+"/github/installations", bindBody)
			if rec.Code != tc.wantBind {
				t.Errorf("bind: %d %s, want %d", rec.Code, rec.Body.String(), tc.wantBind)
			}
			wantRows := 0
			if tc.wantBind == http.StatusCreated {
				wantRows = 1
			}
			if got := bindingsIn(ctx, own, victimInst); got != wantRows {
				t.Errorf("bindings in own workspace = %d, want %d", got, wantRows)
			}
		})
	}
}

// TestConnectGitHubInstallation covers the direct-bind endpoint: allowlist,
// strict verification, persistence, redacted broadcast, and error branches.
// Failure-path cases target wsB — a workspace holding no binding for the
// installation under test — so a mutation that writes before returning still
// shows up as an extra row there.
func TestConnectGitHubInstallation(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const installationID int64 = 60606060
	ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != fmt.Sprintf("/app/installations/%d", installationID) {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") == "" {
			http.Error(w, "auth required", http.StatusUnauthorized)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"account": map[string]any{"login": "reuse-octocat", "type": "Organization", "avatar_url": "https://example.com/r.png"},
		})
	})
	// Option A precondition: the caller already manages the installation
	// somewhere. Seed it in the fixture workspace where testUserID is owner,
	// as an earlier legitimate setup-callback bind would have.
	if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
		WorkspaceID:    parseUUID(testWorkspaceID),
		InstallationID: installationID,
		AccountLogin:   "reuse-octocat",
		AccountType:    "Organization",
	}); err != nil {
		t.Fatalf("seed managed installation: %v", err)
	}
	// wsB is the reuse target; the caller joins as admin so a later subtest
	// can seed a second managed installation there.
	wsB, err := testHandler.Queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{
		Name: "reuse-ws-b", Slug: "reuse-ws-b", IssuePrefix: "RWB",
	})
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if _, err := testPool.Exec(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, wsB.ID, testUserID); err != nil {
		t.Fatalf("join wsB: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, installationID)
		testPool.Exec(ctx, `DELETE FROM workspace WHERE id = $1`, wsB.ID)
	})

	gotEvent := make(chan events.Event, 1)
	testHandler.Bus.Subscribe(protocol.EventGitHubInstallationCreated, func(e events.Event) {
		select {
		case gotEvent <- e:
		default:
		}
	})

	post := func(t *testing.T, wsID, userID, raw string) *httptest.ResponseRecorder {
		t.Helper()
		req := withURLParam(httptest.NewRequest(http.MethodPost, "/api/workspaces/"+wsID+"/github/installations", strings.NewReader(raw)), "id", wsID)
		if userID != "" {
			req.Header.Set("X-User-ID", userID)
		}
		w := httptest.NewRecorder()
		testHandler.ConnectGitHubInstallation(w, req)
		return w
	}
	idJSON := `{"installation_id":` + strconv.FormatInt(installationID, 10) + `}`
	wsBID := uuidToString(wsB.ID)

	t.Run("invalid installation_id is 400", func(t *testing.T) {
		for _, raw := range []string{`{"installation_id":0}`, `{"installation_id":-1}`, `not json`} {
			if w := post(t, testWorkspaceID, testUserID, raw); w.Code != http.StatusBadRequest {
				t.Errorf("body %q: want 400, got %d (%s)", raw, w.Code, w.Body.String())
			}
		}
	})

	t.Run("not configured is feature-disabled 403", func(t *testing.T) {
		t.Setenv("GITHUB_APP_ID", "")
		t.Setenv("GITHUB_APP_PRIVATE_KEY", "")
		w := post(t, testWorkspaceID, testUserID, idJSON)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "github_app_auth_not_configured") {
			t.Errorf("want 403 github_app_auth_not_configured, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("installation the caller does not manage is 404 and never reaches GitHub", func(t *testing.T) {
		// Fresh user with no managed installations anywhere. The mock would
		// answer 422 for this ID, so a 404 proves the allowlist check runs
		// BEFORE any GitHub call — non-managers cannot probe suspension or
		// existence through the error channel.
		outsider := createTestUserAndMember(t, "")
		ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"suspended_at": "2026-01-01T00:00:00Z",
				"account":      map[string]any{"login": "would-be-422", "type": "User"},
			})
		})
		w := post(t, wsBID, outsider, idJSON)
		if w.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
		}
		if n := bindingsIn(ctx, wsBID, installationID); n != 0 {
			t.Errorf("refused bind must not persist, got %d rows in target workspace", n)
		}
	})

	t.Run("happy path persists, broadcasts redacted, records operator", func(t *testing.T) {
		w := post(t, testWorkspaceID, testUserID, idJSON)
		if w.Code != http.StatusCreated {
			t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
		}
		var resp GitHubInstallationResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.AccountLogin != "reuse-octocat" || resp.AccountType != "Organization" || resp.InstallationID == nil || *resp.InstallationID != installationID {
			t.Errorf("response = %+v, want account metadata + installation_id", resp)
		}
		rows, err := testHandler.Queries.ListGitHubInstallationsByInstallationID(ctx, installationID)
		if err != nil || len(rows) != 1 {
			t.Fatalf("want 1 binding row, got %d (err %v)", len(rows), err)
		}
		if !rows[0].ConnectedByID.Valid || uuidToString(rows[0].ConnectedByID) != testUserID {
			t.Errorf("connected_by_id = %+v, want the requesting user", rows[0].ConnectedByID)
		}
		select {
		case ev := <-gotEvent:
			if ev.WorkspaceID != testWorkspaceID {
				t.Errorf("broadcast workspace = %q, want %q", ev.WorkspaceID, testWorkspaceID)
			}
			payload, _ := ev.Payload.(map[string]any)
			inst, ok := payload["installation"].(GitHubInstallationResponse)
			if !ok {
				t.Fatalf("broadcast payload type: %T", payload["installation"])
			}
			if inst.InstallationID != nil {
				t.Errorf("broadcast must redact installation_id, got %v", *inst.InstallationID)
			}
			if inst.AccountLogin != "reuse-octocat" {
				t.Errorf("broadcast account_login = %q, want reuse-octocat", inst.AccountLogin)
			}
		case <-time.After(2 * time.Second):
			t.Error("expected github_installation:created broadcast, got none")
		}

		// Re-binding the same installation to the same workspace is idempotent.
		if w := post(t, testWorkspaceID, testUserID, idJSON); w.Code != http.StatusCreated {
			t.Errorf("idempotent re-bind: want 201, got %d (%s)", w.Code, w.Body.String())
		}
		if rows, _ := testHandler.Queries.ListGitHubInstallationsByInstallationID(ctx, installationID); len(rows) != 1 {
			t.Errorf("idempotent re-bind must keep 1 row, got %d", len(rows))
		}
	})

	t.Run("managed installation re-binds to a second workspace", func(t *testing.T) {
		w := post(t, wsBID, testUserID, idJSON)
		if w.Code != http.StatusCreated {
			t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
		}
		if rows, _ := testHandler.Queries.ListGitHubInstallationsByInstallationID(ctx, installationID); len(rows) != 2 {
			t.Errorf("cross-workspace reuse must yield 2 bindings, got %d", len(rows))
		}
	})

	t.Run("same workspace binds multiple different installations", func(t *testing.T) {
		// otherID is managed via wsB (seeded there), then bound to
		// testWorkspaceID through the endpoint — no direct writes.
		const otherID int64 = 80808080
		ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"account": map[string]any{"login": "second-acct", "type": "User"},
			})
		})
		if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
			WorkspaceID:    wsB.ID,
			InstallationID: otherID,
			AccountLogin:   "second-acct",
			AccountType:    "User",
		}); err != nil {
			t.Fatalf("seed second installation in wsB: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, otherID) })
		w := post(t, testWorkspaceID, testUserID, `{"installation_id":`+strconv.FormatInt(otherID, 10)+`}`)
		if w.Code != http.StatusCreated {
			t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
		}
		rows, err := testHandler.Queries.ListGitHubInstallationsByWorkspace(ctx, parseUUID(testWorkspaceID))
		if err != nil {
			t.Fatalf("ListGitHubInstallationsByWorkspace: %v", err)
		}
		var ids []int64
		for _, row := range rows {
			if row.InstallationID == installationID || row.InstallationID == otherID {
				ids = append(ids, row.InstallationID)
			}
		}
		if len(ids) != 2 {
			t.Errorf("workspace must hold both installations, got %v", ids)
		}
	})

	t.Run("github 404 for a managed installation is 404 and persists nothing", func(t *testing.T) {
		// installationID is in the caller's managed set (seeded above), so
		// this exercises the strict-verify 404 branch. Target wsB, which by
		// now holds one binding from the reuse subtest.
		ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
		before := bindingsIn(ctx, wsBID, installationID)
		w := post(t, wsBID, testUserID, idJSON)
		if w.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
		}
		if after := bindingsIn(ctx, wsBID, installationID); after != before {
			t.Errorf("github 404 must not persist: bindings %d → %d", before, after)
		}
	})

	t.Run("github-side failures are 502 and persist nothing in the target workspace", func(t *testing.T) {
		// badID is managed (seeded in the fixture workspace) so the allowlist
		// passes and each failure is attributed to the GitHub call itself.
		const badID int64 = 404404404
		if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
			WorkspaceID:    parseUUID(testWorkspaceID),
			InstallationID: badID,
			AccountLogin:   "managed-for-fault-test",
			AccountType:    "User",
		}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, badID) })

		expect502AndNoBinding := func(t *testing.T) {
			t.Helper()
			w := post(t, wsBID, testUserID, `{"installation_id":`+strconv.FormatInt(badID, 10)+`}`)
			if w.Code != http.StatusBadGateway {
				t.Fatalf("want 502, got %d (%s)", w.Code, w.Body.String())
			}
			if n := bindingsIn(ctx, wsBID, badID); n != 0 {
				t.Errorf("failed verify must not persist, got %d rows in target workspace", n)
			}
		}
		for _, tc := range []struct {
			name    string
			handler http.HandlerFunc
		}{
			{"github 500", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) }},
			{"github 401", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "bad jwt", http.StatusUnauthorized) }},
			{"empty login", func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{"account": map[string]any{}})
			}},
			{"missing account", func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{})
			}},
			{"broken json", func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`{"account": `))
			}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				ghAppMockEnv(t, tc.handler)
				expect502AndNoBinding(t)
			})
		}
		t.Run("network unreachable", func(t *testing.T) {
			pemBytes, _ := generateTestRSAKeyPEM(t)
			t.Setenv("GITHUB_APP_ID", "424242")
			t.Setenv("GITHUB_APP_PRIVATE_KEY", string(pemBytes))
			old := githubAPIBase
			githubAPIBase = "http://127.0.0.1:1"
			t.Cleanup(func() { githubAPIBase = old })
			expect502AndNoBinding(t)
		})
	})

	t.Run("suspended installation is refused 422", func(t *testing.T) {
		const suspID int64 = 422422422
		if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
			WorkspaceID:    parseUUID(testWorkspaceID),
			InstallationID: suspID,
			AccountLogin:   "suspended-acct",
			AccountType:    "User",
		}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, suspID) })
		ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"suspended_at": "2026-01-01T00:00:00Z",
				"account":      map[string]any{"login": "suspended-acct", "type": "User"},
			})
		})
		w := post(t, wsBID, testUserID, `{"installation_id":`+strconv.FormatInt(suspID, 10)+`}`)
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("want 422, got %d (%s)", w.Code, w.Body.String())
		}
		if n := bindingsIn(ctx, wsBID, suspID); n != 0 {
			t.Errorf("suspended bind must not persist, got %d rows in target workspace", n)
		}
	})
}

// TestListGitHubAppInstallations_GitHubFailures pins the list endpoint's 502
// branches.
func TestListGitHubAppInstallations_GitHubFailures(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const managedID int64 = 13131313
	if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
		WorkspaceID:    parseUUID(testWorkspaceID),
		InstallationID: managedID,
		AccountLogin:   "list-fail-acct",
		AccountType:    "User",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, managedID) })

	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"github 500", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) }},
		{"broken json", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`[`)) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ghAppMockEnv(t, tc.handler)
			req := withURLParam(httptest.NewRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/github/app-installations", nil), "id", testWorkspaceID)
			req.Header.Set("X-User-ID", testUserID)
			w := httptest.NewRecorder()
			testHandler.ListGitHubAppInstallations(w, req)
			if w.Code != http.StatusBadGateway {
				t.Fatalf("want 502, got %d (%s)", w.Code, w.Body.String())
			}
		})
	}
}

// TestListGitHubAppInstallations_PerIDFetch pins the OL-957 behavior: the
// list walks the managed set via GET /app/installations/{id} (never the
// paginated app-wide list), skips stale (404) and suspended bindings, fails
// whole with 502 on any other error, and returns a stable order.
func TestListGitHubAppInstallations_PerIDFetch(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const okA int64 = 51510001 // login "beta"
	const okB int64 = 51510002 // login "ALPHA" — case-insensitive sort puts it first
	const staleID int64 = 51510003
	const suspID int64 = 51510004
	seed := func(id int64, login string) {
		t.Helper()
		if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
			WorkspaceID:    parseUUID(testWorkspaceID),
			InstallationID: id,
			AccountLogin:   login,
			AccountType:    "User",
		}); err != nil {
			t.Fatalf("seed %d: %v", id, err)
		}
		t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, id) })
	}
	list := func(t *testing.T) (int, []GitHubAppInstallationResponse) {
		t.Helper()
		req := withURLParam(httptest.NewRequest(http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/github/app-installations", nil), "id", testWorkspaceID)
		req.Header.Set("X-User-ID", testUserID)
		w := httptest.NewRecorder()
		testHandler.ListGitHubAppInstallations(w, req)
		var body struct {
			Installations []GitHubAppInstallationResponse `json:"installations"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		return w.Code, body.Installations
	}

	t.Run("skips stale and suspended, stable order", func(t *testing.T) {
		seed(okA, "beta")
		seed(okB, "ALPHA")
		seed(staleID, "stale-acct")
		seed(suspID, "suspended-acct")
		ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/app/installations" {
				t.Errorf("app-wide /app/installations list must not be called (OL-957)")
				http.NotFound(w, r)
				return
			}
			switch strings.TrimPrefix(r.URL.Path, "/app/installations/") {
			case strconv.FormatInt(staleID, 10):
				http.NotFound(w, r) // uninstalled on GitHub: stale binding row
			case strconv.FormatInt(suspID, 10):
				writeJSON(w, http.StatusOK, map[string]any{
					"suspended_at": "2026-01-01T00:00:00Z",
					"account":      map[string]any{"login": "suspended-acct", "type": "User"},
				})
			default:
				id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/app/installations/"), 10, 64)
				writeJSON(w, http.StatusOK, map[string]any{
					"account": map[string]any{"login": map[int64]string{okA: "beta", okB: "ALPHA"}[id], "type": "Organization"},
				})
			}
		})
		code, got := list(t)
		if code != http.StatusOK {
			t.Fatalf("want 200, got %d (%+v)", code, got)
		}
		if len(got) != 2 {
			t.Fatalf("want 2 installations (stale + suspended skipped), got %+v", got)
		}
		if got[0].InstallationID != okB || got[1].InstallationID != okA {
			t.Errorf("want case-insensitive login order [ALPHA, beta], got %+v", got)
		}
	})

	t.Run("one github failure fails the whole list with 502, no partials", func(t *testing.T) {
		seed(okA, "beta")
		seed(staleID, "flaky-acct")
		ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, strconv.FormatInt(staleID, 10)) {
				http.Error(w, "boom", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"account": map[string]any{"login": "beta", "type": "Organization"},
			})
		})
		code, got := list(t)
		if code != http.StatusBadGateway {
			t.Fatalf("want 502, got %d (%+v)", code, got)
		}
		if len(got) != 0 {
			t.Errorf("502 must not carry partial results, got %+v", got)
		}
	})
}

// TestGitHubAppInstallRoutes_RoleGating mirrors TestGitHubRoutes_RoleGating
// for the two reuse-flow routes: both must sit behind the owner/admin group.
func TestGitHubAppInstallRoutes_RoleGating(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const slug = "github-app-install-routes"
	// Hermetic: assert the unconfigured degradation without depending on
	// whatever env a developer's shell carries.
	t.Setenv("GITHUB_APP_ID", "")
	t.Setenv("GITHUB_APP_PRIVATE_KEY", "")
	_, _ = testPool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, slug)
	wsID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name":         "GitHub App Install Routes",
		"slug":         slug,
		"description":  "github app install routes",
		"issue_prefix": "GAR",
	})
	mkUser := func(label string) string {
		var id string
		dbfx.QueryRow(t, `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
			"GAR "+label, fmt.Sprintf("gar-%s-%s@multica.ai", slug, label)).Scan(&id)
		return id
	}
	adminUserID := mkUser("admin")
	memberUserID := mkUser("member")
	outsiderUserID := mkUser("outsider")
	dbfx.Exec(t, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, wsID, adminUserID)
	dbfx.Exec(t, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, wsID, memberUserID)
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, wsID)
		for _, uid := range []string{adminUserID, memberUserID, outsiderUserID} {
			_, _ = testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, uid)
		}
	})

	router := chi.NewRouter()
	router.Route("/api/workspaces/{id}", func(r chi.Router) {
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequireWorkspaceRoleFromURL(testHandler.Queries, "id", "owner", "admin"))
			r.Get("/github/app-installations", testHandler.ListGitHubAppInstallations)
			r.Post("/github/installations", testHandler.ConnectGitHubInstallation)
		})
	})
	exercise := func(method, path, userID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(`{"installation_id":1}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User-ID", userID)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	t.Run("GET app-installations is owner/admin only", func(t *testing.T) {
		if rec := exercise(http.MethodGet, "/api/workspaces/"+wsID+"/github/app-installations", adminUserID); rec.Code != http.StatusOK {
			t.Errorf("admin: want 200, got %d (%s)", rec.Code, rec.Body.String())
		}
		if rec := exercise(http.MethodGet, "/api/workspaces/"+wsID+"/github/app-installations", memberUserID); rec.Code != http.StatusForbidden {
			t.Errorf("member: want 403, got %d", rec.Code)
		}
		if rec := exercise(http.MethodGet, "/api/workspaces/"+wsID+"/github/app-installations", outsiderUserID); rec.Code != http.StatusNotFound {
			t.Errorf("outsider: want 404, got %d", rec.Code)
		}
	})

	t.Run("POST installations is owner/admin only", func(t *testing.T) {
		// Member/outsider are rejected by the middleware before the handler;
		// admin reaches the handler, which refuses on the unconfigured
		// deployment with the feature-disabled code (no App credentials in
		// this test's env).
		if rec := exercise(http.MethodPost, "/api/workspaces/"+wsID+"/github/installations", memberUserID); rec.Code != http.StatusForbidden {
			t.Errorf("member: want 403, got %d", rec.Code)
		}
		if rec := exercise(http.MethodPost, "/api/workspaces/"+wsID+"/github/installations", outsiderUserID); rec.Code != http.StatusNotFound {
			t.Errorf("outsider: want 404, got %d", rec.Code)
		}
		rec := exercise(http.MethodPost, "/api/workspaces/"+wsID+"/github/installations", adminUserID)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "github_app_auth_not_configured") {
			t.Errorf("admin: want handler-level feature-disabled 403, got %d (%s)", rec.Code, rec.Body.String())
		}
	})
}
