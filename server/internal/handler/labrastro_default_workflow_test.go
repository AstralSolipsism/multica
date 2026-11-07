package handler

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestLabrastroDefaultWorkflowKeepsCustomStatusWrites(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	createTestCustomStatus(t, "backlog_2", "unstarted")
	createTestCustomStatus(t, "done_2", "done")
	createTestCustomStatus(t, "named_only", "started")
	createTestWorkflow(t, "Custom "+workflowTestSuffix(), "backlog_2", "done_2", "named_only")
	dbfx.Exec(t, `UPDATE issue_workflow SET steps='[{"status_key":"todo"},{"status_key":"blocked"},{"status_key":"done"},{"status_key":"cancelled"}]' WHERE workspace_id=$1 AND is_default`, testWorkspaceID)
	project := dbfx.Project(t, "Default project")
	// Negative numbers keep these historical fixtures outside the allocator's
	// reserved positive range used by the HTTP/service writes below.
	dbfx.Issue(t, "existing discussion", testutil.Cols{"status": "backlog_2", "number": -1})
	dbfx.Issue(t, "existing summary", testutil.Cols{"status": "done_2", "project_id": project, "number": -2})
	migration, err := os.ReadFile("../../migrations/9054_labrastro_default_workflow_keep_in_use_statuses.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, string(migration))
	for _, projectID := range []string{"", project} {
		for _, status := range []string{"backlog_2", "done_2"} {
			body := map[string]any{"title": fmt.Sprintf("http %s %s", projectID, status), "status": status}
			if projectID != "" {
				body["project_id"] = projectID
			}
			created := createIssueForTest(t, body)
			if created.Status != status {
				t.Fatalf("HTTP create status=%s, want %s", created.Status, status)
			}
			updateIssueForTest(t, created.ID, map[string]any{"status": "todo"}).Want(http.StatusOK)
			updateIssueForTest(t, created.ID, map[string]any{"status": status}).Want(http.StatusOK)
			actual, _, _ := issueStatusAndAssignee(t, created.ID)
			if actual != status {
				t.Fatalf("HTTP update status=%s, want %s", actual, status)
			}

			var projectUUID pgtype.UUID
			if projectID != "" {
				projectUUID = parseUUID(projectID)
			}
			// Channel creation uses this service boundary and must not reset the
			// repaired custom status to todo.
			result, err := testHandler.IssueService.Create(context.Background(), service.IssueCreateParams{
				WorkspaceID: parseUUID(testWorkspaceID), CreatorID: parseUUID(testUserID), CreatorType: "member",
				Title: fmt.Sprintf("channel %s %s", projectID, status), Status: status, Priority: "none", ProjectID: projectUUID,
			}, service.IssueCreateOpts{Platform: "lark"})
			if err != nil {
				t.Fatal(err)
			}
			dbfx.Cleanup(t, `DELETE FROM issue WHERE id=$1`, result.Issue.ID)
			if result.Issue.Status != status {
				t.Fatalf("channel create status=%s, want %s", result.Issue.Status, status)
			}
		}
	}
	testutil.Call(t, testHandler.CreateIssue, workflowRequest("POST", "/api/issues", map[string]any{
		"title": "not a Default state", "status": "named_only",
	})).Want(http.StatusBadRequest)
}
