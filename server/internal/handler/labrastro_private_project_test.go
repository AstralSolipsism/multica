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

func TestLabrastroPrivateProjectDependenciesAndGraph(t *testing.T) {
	f := newPrivateProjectFixture(t)
	edge := dbfx.Insert(t, "issue_dependency", testutil.Cols{
		"issue_id": f.publicIssue, "depends_on_issue_id": f.secretIssue, "type": "blocked_by",
	})
	getDependencies := func(user, issue string) *testutil.Response {
		req := withURLParam(asUser(newRequest("GET", "/api/issues/"+issue+"/dependencies", nil), user), "id", issue)
		return testutil.Call(t, testHandler.GetIssueDependencies, req)
	}
	getGraph := func(user string, params url.Values) *testutil.Response {
		return testutil.Call(t, testHandler.GetIssueGraph, asUser(graphRequest(dbfx, params), user))
	}
	for _, user := range []string{f.outsider, f.insider, testUserID} {
		var deps service.DependencyView
		body := getDependencies(user, f.publicIssue).Want(200).JSON(&deps).Text()
		var graph service.IssueGraph
		graphBody := getGraph(user, url.Values{"focus_issue_id": {f.publicIssue}}).Want(200).JSON(&graph).Text()
		if user == f.outsider {
			if !deps.HasRestrictedBlockers || len(deps.BlockedBy) != 0 || len(deps.Unsatisfied) != 0 || !graph.HasRestrictedContext || len(graph.Nodes) != 1 || len(graph.Edges) != 0 {
				t.Fatalf("hidden prerequisite was not restricted: deps=%+v graph=%+v", deps, graph)
			}
			for _, secret := range []string{f.secretIssue, f.projectID, f.marker + " secret", edge} {
				if strings.Contains(body+graphBody, secret) {
					t.Fatalf("restricted response leaks %q: %s %s", secret, body, graphBody)
				}
			}
		} else if len(deps.BlockedBy) != 1 || deps.BlockedBy[0].IssueID != f.secretIssue || deps.BlockedBy[0].Identifier == "" || len(graph.Nodes) != 2 || len(graph.Edges) != 1 {
			t.Fatalf("authorized caller lost prerequisite: deps=%+v graph=%+v", deps, graph)
		}
	}
	for _, key := range []string{"project_id", "focus_issue_id"} {
		id := f.projectID
		if key == "focus_issue_id" {
			id = f.secretIssue
		}
		hidden := getGraph(f.outsider, url.Values{key: {id}}).Want(404)
		missing := getGraph(f.outsider, url.Values{key: {uuid.NewString()}}).Want(404)
		if hidden.Text() != missing.Text() {
			t.Fatalf("%s hidden and missing differ: %s / %s", key, hidden.Text(), missing.Text())
		}
	}
	getDependencies(f.outsider, f.secretIssue).Want(404)
	workspace := getGraph(f.outsider, nil).Want(200).Text()
	if strings.Contains(workspace, f.secretIssue) || strings.Contains(workspace, f.projectID) {
		t.Fatal("workspace graph exposes private project")
	}
	// A public child must not expose its hidden parent or inherited blockers.
	child := dbfx.Issue(t, "public child", testutil.Cols{"parent_issue_id": f.secretIssue})
	var graph service.IssueGraph
	getGraph(f.outsider, url.Values{"focus_issue_id": {child}}).Want(200).JSON(&graph)
	if len(graph.Nodes) != 1 || !graph.Nodes[0].HasRestrictedParent || graph.Nodes[0].ParentIssueID != nil {
		t.Fatalf("hidden parent was not redacted: %+v", graph)
	}
	removeProjectMemberAsOwner(t, f, f.insider)
	var revoked service.DependencyView
	getDependencies(f.insider, f.publicIssue).Want(200).JSON(&revoked)
	if !revoked.HasRestrictedBlockers || len(revoked.BlockedBy) != 0 {
		t.Fatal("revoked member still sees private prerequisites")
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
		hidden, missing := read(f.outsider, f.projectID).Want(404), read(f.outsider, uuid.NewString()).Want(404)
		if hidden.Text() != missing.Text() {
			t.Fatalf("%s distinguishes hidden project: %s / %s", path, hidden.Text(), missing.Text())
		}
		if path == "engineering" || path == "baseline/tree" {
			read(f.insider, f.projectID).Want(200)
			read(testUserID, f.projectID).Want(200)
		}
	}
}

func TestLabrastroPrivateProjectTipChat(t *testing.T) {
	f := newTipChatFixture(t)
	f.Exec(t, `UPDATE agent SET visibility='workspace',permission_mode='public_to' WHERE id=$1`, f.agent)
	f.InsertNoID(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": "workspace", "target_id": f.WorkspaceID}, "agent_id=$1", f.agent)
	project := f.Project(t, "Private tip", testutil.Cols{"visibility": "private"})
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

func TestLabrastroPrivateProjectDependencyCycleWitness(t *testing.T) {
	f := newPrivateProjectFixture(t)
	other := dbfx.Issue(t, "visible prerequisite")
	for _, pair := range [][2]string{{f.publicIssue, f.secretIssue}, {f.secretIssue, other}} {
		dbfx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": pair[0], "depends_on_issue_id": pair[1], "type": "blocked_by"})
	}
	for _, user := range []string{f.outsider, f.insider} {
		var deps service.DependencyView
		req := withURLParam(asUser(newRequest("GET", "/api/issues/"+other+"/dependencies", nil), user), "id", other)
		testutil.Call(t, testHandler.GetIssueDependencies, req).Want(200).JSON(&deps)
		write := withURLParam(asUser(newRequest("PATCH", "/api/issues/"+other+"/with-dependencies", map[string]any{
			"blocked_by": []string{f.publicIssue}, "expected_dependency_version": deps.DependencyVersion,
		}), user), "id", other)
		body := testutil.Call(t, testHandler.UpdateIssueWithDependencies, write).Want(409).Text()
		if strings.Contains(body, f.secretIssue) != (user == f.insider) {
			t.Fatalf("cycle witness did not respect project visibility: %s", body)
		}
	}
}
