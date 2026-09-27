package handler

import (
	"context"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"net/http"
	"testing"
)

func dispatchFixture(t *testing.T) (*Handler, *testutil.Fixture, string, string, string, string, string) {
	t.Helper()
	h, fx := dependencyFixture(t)
	runtime := fx.Runtime(t, "fake dependency runtime")
	agent := fx.Agent(t, "fake dependency agent", runtime)
	a := dependencyIssue(t, fx, "A")
	c := dependencyIssue(t, fx, "C")
	b := dependencyIssue(t, fx, "B", testutil.Cols{"status": "backlog"})
	replaceDependencies(t, h, fx, b, []string{a, c}, "task", http.StatusOK)
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM agent_task_queue WHERE agent_id=$1", agent) })
	return h, fx, a, b, c, agent, runtime
}

func TestInformationalDependenciesDoNotBlockCreateOrClaim(t *testing.T) {
	h, fx, a, _, c, agent, runtimeID := dispatchFixture(t)
	request := dependencyRequest(fx, http.MethodPost, "", map[string]any{
		"title": "Run with unfinished informational prerequisites", "status": "todo",
		"assignee_type": "agent", "assignee_id": agent, "blocked_by": []string{a, c},
	}, "jwt")
	var issue IssueResponse
	testutil.Call(t, h.CreateIssueWithDependencies, request).Want(http.StatusCreated).JSON(&issue)
	view := dependencies(t, h, fx, issue.ID)
	if len(view.Unsatisfied) != 2 {
		t.Fatalf("informational prerequisites lost: %+v", view)
	}
	var taskID string
	fx.QueryRow(t, "SELECT id FROM agent_task_queue WHERE issue_id=$1 AND status='queued'", issue.ID).Scan(&taskID)
	task, err := h.TaskService.ClaimTaskForRuntime(context.Background(), parseUUID(runtimeID))
	if err != nil || task == nil || task.ID != parseUUID(taskID) {
		t.Fatalf("unfinished relations blocked upstream claim: task=%+v err=%v", task, err)
	}
}

func TestInformationalDependenciesAllowAssignmentAndEditing(t *testing.T) {
	h, fx, a, b, _, agent, _ := dispatchFixture(t)
	request := dependencyRequest(fx, http.MethodPut, b, map[string]any{"status": "todo", "assignee_type": "agent", "assignee_id": agent}, "task")
	testutil.Call(t, h.UpdateIssue, request).Want(http.StatusOK)
	if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b) != 1 {
		t.Fatal("ordinary assignment did not use upstream dispatch")
	}
	replaceDependencies(t, h, fx, b, []string{a}, "task", http.StatusOK)
	replaceDependencies(t, h, fx, b, []string{}, "pat", http.StatusOK)
	if len(dependencies(t, h, fx, b).BlockedBy) != 0 {
		t.Fatal("informational relations could not be removed")
	}
}

func TestInformationalDependenciesRetireExecutionOverrides(t *testing.T) {
	h, fx, _, b, _, _, _ := dispatchFixture(t)
	before, err := h.Queries.GetIssue(context.Background(), parseUUID(b))
	if err != nil {
		t.Fatal(err)
	}
	request := dependencyRequest(fx, http.MethodPatch, b, map[string]any{"title": "must not change", "dependency_override": map[string]string{"request_id": "old", "challenge": "old"}}, "jwt")
	testutil.Call(t, h.UpdateIssueWithDependencies, request).Want(http.StatusBadRequest)
	after, err := h.Queries.GetIssueInWorkspace(context.Background(), db.GetIssueInWorkspaceParams{ID: before.ID, WorkspaceID: before.WorkspaceID})
	if err != nil || after.Title != before.Title || after.Revision != before.Revision {
		t.Fatalf("retired execution override mutated an issue: %v", err)
	}
}
