package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func conversationAutopilotCaller(t *testing.T, lineage string) (*conversationFixture, db.AgentTaskQueue) {
	t.Helper()
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	root := f.task(t)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1", root.ID)
	if lineage == "root" {
		return f, root
	}
	cols := testutil.Cols{"runtime_id": f.runtime, "issue_id": f.issue, "status": "running",
		"originator_user_id": root.OriginatorUserID, "accountable_user_id": root.AccountableUserID}
	switch lineage {
	case "retry":
		cols["originator_source"], cols["retry_of_task_id"] = "retry", root.ID
	case "wakeup":
		cols["originator_source"], cols["delegated_from_task_id"] = "trigger_owner", root.ID
	case "deleted intermediate":
		parent := dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "originator_source": "delegation",
			"delegated_from_task_id": root.ID, "originator_user_id": root.OriginatorUserID, "accountable_user_id": root.AccountableUserID})
		cols["originator_source"], cols["delegated_from_task_id"] = "delegation", parent
	default:
		cols["originator_source"], cols["delegated_from_task_id"] = "delegation", root.ID
	}
	id := dbfx.Task(t, f.agent, cols)
	if lineage == "deleted intermediate" {
		dbfx.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", cols["delegated_from_task_id"])
	}
	task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(id))
	if err != nil || task.ConversationRootTaskID != root.ID {
		t.Fatalf("fixture lost conversation root: %+v %v", task, err)
	}
	return f, task
}

func TestAutopilotExternalConversationCannotSpendDurableAuthority(t *testing.T) {
	for _, lineage := range []string{"root", "delegation", "retry", "wakeup", "deleted intermediate"} {
		t.Run(lineage, func(t *testing.T) {
			f, task := conversationAutopilotCaller(t, lineage)
			fx := newActingFixture(t, "external-"+lineage)
			dbfx.Cleanup(t, "DELETE FROM autopilot WHERE title=$1", "external automation "+f.issue)
			dbfx.Cleanup(t, "DELETE FROM autopilot_rule_version WHERE autopilot_id IN (SELECT id FROM autopilot WHERE title=$1)", "external automation "+f.issue)
			token := f.token(t, task)
			caller := actingCaller{authUserID: testUserID}
			endpoints := append(autopilotWriteEndpoints(),
				autopilotWriteEndpoint{name: "create-autopilot", handler: testHandler.CreateAutopilot,
					send: func(_ actingFixture, c actingCaller) *http.Request {
						return c.request("POST", "/api/autopilots?workspace_id="+testWorkspaceID, map[string]any{
							"title": "external automation " + f.issue, "assignee_type": "agent", "assignee_id": f.agent,
							"execution_mode": "run_only", "status": "active",
						})
					}},
				autopilotWriteEndpoint{name: "create-webhook", handler: testHandler.CreateAutopilotTrigger,
					send: func(fx actingFixture, c actingCaller) *http.Request {
						return withURLParams(c.request("POST", "/api/autopilots/"+fx.autopilotID+"/triggers?workspace_id="+testWorkspaceID,
							map[string]any{"kind": "webhook", "provider": "generic"}), "id", fx.autopilotID)
					}},
				autopilotWriteEndpoint{name: "run-now", handler: testHandler.TriggerAutopilot,
					send: func(fx actingFixture, c actingCaller) *http.Request {
						return withURLParams(c.request("POST", "/api/autopilots/"+fx.autopilotID+"/trigger?workspace_id="+testWorkspaceID, nil), "id", fx.autopilotID)
					}},
			)
			for _, ep := range endpoints {
				t.Run(ep.name, func(t *testing.T) {
					req := ep.send(fx, caller)
					req.Header.Set("Authorization", "Bearer "+token)
					// A client cannot discard or substitute its external provenance.
					req.Header.Set("X-Task-ID", "")
					req.Header.Set("X-Actor-Source", "member")
					var body triggerErrorBody
					testutil.Call(t, middleware.Auth(f.h.Queries, nil, nil, nil)(http.HandlerFunc(ep.handler)).ServeHTTP, req).
						Want(http.StatusForbidden).JSON(&body)
					if body.Code != "autopilot_external_conversation_forbidden" {
						t.Fatalf("expected the conversation boundary, got %+v", body)
					}
				})
			}
			if n := dbfx.Count(t, "SELECT count(*) FROM autopilot_run WHERE autopilot_id=$1", fx.autopilotID); n != 0 {
				t.Fatal("refused requests created runs")
			}
			if n := dbfx.Count(t, "SELECT count(*) FROM autopilot WHERE title=$1", "external automation "+f.issue); n != 0 {
				t.Fatal("refused request created an autopilot")
			}
			if n := dbfx.Count(t, "SELECT count(*) FROM autopilot_trigger WHERE autopilot_id=$1", fx.autopilotID); n != 2 {
				t.Fatal("refused requests changed the trigger set")
			}
		})
	}
}

