package handler

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// The DAG canvas reads upstream blockers. A blocker in a private project the
// caller cannot see is restricted, never disclosed, and answers like missing.
func TestLabrastroPrivateProjectBlockersAndGraph(t *testing.T) {
	f := newPrivateProjectFixture(t)
	addBlocker(t, dbfx, f.publicIssue, f.secretIssue)
	getGraph := func(user string, params url.Values) *testutil.Response {
		return testutil.Call(t, testHandler.GetIssueGraph, asUser(graphRequest(dbfx, params), user))
	}
	for _, user := range []string{f.outsider, f.insider, testUserID} {
		var graph service.IssueGraph
		body := getGraph(user, url.Values{"focus_issue_id": {f.publicIssue}}).Want(http.StatusOK).JSON(&graph).Text()
		if user == f.outsider {
			if !graph.HasRestrictedContext || len(graph.Nodes) != 1 || len(graph.Edges) != 0 || !graphNodes(graph)[f.publicIssue].DependencySummary.HasRestrictedBlockers {
				t.Fatalf("hidden blocker was not restricted: %+v", graph)
			}
			for _, secret := range []string{f.secretIssue, f.projectID, f.marker + " secret"} {
				if strings.Contains(body, secret) {
					t.Fatalf("restricted response leaks %q: %s", secret, body)
				}
			}
		} else if len(graph.Nodes) != 2 || len(graph.Edges) != 1 || graph.Edges[0].Source != f.secretIssue || graph.Edges[0].Target != f.publicIssue {
			t.Fatalf("authorized caller lost the blocker: %+v", graph)
		}
	}
	for _, key := range []string{"project_id", "focus_issue_id"} {
		id := f.projectID
		if key == "focus_issue_id" {
			id = f.secretIssue
		}
		hidden := getGraph(f.outsider, url.Values{key: {id}}).Want(http.StatusNotFound)
		missing := getGraph(f.outsider, url.Values{key: {uuid.NewString()}}).Want(http.StatusNotFound)
		if hidden.Text() != missing.Text() {
			t.Fatalf("%s hidden and missing differ: %s / %s", key, hidden.Text(), missing.Text())
		}
	}
	workspace := getGraph(f.outsider, nil).Want(http.StatusOK).Text()
	if strings.Contains(workspace, f.secretIssue) || strings.Contains(workspace, f.projectID) {
		t.Fatal("workspace graph exposes private project")
	}
	// A public child must not expose its hidden parent.
	child := dbfx.Issue(t, "public child", testutil.Cols{"parent_issue_id": f.secretIssue})
	var graph service.IssueGraph
	getGraph(f.outsider, url.Values{"focus_issue_id": {child}}).Want(http.StatusOK).JSON(&graph)
	if len(graph.Nodes) != 1 || !graph.Nodes[0].HasRestrictedParent || graph.Nodes[0].ParentIssueID != nil {
		t.Fatalf("hidden parent was not redacted: %+v", graph)
	}
	removeProjectMemberAsOwner(t, f, f.insider)
	var revoked service.IssueGraph
	getGraph(f.insider, url.Values{"focus_issue_id": {f.publicIssue}}).Want(http.StatusOK).JSON(&revoked)
	if !revoked.HasRestrictedContext || len(revoked.Edges) != 0 {
		t.Fatal("revoked member still sees private blockers")
	}
}

// A wakeup wait or a mention that touches a private project is no relation for
// a member outside it: the edge is dropped with no restricted flag and no trace
// of the hidden issue, while relations between visible issues remain.
func TestLabrastroPrivateProjectHidesWeakEdges(t *testing.T) {
	f := newPrivateProjectFixture(t)
	peer := dbfx.Issue(t, "public peer", testutil.Cols{"description": "see mention://issue/" + f.publicIssue})
	dbfx.Exec(t, "UPDATE issue SET description=$2 WHERE id=$1", f.publicIssue, "see mention://issue/"+f.secretIssue)
	dbfx.Exec(t, "UPDATE issue SET description=$2 WHERE id=$1", f.secretIssue, "see mention://issue/"+f.publicIssue)
	addWakeup(t, dbfx, f.publicIssue, map[string]any{"type": "other_issue", "issue_id": f.secretIssue, "state": "in_review"})
	addWakeup(t, dbfx, f.secretIssue, map[string]any{"type": "other_issue", "issue_id": f.publicIssue, "state": "done"})
	ours := map[string]bool{peer: true, f.publicIssue: true, f.secretIssue: true}
	for _, tc := range []struct {
		user string
		want int
	}{{f.outsider, 1}, {f.insider, 5}, {testUserID, 5}} {
		var graph service.IssueGraph
		body := testutil.Call(t, testHandler.GetIssueGraph, asUser(graphRequest(dbfx, nil), tc.user)).Want(http.StatusOK).JSON(&graph).Text()
		edges := map[service.IssueGraphWeakEdge]bool{}
		for _, e := range graph.WeakEdges {
			if ours[e.From] && ours[e.To] {
				edges[e] = true
			}
		}
		if len(edges) != tc.want {
			t.Fatalf("weak edges for %s: %+v", tc.user, edges)
		}
		if tc.user == f.outsider {
			_, visible := edges[service.IssueGraphWeakEdge{From: peer, To: f.publicIssue, Kind: "mention"}]
			if !visible || strings.Contains(body, f.secretIssue) || strings.Contains(body, f.projectID) {
				t.Fatalf("a private weak edge leaked to an outsider: %s", body)
			}
		}
	}
	// Alone, the public issue reports no hidden relation at all.
	var focused service.IssueGraph
	testutil.Call(t, testHandler.GetIssueGraph, asUser(graphRequest(dbfx, url.Values{"focus_issue_id": {f.publicIssue}}), f.outsider)).Want(http.StatusOK).JSON(&focused)
	if len(focused.WeakEdges) != 0 || focused.HasRestrictedContext || len(focused.Nodes) != 1 {
		t.Fatalf("a hidden weak edge was restricted instead of dropped: %+v", focused)
	}
}

