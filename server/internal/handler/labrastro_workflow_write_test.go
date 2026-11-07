package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// Both the description/attachment transaction and the lighter status path
// refresh nullable fields under a lock. A workflow assignee must survive both.
func TestLabrastroWorkflowHandoffSurvivesAtomicRefresh(t *testing.T) {
	seedTestCatalog(t)
	agent := seededReadyAgentID(t)
	project := deliveryProject(t, "Atomic handoff", agent)
	h := *testHandler
	is := *h.IssueService
	ds := *is.Dependencies
	ds.WritesEnabled = true
	is.Dependencies = &ds
	h.IssueService = &is
	for _, compound := range []bool{false, true} {
		t.Run(map[bool]string{false: "description", true: "dependencies"}[compound], func(t *testing.T) {
			issue := dbfx.Issue(t, "Handoff with text", testutil.Cols{"project_id": project, "status": "todo"})
			body := map[string]any{"status": "in_progress", "description": "Updated with the handoff"}
			if compound {
				body["blocked_by"] = []string{}
				body["expected_dependency_version"] = dependencies(t, &h, dbfx, issue).DependencyVersion
				req := withURLParam(newRequest("PATCH", "/api/issues/"+issue+"/with-dependencies", body), "id", issue)
				testutil.Call(t, h.UpdateIssueWithDependencies, req).Want(http.StatusOK)
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
