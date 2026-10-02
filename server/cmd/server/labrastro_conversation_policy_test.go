package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type externalRoute struct{ method, pattern, auth, decision string }

func externalRouteInventory(t *testing.T) []externalRoute {
	t.Helper()
	var routes []externalRoute
	err := chi.Walk(testServer.Config.Handler.(chi.Routes), func(method, pattern string, _ http.Handler, mws ...func(http.Handler) http.Handler) error {
		kind := "public-or-capability"
		for _, mw := range mws {
			name := runtime.FuncForPC(reflect.ValueOf(mw).Pointer()).Name()
			switch {
			case strings.Contains(name, ".Auth."):
				kind = "user-auth"
			case strings.Contains(name, ".DaemonAuth."):
				kind = "daemon-auth"
			case strings.Contains(name, "middleware.PluginBearerOnly"):
				kind = "plugin-auth"
			}
		}
		decision := "separate-auth"
		if kind == "user-auth" {
			decision = "deny"
			if middleware.ExternalConversationRouteAllowed(method, pattern) {
				decision = "allow"
			}
		}
		routes = append(routes, externalRoute{method, pattern, kind, decision})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.SortFunc(routes, func(a, b externalRoute) int { return strings.Compare(a.pattern+" "+a.method, b.pattern+" "+b.method) })
	return routes
}

func TestExternalConversationRouteInventory(t *testing.T) {
	var catalog strings.Builder
	allow, deny := 0, 0
	for _, route := range externalRouteInventory(t) {
		fmt.Fprintf(&catalog, "%s\t%s\t%s\t%s\n", route.method, route.pattern, route.auth, route.decision)
		if route.decision == "allow" {
			allow++
		}
		if route.decision == "deny" {
			deny++
		}
	}
	if allow < 10 || deny < 300 {
		t.Fatalf("incomplete production route walk: allow=%d deny=%d", allow, deny)
	}
	const path = "testdata/labrastro-external-routes.tsv"
	if os.Getenv("LABRASTRO_UPDATE_ROUTE_INVENTORY") == "1" {
		if err := os.WriteFile(path, []byte(catalog.String()), 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != catalog.String() {
		t.Fatalf("production routes or external-conversation policy changed; review the new method/template and regenerate %s with LABRASTRO_UPDATE_ROUTE_INVENTORY=1 (unknown routes already deny by default)", path)
	}
	t.Logf("production user routes: %d allow, %d deny", allow, deny)
}

type externalPolicyFixture struct {
	fx                                   *testutil.Fixture
	agent, runtime, root, install, token string
}

func newExternalPolicyFixture(t *testing.T, lineage string) externalPolicyFixture {
	t.Helper()
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	f := externalPolicyFixture{fx: fx}
	f.runtime = fx.Runtime(t, "policy runtime")
	f.agent = fx.Agent(t, "policy agent", f.runtime)
	f.root = fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "status": "running", "originator_source": "channel_integration", "originator_user_id": testUserID, "accountable_user_id": testUserID})
	config := fmt.Sprintf(`{"chat_id":"oc_policy","conversation":{"id":%q,"authorized_by":%q,"scope":"workspace","chats":[{"chat_id":"oc_policy","chat_type":"group"}]}}`, f.root, testUserID)
	f.install = fx.Insert(t, "channel_installation", testutil.Cols{"workspace_id": testWorkspaceID, "agent_id": f.agent, "channel_type": "feishu", "installer_user_id": testUserID, "status": "active", "config": config})
	fx.InsertNoID(t, "channel_task_delivery", testutil.Cols{"task_id": f.root, "binding_id": f.root, "installation_id": f.install, "channel_type": "feishu", "channel_chat_id": "oc_policy", "chat_type": "group", "route_revision": 1, "config": config}, "task_id=$1", f.root)
	id := f.root
	if lineage != "root" {
		cols := testutil.Cols{"runtime_id": f.runtime, "status": "running", "originator_user_id": testUserID, "accountable_user_id": testUserID, "originator_source": "delegation", "delegated_from_task_id": f.root}
		if lineage == "retry" {
			cols["originator_source"], cols["retry_of_task_id"] = "retry", f.root
		}
		if lineage == "deleted-parent" {
			parent := fx.Task(t, f.agent, cols)
			cols["delegated_from_task_id"] = parent
			id = fx.Task(t, f.agent, cols)
			fx.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", parent)
		} else {
			id = fx.Task(t, f.agent, cols)
		}
	}
	f.token = mintAgentTaskToken(t, f.agent, id, testUserID)
	return f
}

func policyRequest(t *testing.T, token, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	// None of these client-supplied claims may shed the stored ancestry.
	req.Header.Set("X-Actor-Source", "member")
	req.Header.Set("X-Task-ID", "")
	req.Header.Set("X-Agent-ID", "")
	req.Header.Set("X-Workspace-ID", testWorkspaceID)
	w := httptest.NewRecorder()
	testServer.Config.Handler.ServeHTTP(w, req)
	return w
}

func TestExternalConversationEveryDeniedProductionRoute(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	params := regexp.MustCompile(`\{[^}]+\}`)
	tested := 0
	for _, route := range externalRouteInventory(t) {
		if route.decision != "deny" {
			continue
		}
		tested++
		t.Run(route.method+" "+route.pattern, func(t *testing.T) {
			path := params.ReplaceAllString(route.pattern, "00000000-0000-0000-0000-000000000099")
			w := policyRequest(t, f.token, route.method, path, map[string]any{})
			var body struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			if w.Code != http.StatusForbidden || body.Code != "external_conversation_forbidden" {
				t.Fatalf("route escaped the central gate: status=%d code=%q", w.Code, body.Code)
			}
		})
	}
	if tested < 300 {
		t.Fatalf("only %d protected routes tested", tested)
	}
}

func TestExternalConversationAncestryAndRevocationAtRouter(t *testing.T) {
	for _, lineage := range []string{"root", "delegation", "retry", "deleted-parent"} {
		t.Run(lineage, func(t *testing.T) {
			f := newExternalPolicyFixture(t, lineage)
			// A permitted read proves the credential and grant are otherwise valid.
			if w := policyRequest(t, f.token, "GET", "/api/issues", nil); w.Code != 200 {
				t.Fatalf("valid grant read: %d", w.Code)
			}
			for _, path := range []string{"/api/tokens", "/api/cli-token", "/api/auth/refresh", "/api/autopilots", "/api/message-routes", "/api/message-approved-targets", "/api/agents", "/api/skills", "/api/issues/" + f.root + "/wakeups"} {
				w := policyRequest(t, f.token, "POST", path, map[string]any{"name": "must not exist"})
				if w.Code != 403 || !strings.Contains(w.Body.String(), "external_conversation_forbidden") {
					t.Fatalf("%s was not policy-denied: %d", path, w.Code)
				}
			}
			f.fx.Exec(t, "UPDATE channel_installation SET config=config-'conversation' WHERE id=$1", f.install)
			if w := policyRequest(t, f.token, "GET", "/api/issues", nil); w.Code != 403 {
				t.Fatalf("revoked grant read: %d", w.Code)
			}
		})
	}
}

func TestExternalConversationIssueCollaborationThroughRouter(t *testing.T) {
	f := newExternalPolicyFixture(t, "deleted-parent")
	w := policyRequest(t, f.token, "POST", "/api/issues", map[string]any{"title": "external policy collaboration", "status": "todo"})
	if w.Code != 201 {
		t.Fatalf("create issue: %d %s", w.Code, w.Body.String())
	}
	var issue struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &issue); err != nil {
		t.Fatal(err)
	}
	f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", issue.ID)
	f.fx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id=$1", issue.ID)
	if w = policyRequest(t, f.token, "PUT", "/api/issues/"+issue.ID, map[string]any{"title": "updated external feedback"}); w.Code != 200 {
		t.Fatalf("update issue: %d", w.Code)
	}
	w = policyRequest(t, f.token, "POST", "/api/issues/"+issue.ID+"/comments", map[string]any{"content": "feedback from external conversation"})
	if w.Code != 201 {
		t.Fatalf("comment: %d %s", w.Code, w.Body.String())
	}
	var comment struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &comment); err != nil {
		t.Fatal(err)
	}
	f.fx.Cleanup(t, "DELETE FROM comment WHERE id=$1", comment.ID)
	if w = policyRequest(t, f.token, "GET", "/api/issues/"+issue.ID+"/comments", nil); w.Code != 200 {
		t.Fatalf("read comments: %d", w.Code)
	}
	if w = policyRequest(t, f.token, "PUT", "/api/comments/"+comment.ID, map[string]any{"content": "revised feedback"}); w.Code != 200 {
		t.Fatalf("edit comment: %d", w.Code)
	}
	var payload bytes.Buffer
	form := multipart.NewWriter(&payload)
	if err := form.WriteField("issue_id", issue.ID); err != nil {
		t.Fatal(err)
	}
	part, err := form.CreateFormFile("file", "external-feedback.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("external feedback attachment")); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/upload-file", &payload)
	req.Header.Set("Authorization", "Bearer "+f.token)
	req.Header.Set("Content-Type", form.FormDataContentType())
	w = httptest.NewRecorder()
	testServer.Config.Handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("upload attachment: %d %s", w.Code, w.Body.String())
	}
	var attachment struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &attachment); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if w := policyRequest(t, f.token, "DELETE", "/api/attachments/"+attachment.ID, nil); w.Code != 204 {
			t.Errorf("delete fixture attachment: %d", w.Code)
		}
	})
	if w := policyRequest(t, f.token, "GET", "/api/attachments/"+attachment.ID+"/content", nil); w.Code != 200 {
		t.Fatalf("read attachment: %d", w.Code)
	}
}

