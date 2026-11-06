package main

import (
	"context"
	"net/http"
	"testing"
)

// TestQuotaSourceRoutesRejectTaskToken exercises the real Auth -> router ->
// handler chain for the quota-source management routes (OL-1205 review #5①):
// an agent's mat_ task token authenticates as the runtime owner and must not
// read or mutate the owner's subscription credentials. The client also
// forges X-Actor-Source to prove Auth's server-set stamp wins.
func TestQuotaSourceRoutesRejectTaskToken(t *testing.T) {
	if testPool == nil {
		t.Skip("no database connection")
	}
	ctx := context.Background()

	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id::text FROM agent WHERE workspace_id = $1 ORDER BY created_at LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load integration-test agent: %v", err)
	}
	taskID := ensureAgentTask(t, agentID)
	matToken := mintAgentTaskToken(t, agentID, taskID, testUserID)

	// A real source owned by the test user, so list/patch/delete/refresh
	// have a genuine target and the test proves they survive rejected
	// requests untouched.
	var sourceID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO quota_source (owner_id, kind, name, credential_ciphertext, credential_hint)
		VALUES ($1, 'glm', 'route-guard-target', '\x00'::bytea, '') RETURNING id::text
	`, testUserID).Scan(&sourceID); err != nil {
		t.Fatalf("insert quota source: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM quota_source WHERE id = $1`, sourceID)
	})

	do := func(t *testing.T, method, path string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, testServer.URL+path, nil)
		if err != nil {
			t.Fatalf("create request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+matToken)
		req.Header.Set("X-Actor-Source", "member") // forged: Auth's stamp must win
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("perform request: %v", err)
		}
		return resp
	}

	for _, tc := range []struct {
		name   string
		method string
		path   string
	}{
		{name: "list", method: http.MethodGet, path: "/api/me/quota-sources/"},
		{name: "create", method: http.MethodPost, path: "/api/me/quota-sources/"},
		{name: "patch", method: http.MethodPatch, path: "/api/me/quota-sources/" + sourceID + "/"},
		{name: "delete", method: http.MethodDelete, path: "/api/me/quota-sources/" + sourceID + "/"},
		{name: "refresh", method: http.MethodPost, path: "/api/me/quota-sources/" + sourceID + "/refresh"},
	} {
		t.Run("mat_ "+tc.name, func(t *testing.T) {
			resp := do(t, tc.method, tc.path)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("%s %s with task token: status = %d, want 403", tc.method, tc.path, resp.StatusCode)
			}
		})
	}

	// The rejected delete must have left the row in place.
	var n int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM quota_source WHERE id = $1`, sourceID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("rejected delete removed the quota source")
	}
}