func TestAutopilotExternalConversationCannotReadWebhookCredentials(t *testing.T) {
	f, task := conversationAutopilotCaller(t, "deleted intermediate")
	fx := newActingFixture(t, "external-read")
	token := f.token(t, task)
	get := func(handler http.HandlerFunc, path string) *testutil.Response {
		t.Helper()
		req := withURLParams(newRequest("GET", path, nil), "id", fx.autopilotID)
		req.Header.Set("Authorization", "Bearer "+token)
		return testutil.Call(t, middleware.Auth(f.h.Queries, nil, nil, nil)(handler).ServeHTTP, req)
	}
	var detail struct {
		Autopilot AutopilotResponse          `json:"autopilot"`
		Triggers  []AutopilotTriggerResponse `json:"triggers"`
	}
	get(testHandler.GetAutopilot, "/api/autopilots/"+fx.autopilotID+"?workspace_id="+testWorkspaceID).Want(http.StatusOK).JSON(&detail)
	if detail.Autopilot.CanWrite == nil || *detail.Autopilot.CanWrite || detail.Autopilot.CanManageAccess == nil || *detail.Autopilot.CanManageAccess {
		t.Fatal("read response advertised durable authority")
	}
	if len(detail.Triggers) != 2 {
		t.Fatal("lost read-only trigger metadata")
	}
	for _, tr := range detail.Triggers {
		if tr.WebhookToken != nil || tr.WebhookPath != nil || tr.WebhookURL != nil {
			t.Fatal("external task received a bearer webhook credential")
		}
	}
	var list struct {
		Autopilots []AutopilotResponse `json:"autopilots"`
	}
	get(testHandler.ListAutopilots, "/api/autopilots?workspace_id="+testWorkspaceID).Want(http.StatusOK).JSON(&list)
	for _, ap := range list.Autopilots {
		if ap.CanWrite != nil && *ap.CanWrite {
			t.Fatal("list advertised durable authority")
		}
	}
	dbfx.Exec(t, "UPDATE channel_installation SET config=config-'conversation' WHERE id=$1", f.install)
	get(testHandler.GetAutopilot, "/api/autopilots/"+fx.autopilotID+"?workspace_id="+testWorkspaceID).Want(http.StatusForbidden)
}

func TestAutopilotFirstPartyTaskKeepsAuthenticatedWriteAccess(t *testing.T) {
	f := newConversationFixture(t)
	id := callerTask(t, f.agent, testUserID)
	task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(id))
	if err != nil || task.ConversationRootTaskID.Valid {
		t.Fatalf("invalid first-party fixture: %+v %v", task, err)
	}
	title := "first-party automation " + f.issue
	dbfx.Cleanup(t, "DELETE FROM autopilot WHERE title=$1", title)
	dbfx.Cleanup(t, "DELETE FROM autopilot_rule_version WHERE autopilot_id IN (SELECT id FROM autopilot WHERE title=$1)", title)
	req := newRequest("POST", "/api/autopilots?workspace_id="+testWorkspaceID, map[string]any{
		"title": title, "assignee_id": f.agent, "execution_mode": "run_only",
	})
	req.Header.Set("Authorization", "Bearer "+f.token(t, task))
	var ap AutopilotResponse
	testutil.Call(t, middleware.Auth(f.h.Queries, nil, nil, nil)(http.HandlerFunc(testHandler.CreateAutopilot)).ServeHTTP, req).
		Want(http.StatusCreated).JSON(&ap)
	if ap.CreatedByID != testUserID || ap.CreatedByType != "member" {
		t.Fatalf("ordinary task lost its human authority: %+v", ap)
	}
}
