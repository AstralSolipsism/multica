package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestConversationCommentMergeKeepsAuthority(t *testing.T) {
	for _, tc := range []struct {
		name, pending, comment string
		merge                  bool
	}{
		{"member_into_external", "external", "member", false},
		{"external_into_member", "member", "external", false},
		{"different_external_roots", "external", "other", false},
		{"same_root", "external", "external", true},
		{"same_root_different_grantor", "wrong_grantor", "external", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newConversationFixture(t)
			f.msg.ReplyTo = nil
			f.ingest(t)
			root := f.task(t)
			ctx := context.Background()
			agent, err := f.h.Queries.GetAgent(ctx, parseUUID(f.agent))
			if err != nil {
				t.Fatal(err)
			}
			issueID := dbfx.Issue(t, tc.name)
			issue, err := f.h.Queries.GetIssue(ctx, parseUUID(issueID))
			if err != nil {
				t.Fatal(err)
			}
			thread := dbfx.Comment(t, issueID, "thread")
			commentCols := testutil.Cols{"parent_id": thread}
			if tc.comment != "member" {
				source := root.ID
				if tc.comment == "other" {
					source = parseUUID(dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": root.RuntimeID, "originator_source": "channel_integration", "originator_user_id": testUserID, "accountable_user_id": testUserID}))
					if err := f.h.Queries.CopyChannelTaskDelivery(ctx, db.CopyChannelTaskDeliveryParams{ChildTaskID: source, ParentTaskID: root.ID}); err != nil {
						t.Fatal(err)
					}
					dbfx.Cleanup(t, `DELETE FROM channel_task_delivery WHERE task_id=$1`, source)
				}
				commentCols["author_type"], commentCols["author_id"], commentCols["source_task_id"] = "agent", f.agent, source
			}
			commentID := dbfx.Comment(t, issueID, "new instruction", commentCols)
			cols := testutil.Cols{"runtime_id": root.RuntimeID, "issue_id": issueID, "trigger_comment_id": thread,
				"status": "queued", "originator_source": "comment_source", "originator_user_id": testUserID, "accountable_user_id": testUserID}
			if tc.pending != "member" {
				cols["delegated_from_task_id"] = root.ID
			}
			if tc.pending == "wrong_grantor" {
				user := dbfx.User(t, "Other grantor", issueID+"@merge.test")
				cols["originator_user_id"], cols["accountable_user_id"] = user, user
			}
			taskID := parseUUID(dbfx.Task(t, f.agent, cols))
			before, err := f.h.Queries.GetAgentTask(ctx, taskID)
			if err != nil {
				t.Fatal(err)
			}
			got := f.h.mergeCommentIntoPendingTask(ctx, issue, commentAgentTrigger{Agent: agent, Source: commentTriggerSourceConversation}, parseUUID(commentID), pgtype.Text{})
			if (got == commentMergeSucceeded) != tc.merge {
				t.Fatalf("merge=%v, want success=%v", got, tc.merge)
			}
			after, err := f.h.Queries.GetAgentTask(ctx, taskID)
			if err != nil {
				t.Fatal(err)
			}
			if after.ConversationRootTaskID != before.ConversationRootTaskID || after.OriginatorUserID != before.OriginatorUserID {
				t.Fatal("merge changed the frozen authority")
			}
			if !tc.merge && (after.TriggerCommentID != before.TriggerCommentID || len(after.CoalescedCommentIds) != 0) {
				t.Fatal("rejected merge mutated the pending task")
			}

			// The completion/retry handoff must obey the same boundary even when
			// it appends planned work without replacing the task's attribution.
			dbfx.Exec(t, `UPDATE agent_task_queue SET status='running' WHERE id=$1`, taskID)
			registered, err := f.h.registerPlannedCommentForActiveTask(ctx, issue, agent, parseUUID(commentID), pgtype.Text{})
			if err != nil {
				t.Fatal(err)
			}
			if registered != tc.merge {
				t.Fatalf("planned replay=%v, want %v", registered, tc.merge)
			}
		})
	}
}

