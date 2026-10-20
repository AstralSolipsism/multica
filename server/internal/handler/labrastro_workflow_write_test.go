package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Both the description/attachment transaction and the lighter status path
// refresh nullable fields under a lock. A workflow assignee must survive both.
func TestLabrastroWorkflowHandoffSurvivesAtomicRefresh(t *testing.T) {
	seedTestCatalog(t)
	agent := seededReadyAgentID(t)
	project := deliveryProject(t, "Atomic handoff", agent)
	for _, compound := range []bool{false, true} {
		t.Run(map[bool]string{false: "description", true: "dependencies"}[compound], func(t *testing.T) {
			issue := dbfx.Issue(t, "Handoff with text", testutil.Cols{"project_id": project, "status": "todo"})
			body := map[string]any{"status": "in_progress", "description": "Updated with the handoff"}
			if compound {
				body["blocked_by"] = []string{}
				req := withURLParam(newRequest("PATCH", "/api/issues/"+issue+"/with-dependencies", body), "id", issue)
				testutil.Call(t, testHandler.UpdateIssueWithDependencies, req).Want(http.StatusOK)
			} else {
				updateIssueForTest(t, issue, body).Want(http.StatusOK)
			}
			status, kind, id := issueStatusAndAssignee(t, issue)
			if status != "in_progress" || kind != "agent" || id != agent {
				t.Fatalf("handoff overwritten by row refresh: %s %s/%s", status, kind, id)
			}
			var description string
			dbfx.QueryRow(t, "SELECT description FROM issue WHERE id=$1", issue).Scan(&description)
			if description != body["description"] {
				t.Fatal("atomic handoff lost the description")
			}
		})
	}
}

func TestLabrastroConversationWorkflowHandoffKeepsGrantor(t *testing.T) {
	seedTestCatalog(t)
	f := newConversationFixture(t)
	grantor := dbfx.User(t, "Workflow grantor", f.install+"@workflow.test")
	dbfx.Member(t, testWorkspaceID, grantor, "member")
	dbfx.Exec(t, "UPDATE agent SET owner_id=$2 WHERE id=$1", f.agent, grantor)
	dbfx.Exec(t, `UPDATE channel_installation SET config=jsonb_set(config,'{conversation,authorized_by}',to_jsonb($2::text)) WHERE id=$1`, f.install, grantor)
	f.msg.ReplyTo = nil
	f.ingest(t)
	root := f.task(t)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1", root.ID)
	token := f.token(t, root) // Protocol user is still the runtime owner.
	target := dbfx.Agent(t, "Workflow target", f.runtime, testutil.Cols{"owner_id": grantor, "permission_mode": "private"})
	project := deliveryProject(t, "External handoff", target)
	f.h.FeatureFlags = testHandler.FeatureFlags
	dbfx.Exec(t, "UPDATE issue SET project_id=$2,status='todo' WHERE id=$1", f.issue, project)
	router := chi.NewRouter()
	router.Use(middleware.Auth(f.h.Queries, nil, nil, nil))
	router.Put("/api/issues/{id}", f.h.UpdateIssue)
	request := func() *http.Request {
		req := httptest.NewRequest("PUT", "/api/issues/"+f.issue, strings.NewReader(`{"status":"in_progress","description":"External handoff"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		return req
	}
	testutil.Call(t, router.ServeHTTP, request()).Want(http.StatusOK)
	var user, accountable, ancestry string
	dbfx.QueryRow(t, `SELECT originator_user_id::text,accountable_user_id::text,conversation_root_task_id::text
		FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2`, f.issue, target).Scan(&user, &accountable, &ancestry)
	if user != grantor || accountable != grantor || ancestry != uuidToString(root.ID) {
		t.Fatalf("handoff lost frozen authority: user=%s accountable=%s root=%s", user, accountable, ancestry)
	}
	dbfx.Exec(t, "UPDATE issue SET status='todo',assignee_type=NULL,assignee_id=NULL WHERE id=$1", f.issue)
	dbfx.Exec(t, "UPDATE channel_installation SET config=config-'conversation' WHERE id=$1", f.install)
	testutil.Call(t, router.ServeHTTP, request()).Want(http.StatusForbidden)
	if status, _, _ := issueStatusAndAssignee(t, f.issue); status != "todo" {
		t.Fatal("a revoked conversation still entered the handoff step")
	}
}

// A batch has one request map but each project's handoff selects its own agent.
func TestLabrastroWorkflowBatchKeepsPerIssueHandlers(t *testing.T) {
	seedTestCatalog(t)
	runtime := dbfx.Runtime(t, "Batch workflow")
	agents := []string{
		dbfx.Agent(t, "First handler", runtime),
		dbfx.Agent(t, "Second handler", runtime),
	}
	var ids []string
	for _, agent := range agents {
		workflow := createTestWorkflow(t, "Batch "+agent, "in_progress")
		setWorkflowHandoff(t, workflow.ID, "in_progress", handToAgent(agent, "")).Want(http.StatusOK)
		project := createWorkflowTestProject(t, "Batch "+agent)
		setProjectWorkflow(t, project, map[string]any{"workflow_id": workflow.ID}).Want(http.StatusOK)
		ids = append(ids, dbfx.Issue(t, "Batch handoff", testutil.Cols{"project_id": project, "status": "todo"}))
	}
	for _, description := range []bool{false, true} {
		for _, id := range ids {
			dbfx.Exec(t, "UPDATE issue SET status='todo',assignee_type=NULL,assignee_id=NULL WHERE id=$1", id)
		}
		updates := map[string]any{"status": "in_progress", "suppress_run": true}
		if description {
			updates["description"] = "Batch description"
		}
		req := workflowRequest("POST", "/api/issues/batch-update", map[string]any{"issue_ids": ids, "updates": updates})
		var result struct {
			Updated int `json:"updated"`
		}
		testutil.Call(t, testHandler.BatchUpdateIssues, req).Want(http.StatusOK).JSON(&result)
		if result.Updated != len(ids) {
			t.Fatalf("updated %d of %d", result.Updated, len(ids))
		}
		for i, id := range ids {
			_, kind, got := issueStatusAndAssignee(t, id)
			if kind != "agent" || got != agents[i] {
				t.Fatalf("issue %s: handler %s/%s, want %s", id, kind, got, agents[i])
			}
			tasks, err := testHandler.Queries.ListTasksByIssue(context.Background(), parseUUID(id))
			if err != nil || len(tasks) != 0 {
				t.Fatalf("suppress_run lost: tasks=%v error=%v", tasks, err)
			}
		}
	}
}
