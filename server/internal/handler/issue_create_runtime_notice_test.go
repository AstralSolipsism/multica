package handler

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestIssueCreateDSHProfileNoticeWithAtomicAdmission(t *testing.T) {
	for _, status := range []string{"todo", "backlog"} {
		t.Run(status, func(t *testing.T) {
			h, fx := dependencyFixture(t)
			runtimeID := fx.Runtime(t, "DSH missing profile", testutil.Cols{
				"provider": "dsh", "status": "offline",
				"metadata": `{"offline_reason":{"code":"dsh_profile","detail":"the Multica runtime profile is not installed","repair":{"package":"DeepSeek Harness runtime profile"}}}`,
			})
			agentID := fx.Agent(t, "DSH assignee", runtimeID)
			result, err := h.IssueService.Create(context.Background(), service.IssueCreateParams{
				WorkspaceID: parseUUID(fx.WorkspaceID), Title: "DSH assignment", Status: status, Priority: "none",
				AssigneeType: pgtype.Text{String: "agent", Valid: true}, AssigneeID: parseUUID(agentID),
				CreatorType: "member", CreatorID: parseUUID(fx.UserID),
			}, service.IssueCreateOpts{})
			if err != nil {
				t.Fatal(err)
			}
			fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", result.Issue.ID)
			fx.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", result.Issue.ID)
			fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", result.Issue.ID)
			if result.AssignedTaskID.Valid || fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", result.Issue.ID) != 0 {
				t.Fatal("unusable DSH runtime received a task")
			}
			count := fx.Count(t, "SELECT count(*) FROM comment WHERE issue_id=$1 AND author_type='system'", result.Issue.ID)
			if status == "backlog" {
				if count != 0 {
					t.Fatal("backlog creation should not attempt a dispatch or emit a repair notice")
				}
				return
			}
			if count != 1 {
				t.Fatalf("expected one repair notice, got %d", count)
			}
			var content string
			fx.QueryRow(t, "SELECT content FROM comment WHERE issue_id=$1 AND author_type='system'", result.Issue.ID).Scan(&content)
			if !strings.Contains(content, "runtime profile") {
				t.Fatalf("missing DSH repair guidance: %s", content)
			}
		})
	}
}
