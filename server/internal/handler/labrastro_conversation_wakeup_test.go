package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestConversationWakeupClaimKeepsExternalTrustBoundary(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	root := f.task(t)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", root.ID)
	svc := service.IssueWakeupService{Tasks: f.h.TaskService}
	w, err := svc.Create(context.Background(), parseUUID(f.issue), root.OriginatorUserID, root.ID, service.WakeupInput{
		AgentID: f.agent, Kind: "every", IntervalSeconds: 600, Instruction: "Follow up on the external request",
	})
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup WHERE id=$1", w.ID)
	dbfx.Cleanup(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id=$1", w.ID)
	taskID := dbfx.Task(t, f.agent, testutil.Cols{
		"runtime_id": root.RuntimeID, "issue_id": f.issue, "status": "dispatched", "dispatched_at": testutil.Raw("now()"),
		"originator_source": "trigger_owner", "originator_user_id": root.OriginatorUserID,
		"accountable_user_id": root.AccountableUserID, "delegated_from_task_id": root.ID,
		"trigger_evidence_kind": "issue_wakeup", "trigger_evidence_ref_id": w.ID,
	})
	task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := f.h.Queries.GetAgentRuntime(context.Background(), task.RuntimeID)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/runtimes/claim", nil)
	resp, _, _, _, _, failure := f.h.buildClaimedTaskResponse(req, &task, runtime, uuidToString(runtime.ID), testWorkspaceID)
	if failure != nil || !strings.Contains(resp.Agent.Instructions, conversationInstructions) {
		t.Fatalf("external wakeup claim lost the trust boundary: %+v", failure)
	}
	if resp.ChatChannelType != "" || dbfx.Count(t, "SELECT count(*) FROM channel_task_delivery WHERE task_id=$1", task.ID) != 0 {
		t.Fatal("issue wakeup acquired an unsolicited external delivery route")
	}
	dbfx.Exec(t, "UPDATE channel_installation SET config=config-'conversation' WHERE id=$1", f.install)
	_, _, _, _, _, failure = f.h.buildClaimedTaskResponse(req, &task, runtime, uuidToString(runtime.ID), testWorkspaceID)
	if failure == nil {
		t.Fatal("revoked external wakeup reached the daemon")
	}
}
