package handler

// Exercise the actual daemon claim, including both grant and rule authority.

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestConversationEventWakeupClaimUsesGrantor(t *testing.T) {
	for _, mode := range []string{"allowed", "creator-lost-invocation", "grant-revoked", "wrong-rule-evidence"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			grantor := dbfx.User(t, "E3h grantor", "claim-"+mode+"@example.test")
			dbfx.Member(t, testWorkspaceID, grantor, "member")
			runtime := dbfx.Runtime(t, "e3h runtime")
			extAgent := dbfx.Agent(t, "e3h ext agent", runtime, testutil.Cols{"owner_id": grantor})
			root := dbfx.Task(t, extAgent, testutil.Cols{"runtime_id": runtime, "status": "running", "originator_source": "channel_integration", "originator_user_id": grantor, "accountable_user_id": grantor})
			config := fmt.Sprintf(`{"chat_id":"oc_e3h","conversation":{"id":%q,"authorized_by":%q,"scope":"workspace","chats":[{"chat_id":"oc_e3h","chat_type":"group"}]}}`, root, grantor)
			install := dbfx.Insert(t, "channel_installation", testutil.Cols{"workspace_id": testWorkspaceID, "agent_id": extAgent, "channel_type": "feishu", "installer_user_id": testUserID, "status": "active", "config": config})
			dbfx.InsertNoID(t, "channel_task_delivery", testutil.Cols{"task_id": root, "binding_id": root, "installation_id": install, "channel_type": "feishu", "channel_chat_id": "oc_e3h", "chat_type": "group", "route_revision": 1, "config": config}, "task_id=$1", root)
			target := dbfx.Agent(t, "e3h target", runtime, testutil.Cols{"permission_mode": "public_to"})
			dbfx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": target, "target_type": "workspace", "target_id": testWorkspaceID})
			issue := dbfx.Issue(t, "e3h issue", testutil.Cols{"status": "in_progress"})
			dbfx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
			dbfx.Cleanup(t, "DELETE FROM issue_wakeup WHERE issue_id=$1", issue)
			wid := createRule(t, issue, target, pgtype.UUID{}, service.WakeupInput{Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created"}, Instruction: "Handle"})
			commentOn(t, issue, "external comment", extAgent, root)
			tasks := service.NewTaskService(testHandler.Queries, testPool, testHandler.Hub, testHandler.Bus)
			if err := (&service.IssueWakeupService{Tasks: tasks}).TickWorkspaces(ctx, parseUUID(testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			var taskID, root2 string
			dbfx.QueryRow(t, "SELECT id::text, COALESCE(conversation_root_task_id::text,'') FROM agent_task_queue WHERE context->>'wakeup_id'=$1", wid).Scan(&taskID, &root2)
			dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'dispatched', dispatched_at = clock_timestamp() WHERE id = $1`, taskID)
			task, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			rt, err := testHandler.Queries.GetAgentRuntime(ctx, task.RuntimeID)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "creator-lost-invocation":
				dbfx.Exec(t, "UPDATE agent SET owner_id=$2,permission_mode='private' WHERE id=$1", target, grantor)
			case "grant-revoked":
				dbfx.Exec(t, "UPDATE channel_installation SET status='revoked' WHERE id=$1", install)
			case "wrong-rule-evidence":
				task.TriggerEvidenceRefID = parseUUID(root)
			}
			req := newDaemonTokenRequest("POST", "/claim", nil, testWorkspaceID, "e3h")
			h := *testHandler
			resp, _, _, _, _, failure := h.buildClaimedTaskResponse(req, &task, rt, uuidToString(task.RuntimeID), testWorkspaceID)
			var status, errMsg string
			dbfx.QueryRow(t, "SELECT status, COALESCE(error,'') FROM agent_task_queue WHERE id=$1", taskID).Scan(&status, &errMsg)
			if mode == "allowed" {
				if failure != nil || status == "failed" || root2 != root || uuidToString(task.OriginatorUserID) != grantor {
					t.Fatalf("grantor claim failed: %+v %s %q root=%s", failure, status, errMsg, root2)
				}
				if resp.Agent == nil {
					t.Fatal("claim lost execution agent")
				}
			} else if failure == nil || status != "failed" {
				t.Fatalf("unauthorized claim succeeded: %+v %s", failure, status)
			}
		})
	}
}