func TestExternalConversationDelegatedIssueCarriesGrant(t *testing.T) {
	f := newExternalPolicyFixture(t, "deleted-parent")
	delegate := f.fx.Agent(t, "policy delegate", f.runtime)
	w := policyRequest(t, f.token, "POST", "/api/issues", map[string]any{
		"title": "delegated external feedback", "status": "in_progress", "assignee_type": "agent", "assignee_id": delegate,
	})
	if w.Code != 201 {
		t.Fatalf("delegate issue: %d", w.Code)
	}
	var issue struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &issue); err != nil {
		t.Fatal(err)
	}
	f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", issue.ID)
	f.fx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id=$1", issue.ID)
	f.fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue.ID)
	var task, root string
	f.fx.QueryRow(t, "SELECT id::text,conversation_root_task_id::text FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2", issue.ID, delegate).Scan(&task, &root)
	if root != f.root {
		t.Fatalf("delegation lost its grant: root=%s", root)
	}
	f.fx.Exec(t, "UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1", task)
	token := mintAgentTaskToken(t, delegate, task, testUserID)
	if w := policyRequest(t, token, "GET", "/api/issues/"+issue.ID, nil); w.Code != 200 {
		t.Fatalf("delegate read: %d", w.Code)
	}
	f.fx.Exec(t, "UPDATE channel_installation SET config=config-'conversation' WHERE id=$1", f.install)
	if w := policyRequest(t, token, "GET", "/api/issues/"+issue.ID, nil); w.Code != 403 {
		t.Fatalf("revoked delegation read: %d", w.Code)
	}
}

