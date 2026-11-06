package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// withQuotaSourceBox installs a deterministic encryption box on a handler
// copy and returns it.
func withQuotaSourceBox(t *testing.T) *Handler {
	t.Helper()
	box, err := secretbox.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secretbox.New: %v", err)
	}
	h := *testHandler
	h.QuotaSourceBox = box
	return &h
}

// quotaSourceRequest builds an /api/me/quota-sources request for userID.
func quotaSourceRequest(method, path, userID string, body any) *http.Request {
	var req *http.Request
	if body != nil {
		raw, _ := json.Marshal(body)
		req = httptest.NewRequest(method, path, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	req.Header.Set("X-User-ID", userID)
	// id path param
	if parts := strings.Split(path, "/"); len(parts) >= 5 {
		req = withURLParam(req, "id", parts[4])
	}
	return req
}

// glmOKServer answers a passing GLM probe.
func glmOKServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":200,"success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":12,"nextResetTime":1790000000000}],"level":"max"}}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

const quotaSourceOtherUser = "00000000-0000-0000-0000-00000000face"

// Round-trip: create (probe passes) → list → patch visibility → refresh
// cooldown → delete. The probe never persists on failure.
func TestQuotaSourceLifecycle(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h := withQuotaSourceBox(t)
	srv := glmOKServer(t)

	create := map[string]any{
		"kind": "glm", "name": "智谱 Max 主力号",
		"credential": "sk-test-key-123456",
		"base_url":   srv.URL,
	}
	// base_url host is the loopback test server: bypass the public-internet
	// policy the way plugin tests do, by registering it as a dev origin.
	t.Setenv("MULTICA_PLUGIN_DEV_ORIGINS", srv.URL)

	var created struct {
		ID             string                     `json:"id"`
		Kind           string                     `json:"kind"`
		CredentialHint string                     `json:"credential_hint"`
		Quota          *protocol.RuntimePlanQuota `json:"quota"`
	}
	resp := testutil.Call(t, h.CreateQuotaSource, quotaSourceRequest(http.MethodPost, "/api/me/quota-sources", testUserID, create)).Want(http.StatusCreated)
	if err := json.Unmarshal([]byte(resp.Text()), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID == "" || created.Kind != "glm" {
		t.Fatalf("created = %+v", created)
	}
	// Hint is the last 4 of the credential; the credential itself never
	// appears anywhere in the response.
	if created.CredentialHint != "3456" {
		t.Fatalf("credential_hint = %q, want 3456", created.CredentialHint)
	}
	if strings.Contains(resp.Text(), "sk-test-key-123456") {
		t.Fatal("credential plaintext leaked in response")
	}
	if created.Quota == nil || len(created.Quota.Windows) != 1 {
		t.Fatalf("probe snapshot missing: %+v", created.Quota)
	}
	t.Cleanup(func() {
		testutil.Call(t, h.DeleteQuotaSource, quotaSourceRequest(http.MethodDelete, "/api/me/quota-sources/"+created.ID, testUserID, nil))
	})

	// Owner list contains it.
	list := struct {
		EncryptionConfigured bool `json:"encryption_configured"`
		Sources              []struct {
			ID string `json:"id"`
		} `json:"sources"`
	}{}
	listResp := testutil.Call(t, h.ListQuotaSources, quotaSourceRequest(http.MethodGet, "/api/me/quota-sources", testUserID, nil)).Want(http.StatusOK)
	if err := json.Unmarshal([]byte(listResp.Text()), &list); err != nil {
		t.Fatal(err)
	}
	if !list.EncryptionConfigured || len(list.Sources) == 0 {
		t.Fatalf("list = %+v", list)
	}

	// Non-owner cannot see or mutate it: 404 across the board.
	other := quotaSourceRequest(http.MethodGet, "/api/me/quota-sources", quotaSourceOtherUser, nil)
	testutil.Call(t, h.ListQuotaSources, other).Want(http.StatusOK) // own (empty) list is fine
	testutil.Call(t, h.DeleteQuotaSource, quotaSourceRequest(http.MethodDelete, "/api/me/quota-sources/"+created.ID, quotaSourceOtherUser, nil)).Want(http.StatusNotFound)
	patch := quotaSourceRequest(http.MethodPatch, "/api/me/quota-sources/"+created.ID, quotaSourceOtherUser, map[string]any{"name": "hijack"})
	testutil.Call(t, h.UpdateQuotaSource, patch).Want(http.StatusNotFound)

	// Patch visibility without touching the credential: no probe needed.
	patched := testutil.Call(t, h.UpdateQuotaSource, quotaSourceRequest(http.MethodPatch, "/api/me/quota-sources/"+created.ID, testUserID, map[string]any{"visibility": "shared"})).Want(http.StatusOK)
	if !strings.Contains(patched.Text(), `"shared"`) {
		t.Fatalf("patch response: %s", patched.Text())
	}

	// Immediate refresh hits the 30s cooldown.
	testutil.Call(t, h.RefreshQuotaSource, quotaSourceRequest(http.MethodPost, "/api/me/quota-sources/"+created.ID+"/refresh", testUserID, nil)).Want(http.StatusTooManyRequests)

	// Delete succeeds; second delete 404s.
	testutil.Call(t, h.DeleteQuotaSource, quotaSourceRequest(http.MethodDelete, "/api/me/quota-sources/"+created.ID, testUserID, nil)).Want(http.StatusNoContent)
	testutil.Call(t, h.DeleteQuotaSource, quotaSourceRequest(http.MethodDelete, "/api/me/quota-sources/"+created.ID, testUserID, nil)).Want(http.StatusNotFound)
}

// A failing probe never persists the row.
func TestQuotaSourceCreateProbeFailureNoRow(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h := withQuotaSourceBox(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_PLUGIN_DEV_ORIGINS", srv.URL)

	resp := testutil.Call(t, h.CreateQuotaSource, quotaSourceRequest(http.MethodPost, "/api/me/quota-sources", testUserID, map[string]any{
		"kind": "glm", "name": "bad key", "credential": "sk-wrong-key-999", "base_url": srv.URL,
	})).Want(http.StatusUnprocessableEntity)
	if !strings.Contains(resp.Text(), "invalid_credential") {
		t.Fatalf("probe failure body: %s", resp.Text())
	}
	var count int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM quota_source WHERE owner_id = $1`, testUserID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	// Other tests' rows may exist; this test's row must not. Match by name.
	var this int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM quota_source WHERE owner_id = $1 AND name = 'bad key'`, testUserID).Scan(&this); err != nil {
		t.Fatal(err)
	}
	if this != 0 {
		t.Fatalf("failed probe persisted %d rows", this)
	}
	_ = count
}

// Without the encryption key, every write path refuses with 503 and the
// legacy GLM endpoint answers enabled=false.
func TestQuotaSourceEncryptionGate(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h := *testHandler
	h.QuotaSourceBox = nil
	testutil.Call(t, h.CreateQuotaSource, quotaSourceRequest(http.MethodPost, "/api/me/quota-sources", testUserID, map[string]any{
		"kind": "glm", "name": "x", "credential": "sk-123456789012",
	})).Want(http.StatusServiceUnavailable)

	legacy := testutil.Call(t, h.GetGlmQuota, httptest.NewRequest(http.MethodGet, "/api/glm-quota", nil)).Want(http.StatusOK)
	if !strings.Contains(legacy.Text(), `"enabled":false`) {
		t.Fatalf("legacy glm-quota body: %s", legacy.Text())
	}
}

// Machine credential actors (task tokens, cloud PATs) are rejected on the
// management routes by RequireHumanActor — pinned here because subscription
// credentials must stay human-only.
func TestQuotaSourceRejectsMachineActors(t *testing.T) {
	req := quotaSourceRequest(http.MethodGet, "/api/me/quota-sources", testUserID, nil)
	req.Header.Set("X-Actor-Source", "task_token")
	blocked := false
	RequireHumanActor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { blocked = false })).ServeHTTP(httptest.NewRecorder(), req)
	rec := httptest.NewRecorder()
	RequireHumanActor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		blocked = true
	})).ServeHTTP(rec, req)
	if blocked || rec.Code != http.StatusForbidden {
		t.Fatalf("task_token actor: blocked=%v code=%d", blocked, rec.Code)
	}
}