func TestLabrastroPrivateProjectEngineeringHTTP(t *testing.T) {
	f := newPrivateProjectFixture(t)
	router := chi.NewRouter()
	testHandler.RegisterLabrastroEngineeringRoutes(router)
	for _, path := range []string{"engineering", "baseline/tree", "baseline/pages/missing", "baseline/threads/" + uuid.NewString()} {
		read := func(user, project string) *testutil.Response {
			return testutil.Call(t, router.ServeHTTP, asUser(newRequest("GET", "/api/projects/"+project+"/"+path, nil), user))
		}
		hidden, missing := read(f.outsider, f.projectID).Want(http.StatusNotFound), read(f.outsider, uuid.NewString()).Want(http.StatusNotFound)
		if hidden.Text() != missing.Text() {
			t.Fatalf("%s distinguishes hidden project: %s / %s", path, hidden.Text(), missing.Text())
		}
		if path == "engineering" || path == "baseline/tree" {
			read(f.insider, f.projectID).Want(http.StatusOK)
			read(testUserID, f.projectID).Want(http.StatusOK)
		}
	}
}

func TestLabrastroPrivateProjectTipChat(t *testing.T) {
	f := newTipChatFixture(t)
	f.Exec(t, `UPDATE agent SET visibility='workspace',permission_mode='public_to' WHERE id=$1`, f.agent)
	f.InsertNoID(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": "workspace", "target_id": f.WorkspaceID}, "agent_id=$1", f.agent)
	project := f.Project(t, "Private tip", testutil.Cols{"visibility": "private"})
	f.InsertNoID(t, "project_member", testutil.Cols{"workspace_id": f.WorkspaceID, "project_id": project, "user_id": testUserID}, "project_id=$1 AND user_id=$2", project, testUserID)
	f.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
	user := f.User(t, "Tip member", uuid.NewString()+"@test.invalid")
	f.Member(t, f.WorkspaceID, user, "member")
	tip := f.tip(t, "secret line")
	open := func() *testutil.Response {
		return testutil.Call(t, f.h.LabrastroOpenTipChat, asUser(f.request("POST", nil, "tipId", tip), user))
	}
	open().Want(http.StatusNotFound)
	if f.Count(t, "SELECT count(*) FROM labrastro_tip_chat WHERE tip_id=$1", tip) != 0 {
		t.Fatal("denied open created a side chat")
	}
	f.InsertNoID(t, "project_member", testutil.Cols{"workspace_id": f.WorkspaceID, "project_id": project, "user_id": user}, "project_id=$1 AND user_id=$2", project, user)
	open().Want(http.StatusCreated)
	f.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", project, user)
	open().Want(http.StatusNotFound)
}

func TestLabrastroPrivateProjectGroupedInbox(t *testing.T) {
	f := newPrivateProjectFixture(t)
	for _, issue := range []string{f.secretIssue, f.publicIssue} {
		dbfx.Insert(t, "inbox_item", testutil.Cols{
			"workspace_id": testWorkspaceID, "recipient_type": "member", "recipient_id": f.outsider,
			"type": "issue_assigned", "severity": "info", "issue_id": issue, "title": issue, "body": "notification",
		})
	}
	list := middleware.RequireWorkspaceMember(testHandler.Queries)(http.HandlerFunc(testHandler.ListInbox))
	response := testutil.Call(t, list.ServeHTTP, asUser(newRequest("GET", "/api/inbox?view=grouped", nil), f.outsider)).Want(200).Text()
	if strings.Contains(response, f.secretIssue) || !strings.Contains(response, f.publicIssue) {
		t.Fatalf("grouped inbox isolation failed: %s", response)
	}
}

func TestLabrastroPrivateProjectWorkspaceUsage(t *testing.T) {
	f := newPrivateProjectFixture(t)
	agent := createHandlerTestAgent(t, "usage visibility", []byte("[]"))
	publicProject := dbfx.Project(t, "public usage")
	public := dbfx.Issue(t, "public project usage", testutil.Cols{"project_id": publicProject})
	for _, issue := range []string{f.secretIssue, f.publicIssue, public} {
		task := dbfx.Task(t, agent, testutil.Cols{"issue_id": issue, "status": "completed", "runtime_id": handlerTestRuntimeID(t)})
		dbfx.Insert(t, "task_usage", testutil.Cols{"task_id": task, "provider": "test", "model": "test", "input_tokens": 7, "cost_usd_ticks": 13})
	}
	for _, user := range []string{f.outsider, f.insider, testUserID} {
		var rows []IssueUsageRowResponse
		testutil.Call(t, testHandler.ListWorkspaceIssueUsage, asUser(newRequest("GET", "/api/issues/usage", nil), user)).Want(200).JSON(&rows)
		found := map[string]bool{}
		for _, row := range rows {
			found[row.IssueID] = true
		}
		if found[f.secretIssue] != (user != f.outsider) || !found[f.publicIssue] || !found[public] {
			t.Fatalf("usage visibility for %s: %+v", user, rows)
		}
	}
}
