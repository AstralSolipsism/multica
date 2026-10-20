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

// appInstallationsResponse is a single entry of GET /app/installations.
func appInstallationsResponse(ids ...int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := make([]map[string]any, 0, len(ids))
		for _, id := range ids {
			login := "org-" + strconv.FormatInt(id, 10)
			typ := "Organization"
			if id == 111222333 {
				login, typ = "AstralSolipsism", "User"
			}
			out = append(out, map[string]any{
				"id":      id,
				"account": map[string]any{"login": login, "type": typ},
			})
		}
		writeJSON(w, http.StatusOK, out)
	}
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

func TestListGitHubAppInstallations_OnlyManagedAndConnectedFlags(t *testing.T) {
	if testHandler == nil {
		t.Skip("handler test fixture not initialized (no DB?)")
	}
	ctx := context.Background()
	const managedID int64 = 111222333
	const foreignID int64 = 87654321
	ghAppMockEnv(t, appInstallationsResponse(managedID, foreignID))

	// seed managedID in a workspace where testUserID is owner/admin (the
	// shared handler-test fixture workspace qualifies).
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
	if !body.Configured || len(body.Installations) != 1 {
		t.Fatalf("want exactly the managed installation, got %+v", body)
	}
	got := body.Installations[0]
	if got.InstallationID != managedID || !got.Connected || got.AccountLogin != "AstralSolipsism" {
		t.Errorf("managed installation must be listed connected=true, got %+v", got)
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
	req = withURLParam(httptest.NewRequest(http.MethodGet, "/api/workspaces/"+uuidToString(wsB.ID)+"/github/app-installations", nil), "id", uuidToString(wsB.ID))
	req.Header.Set("X-User-ID", testUserID)
	w = httptest.NewRecorder()
	testHandler.ListGitHubAppInstallations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode wsB: %v", err)
	}
	if len(body.Installations) != 1 || body.Installations[0].Connected {
		t.Errorf("from unbound workspace want managed installation connected=false, got %+v", body.Installations)
	}
}

// TestConnectGitHubInstallation covers the direct-bind endpoint: allowlist,
// strict verification, persistence, redacted broadcast, and error branches.
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
	// wsB is the second workspace the installation gets reused into.
	wsB, err := testHandler.Queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{
		Name: "reuse-ws-b", Slug: "reuse-ws-b", IssuePrefix: "RWB",
	})
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
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

	t.Run("installation the caller does not manage is 404", func(t *testing.T) {
		// Fresh user with no managed installations anywhere.
		outsider := createTestUserAndMember(t, "")
		w := post(t, testWorkspaceID, outsider, idJSON)
		if w.Code != http.StatusNotFound {
			t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
		}
		// The seed binding for the managing user must be the only row.
		if rows, _ := testHandler.Queries.ListGitHubInstallationsByInstallationID(ctx, installationID); len(rows) != 1 {
			t.Errorf("refused bind must not persist, got %d rows", len(rows))
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
		w := post(t, uuidToString(wsB.ID), testUserID, idJSON)
		if w.Code != http.StatusCreated {
			t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
		}
		if rows, _ := testHandler.Queries.ListGitHubInstallationsByInstallationID(ctx, installationID); len(rows) != 2 {
			t.Errorf("cross-workspace reuse must yield 2 bindings, got %d", len(rows))
		}

		// The same workspace can hold a second, different installation.
		const otherID int64 = 80808080
		if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
			WorkspaceID:    parseUUID(testWorkspaceID),
			InstallationID: otherID,
			AccountLogin:   "second-acct",
			AccountType:    "User",
		}); err != nil {
			t.Fatalf("seed second installation: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, otherID) })
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

	t.Run("github-side failures are 502 and persist nothing", func(t *testing.T) {
		const badID int64 = 404404404
		// Seed badID as managed so the allowlist passes and the failure is
		// attributed to the GitHub call itself.
		if _, err := testHandler.Queries.CreateGitHubInstallation(ctx, db.CreateGitHubInstallationParams{
			WorkspaceID:    parseUUID(testWorkspaceID),
			InstallationID: badID,
			AccountLogin:   "managed-for-fault-test",
			AccountType:    "User",
		}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM github_installation WHERE installation_id = $1`, badID) })

		cases := []struct {
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
			{"network unreachable", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				panic("replaced below")
			})},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				if tc.name == "network unreachable" {
					// Point the base at a dead port.
					ghAppMockEnv(t, func(w http.ResponseWriter, r *http.Request) {})
					old := githubAPIBase
					githubAPIBase = "http://127.0.0.1:1"
					t.Cleanup(func() { githubAPIBase = old })
				} else {
					ghAppMockEnv(t, tc.handler)
				}
				// A second workspace so a persisted row would be visible.
				w := post(t, testWorkspaceID, testUserID, `{"installation_id":`+strconv.FormatInt(badID, 10)+`}`)
				if w.Code != http.StatusBadGateway {
					t.Fatalf("want 502, got %d (%s)", w.Code, w.Body.String())
				}
				if rows, _ := testHandler.Queries.ListGitHubInstallationsByInstallationID(ctx, badID); len(rows) != 1 {
					t.Errorf("failed verify must not add bindings, got %d rows", len(rows))
				}
			})
		}
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
		w := post(t, testWorkspaceID, testUserID, `{"installation_id":`+strconv.FormatInt(suspID, 10)+`}`)
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("want 422, got %d (%s)", w.Code, w.Body.String())
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