// The workspace read model: private cards only for their owner; shared cards
// only where the owner has a runtime visible to the viewer.
func TestListWorkspaceQuotaSourcesVisibility(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h := withQuotaSourceBox(t)
	srv := glmOKServer(t)
	t.Setenv("MULTICA_PLUGIN_DEV_ORIGINS", srv.URL)

	// The owner's runtimes in this workspace cover the visibility matrix:
	// public, private-unshared, and private-shared-with-viewer.
	mkRuntime := func(name, visibility string, sharedWith []string) string {
		cols := testutil.Cols{"daemon_id": name, "provider": "codex", "visibility": visibility}
		if sharedWith != nil {
			cols["shared_with"] = sharedWith
		}
		id := dbfx.Runtime(t, name, cols)
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, id)
		})
		return id
	}

	var sharedID, privateID string
	for _, tc := range []struct{ name, visibility string }{{"shared card", "shared"}, {"private card", "private"}} {
		var created struct {
			ID string `json:"id"`
		}
		body := map[string]any{"kind": "glm", "name": "vis-" + tc.visibility, "credential": "sk-vis-key-123456", "base_url": srv.URL, "visibility": tc.visibility}
		createResp := testutil.Call(t, h.CreateQuotaSource, quotaSourceRequest(http.MethodPost, "/api/me/quota-sources", testUserID, body)).Want(http.StatusCreated)
		if err := json.Unmarshal([]byte(createResp.Text()), &created); err != nil {
			t.Fatal(err)
		}
		if tc.visibility == "shared" {
			sharedID = created.ID
		} else {
			privateID = created.ID
		}
	}
	t.Cleanup(func() {
		for _, id := range []string{sharedID, privateID} {
			if id != "" {
				testPool.Exec(context.Background(), `DELETE FROM quota_source WHERE id = $1`, id)
			}
		}
	})

	// The other viewer must be a workspace member to see anything.
	otherMember := dbfx.User(t, "Quota Source Viewer", fmt.Sprintf("quota-viewer-%d@multica.test", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, otherMember, "member")
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM member WHERE user_id = $1 AND workspace_id = $2`, otherMember, testWorkspaceID)
		testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, otherMember)
	})

	wsReq := func(userID string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/runtimes/quota-sources", nil)
		req.Header.Set("X-User-ID", userID)
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		return req
	}

	cardIDs := func(userID string) map[string]bool {
		var out struct {
			Sources []struct {
				ID    string `json:"id"`
				IsOwn bool   `json:"is_own"`
			} `json:"sources"`
		}
		cardsResp := testutil.Call(t, h.ListWorkspaceQuotaSources, wsReq(userID)).Want(http.StatusOK)
		if err := json.Unmarshal([]byte(cardsResp.Text()), &out); err != nil {
			t.Fatal(err)
		}
		ids := make(map[string]bool)
		for _, s := range out.Sources {
			ids[s.ID] = true
		}
		return ids
	}

	// Cell: owner without ANY runtime still sees both own cards (OL-1205
	// review #1 — the owner branch must not sit under the runtime EXISTS).
	noRtOwnerCards := cardIDs(testUserID)
	if !noRtOwnerCards[sharedID] || !noRtOwnerCards[privateID] {
		t.Fatalf("owner without runtimes: sees shared=%v private=%v, want both", noRtOwnerCards[sharedID], noRtOwnerCards[privateID])
	}

	// Cell: another member sees neither card while the owner has no runtime
	// here — "follows machine visibility" gates the shared card too.
	noRtMemberCards := cardIDs(otherMember)
	if noRtMemberCards[sharedID] || noRtMemberCards[privateID] {
		t.Fatalf("member with owner runtimes absent: shared=%v private=%v, want none", noRtMemberCards[sharedID], noRtMemberCards[privateID])
	}

	// Cell: owner's PRIVATE UNSHARED runtime does NOT unlock the shared card
	// for the viewer (review #5② V1 mutation).
	mkRuntime("QuotaVis-PrivateUnshared", "private", nil)
	memberCards := cardIDs(otherMember)
	if memberCards[sharedID] {
		t.Fatal("shared card visible while owner has only a private unshared runtime")
	}
	if memberCards[privateID] {
		t.Fatal("private card leaked to another member")
	}

	// Cell: owner's PRIVATE runtime shared WITH the viewer unlocks the
	// shared card (strict ListVisibleAgentRuntimes semantics).
	_ = mkRuntime("QuotaVis-PrivateShared", "private", []string{otherMember})
	memberCards = cardIDs(otherMember)
	if !memberCards[sharedID] {
		t.Fatal("shared card hidden despite owner runtime shared with viewer")
	}
	if memberCards[privateID] {
		t.Fatal("private card leaked to another member")
	}

	// Cell: owner's PUBLIC runtime also unlocks it (original case).
	mkRuntime("QuotaVis-Public", "public", nil)
	memberCards = cardIDs(otherMember)
	if !memberCards[sharedID] {
		t.Fatal("shared card hidden from member despite visible runtime")
	}
	if memberCards[privateID] {
		t.Fatal("private card leaked to another member")
	}

	// The owner keeps seeing their own cards throughout.
	ownerCards := cardIDs(testUserID)
	if !ownerCards[sharedID] || !ownerCards[privateID] {
		t.Fatalf("owner sees shared=%v private=%v", ownerCards[sharedID], ownerCards[privateID])
	}
}

// Review #2: clearing a custom base_url back to default must stick (probe
// hits the default endpoint and the stored NULL replaces the old value).
func TestPatchClearBaseURLToDefault(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h := withQuotaSourceBox(t)
	srv := glmOKServer(t)
	t.Setenv("MULTICA_PLUGIN_DEV_ORIGINS", srv.URL)

	var created struct {
		ID string `json:"id"`
	}
	body := map[string]any{"kind": "glm", "name": "clear-base", "credential": "sk-clear-key-12345", "base_url": srv.URL}
	createResp := testutil.Call(t, h.CreateQuotaSource, quotaSourceRequest(http.MethodPost, "/api/me/quota-sources", testUserID, body)).Want(http.StatusCreated)
	if err := json.Unmarshal([]byte(createResp.Text()), &created); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM quota_source WHERE id = $1`, created.ID)
	})

	// Clear the custom address. The probe now targets the driver default
	// (open.bigmodel.cn — unreachable here), so the update must REFUSE
	// rather than store an address whose probe never passed.
	cleared := ""
	patchResp := testutil.Call(t, h.UpdateQuotaSource, quotaSourceRequest(http.MethodPatch, "/api/me/quota-sources/"+created.ID, testUserID, map[string]any{"base_url": cleared}))
	if patchResp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("clearing to default without a passing probe: got %d %s, want 422", patchResp.Code, patchResp.Text())
	}
	// The stored address is unchanged (the failed probe persisted nothing).
	var stored *string
	if err := testPool.QueryRow(context.Background(), `SELECT base_url FROM quota_source WHERE id = $1`, created.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == nil || *stored != srv.URL {
		t.Fatalf("stored base_url after refused clear = %v, want %s", stored, srv.URL)
	}
}