func TestExternalConversationPolicyLeavesFirstPartyCredentialsUnchanged(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	id := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "status": "running", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID})
	ordinary := mintAgentTaskToken(t, f.agent, id, testUserID)
	// The selected policy changes only external conversations. Upstream's
	// member / first-party credential semantics are deliberately unchanged.
	for name, token := range map[string]string{"member": testToken, "ordinary-task": ordinary} {
		t.Run(name, func(t *testing.T) {
			if w := policyRequest(t, token, "POST", "/api/cli-token", nil); w.Code != 200 {
				t.Fatalf("ordinary caller was changed: %d", w.Code)
			}
		})
	}
}

func TestExternalConversationCannotShedPolicyThroughExistingIssues(t *testing.T) {
	for _, via := range []string{"assignment", "comment-mention"} {
		t.Run(via, func(t *testing.T) {
			f := newExternalPolicyFixture(t, "root")
			delegate := f.fx.Agent(t, "existing issue delegate", f.runtime)
			issue := f.fx.Issue(t, "ordinary member issue", testutil.Cols{"status": "in_progress"})
			f.fx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id=$1", issue)
			f.fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
			f.fx.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", issue)
			if via == "assignment" {
				w := policyRequest(t, f.token, "PUT", "/api/issues/"+issue, map[string]any{"assignee_type": "agent", "assignee_id": delegate})
				if w.Code != 200 {
					t.Fatalf("assign: %d", w.Code)
				}
			} else {
				w := policyRequest(t, f.token, "POST", "/api/issues/"+issue+"/comments", map[string]any{"content": "[@delegate](mention://agent/" + delegate + ") please handle this feedback"})
				if w.Code != 201 {
					t.Fatalf("mention: %d", w.Code)
				}
			}
			var root string
			f.fx.QueryRow(t, "SELECT conversation_root_task_id::text FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2", issue, delegate).Scan(&root)
			if root != f.root {
				t.Fatalf("%s laundered external authority through an ordinary issue: root=%s", via, root)
			}
		})
	}
}