func TestConversationShutdownRetryKeepsGrantAndChecksRevocation(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	root := f.task(t)
	ctx := context.Background()
	dbfx.Exec(t, `UPDATE agent_task_queue SET status='running', attempt=1, max_attempts=3 WHERE id=$1`, root.ID)
	for attempt := range 2 {
		_, transitioned, err := f.h.TaskService.FailTaskWithTransition(ctx, root.ID, "daemon shutdown", "", "", "", "runtime_recovery", false, "", "")
		if err != nil || transitioned != (attempt == 0) {
			t.Fatalf("failure report %d: transitioned=%v err=%v", attempt, transitioned, err)
		}
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE retry_of_task_id=$1`, root.ID); count != 1 {
		t.Fatalf("replayed shutdown created %d retries", count)
	}
	var childID pgtype.UUID
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE retry_of_task_id=$1`, root.ID).Scan(&childID)
	child, err := f.h.Queries.GetAgentTask(ctx, childID)
	if err != nil {
		t.Fatal(err)
	}
	if child.ConversationRootTaskID != root.ID || child.OriginatorUserID != root.OriginatorUserID {
		t.Fatal("shutdown retry lost frozen grantor/root")
	}
	delivery, err := f.h.Queries.GetChannelTaskDelivery(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	originalDelivery, err := f.h.Queries.GetChannelTaskDelivery(ctx, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if delivery.InstallationID != originalDelivery.InstallationID || delivery.ChannelChatID != originalDelivery.ChannelChatID || delivery.ChannelMessageID != originalDelivery.ChannelMessageID || string(delivery.Config) != string(originalDelivery.Config) {
		t.Fatal("retry changed delivery target")
	}
	runtime, err := f.h.Queries.GetAgentRuntime(ctx, root.RuntimeID)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/runtimes/claim", nil)
	if _, _, _, _, _, failure := f.h.buildClaimedTaskResponse(req, &child, runtime, uuidToString(runtime.ID), testWorkspaceID); failure != nil {
		t.Fatalf("authorized retry rejected: %+v", failure)
	}
	dbfx.Exec(t, `UPDATE channel_installation SET config=config-'conversation' WHERE id=$1`, f.install)
	if _, _, _, _, _, failure := f.h.buildClaimedTaskResponse(req, &child, runtime, uuidToString(runtime.ID), testWorkspaceID); failure == nil {
		t.Fatal("revoked retry reached the daemon")
	}
}

func TestConversationSubIssueClaimCarriesOnlySameWorkspaceParent(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	root := f.task(t)
	ctx := context.Background()
	parent := dbfx.Issue(t, "Parent context")
	issue := dbfx.Issue(t, "External child", testutil.Cols{"parent_issue_id": parent})
	taskID := dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": root.RuntimeID, "issue_id": issue,
		"originator_source": "delegation", "delegated_from_task_id": root.ID,
		"originator_user_id": testUserID, "accountable_user_id": testUserID})
	task, err := f.h.Queries.GetAgentTask(ctx, parseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := f.h.Queries.GetAgentRuntime(ctx, root.RuntimeID)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/runtimes/claim", nil)
	resp, _, _, _, _, failure := f.h.buildClaimedTaskResponse(req, &task, runtime, uuidToString(runtime.ID), testWorkspaceID)
	if failure != nil || resp.ParentIssue == nil || resp.ParentIssue.ID != parent {
		t.Fatalf("parent context: %+v failure=%+v", resp.ParentIssue, failure)
	}
	other := dbfx.Workspace(t, "Other workspace", "external-parent-test")
	foreign := dbfx.Issue(t, "Foreign parent", testutil.Cols{"workspace_id": other})
	dbfx.Exec(t, `UPDATE issue SET parent_issue_id=$2 WHERE id=$1`, issue, foreign)
	resp, _, _, _, _, failure = f.h.buildClaimedTaskResponse(req, &task, runtime, uuidToString(runtime.ID), testWorkspaceID)
	if failure != nil || resp.ParentIssue != nil {
		t.Fatalf("foreign parent leaked: %+v failure=%+v", resp.ParentIssue, failure)
	}
}