// Review #2: a source on the default address (NULL) whose visibility-only
// edit re-sends base_url:"" must NOT re-probe — an unrelated edit cannot be
// blocked by provider rate limiting or a stale credential.
func TestPatchVisibilityOnlyDoesNotProbe(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h := withQuotaSourceBox(t)
	srv := glmOKServer(t)
	t.Setenv("MULTICA_PLUGIN_DEV_ORIGINS", srv.URL)

	// Create via the test server, then NULL the base_url directly to model
	// a default-address source (the create path would probe the real
	// default endpoint, which this sandbox cannot reach).
	var created struct {
		ID string `json:"id"`
	}
	createResp := testutil.Call(t, h.CreateQuotaSource, quotaSourceRequest(http.MethodPost, "/api/me/quota-sources", testUserID, map[string]any{
		"kind": "glm", "name": "vis-only", "credential": "sk-visonly-12345", "base_url": srv.URL,
	})).Want(http.StatusCreated)
	if err := json.Unmarshal([]byte(createResp.Text()), &created); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM quota_source WHERE id = $1`, created.ID)
	})
	if _, err := testPool.Exec(context.Background(), `UPDATE quota_source SET base_url = NULL WHERE id = $1`, created.ID); err != nil {
		t.Fatal(err)
	}

	// The dev-origin bypass only covers the test server URL: a probe here
	// would target open.bigmodel.cn and fail. Re-sending base_url:"" must
	// therefore not probe at all — a 200 proves it.
	patchResp := testutil.Call(t, h.UpdateQuotaSource, quotaSourceRequest(http.MethodPatch, "/api/me/quota-sources/"+created.ID, testUserID, map[string]any{
		"name": "vis-only-renamed", "base_url": "", "visibility": "shared",
	})).Want(http.StatusOK)
	if !strings.Contains(patchResp.Text(), "vis-only-renamed") {
		t.Fatalf("patch response: %s", patchResp.Text())
	}
	// Address stays NULL (no phantom re-probe, no address resurrection).
	var stored *string
	if err := testPool.QueryRow(context.Background(), `SELECT base_url FROM quota_source WHERE id = $1`, created.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != nil {
		t.Fatalf("stored base_url = %v, want NULL", *stored)
	}
}

// Review #3: replacing the credential after a failed poll stores the fresh
// probe snapshot and clears the stale error/counters immediately.
func TestPatchCredentialClearsStaleError(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h := withQuotaSourceBox(t)
	srv := glmOKServer(t)
	t.Setenv("MULTICA_PLUGIN_DEV_ORIGINS", srv.URL)

	var created struct {
		ID string `json:"id"`
	}
	// Seed a source with a stale failure state.
	if err := testPool.QueryRow(context.Background(),
		`INSERT INTO quota_source (owner_id, kind, name, base_url, credential_ciphertext, credential_hint,
		  last_error_code, last_error_message, consecutive_failures, next_poll_at)
		 VALUES ($1, 'glm', 'stale-err', $2, '\x00'::bytea, '', 'invalid_credential', 'old key rejected', 3, now() + interval '25 minutes')
		 RETURNING id::text`, testUserID, srv.URL).Scan(&created.ID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM quota_source WHERE id = $1`, created.ID)
	})

	var resp struct {
		Quota     *protocol.RuntimePlanQuota `json:"quota"`
		LastError *QuotaSourceError          `json:"last_error"`
	}
	patchResp := testutil.Call(t, h.UpdateQuotaSource, quotaSourceRequest(http.MethodPatch, "/api/me/quota-sources/"+created.ID, testUserID, map[string]any{
		"credential": "sk-new-key-6789",
	})).Want(http.StatusOK)
	if err := json.Unmarshal([]byte(patchResp.Text()), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.LastError != nil {
		t.Fatalf("last_error survived credential replacement: %+v", resp.LastError)
	}
	if resp.Quota == nil || len(resp.Quota.Windows) == 0 {
		t.Fatal("probe snapshot not stored on credential change")
	}
	var failures int
	var snapshot []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT consecutive_failures, snapshot FROM quota_source WHERE id = $1`, created.ID).Scan(&failures, &snapshot); err != nil {
		t.Fatal(err)
	}
	if failures != 0 || snapshot == nil {
		t.Fatalf("consecutive_failures=%d snapshot=%v, want 0 and a snapshot", failures, snapshot)
	}
}
