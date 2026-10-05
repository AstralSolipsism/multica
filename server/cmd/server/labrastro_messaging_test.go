package main

import (
	"context"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type wakeupDeliverySender struct {
	sent chan messagedelivery.SendRequest
}

func (s wakeupDeliverySender) Send(ctx context.Context, req messagedelivery.SendRequest) (messagedelivery.SendResult, error) {
	s.sent <- req
	return messagedelivery.SendResult{ExternalMessageID: "om_run_done"}, nil
}

// The assembly must wake the decision loop, not merely the send pool. With a
// one-hour compensation interval this cannot pass by waiting for a scan tick.
func TestMessageDeliveryRunDoneWakesDecision(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	agent := fx.Agent(t, "delivery wakeup", "")
	inst := fx.Insert(t, "channel_installation", testutil.Cols{
		"workspace_id": testWorkspaceID, "agent_id": agent, "channel_type": "feishu",
		"config": testutil.Raw(`'{"app_id":"cli_wakeup"}'::jsonb`), "status": "active", "installer_user_id": testUserID,
	})
	ap := fx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id": testWorkspaceID, "title": "delivery wakeup", "assignee_id": agent,
		"status": "active", "execution_mode": "run_only", "created_by_type": "member", "created_by_id": testUserID,
	})
	fx.Insert(t, "channel_user_binding", testutil.Cols{
		"workspace_id": testWorkspaceID, "multica_user_id": testUserID, "installation_id": inst, "channel_type": "feishu", "channel_user_id": "ou_wakeup",
	})
	fx.Insert(t, "labrastro_message_route", testutil.Cols{
		"id":           testutil.Raw("gen_random_uuid()"),
		"workspace_id": testWorkspaceID, "autopilot_id": ap, "installation_id": inst, "channel_type": "feishu",
		"target_type": "member", "target_user_id": testUserID, "target_key": "member:" + testUserID,
		"conditions": "success", "content_mode": "with_output", "enabled": true, "created_by": testUserID, "updated_by": testUserID,
	})
	run := fx.Insert(t, "autopilot_run", testutil.Cols{
		"autopilot_id": ap, "source": "schedule", "status": "completed", "completed_at": testutil.Raw("now()"),
		"result": testutil.Raw(`'{"output":"run_done report"}'::jsonb`),
	})
	fx.Cleanup(t, `DELETE FROM labrastro_message_delivery WHERE installation_id=$1`, inst)
	fx.Cleanup(t, `DELETE FROM labrastro_message_receipt WHERE installation_id=$1`, inst)
	bus := events.New()
	h := &handler.Handler{Queries: db.New(testPool), TxStarter: testPool}
	assembleMessageDelivery(h, bus)
	sent := make(chan messagedelivery.SendRequest, 2)
	svc := h.MessageDelivery
	svc.Sender = wakeupDeliverySender{sent: sent}
	svc.ScanEvery = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	go svc.Run(ctx)
	t.Cleanup(func() {
		cancel()
		if !svc.WaitWithTimeout(messagedelivery.ShutdownTimeout) {
			t.Error("worker did not stop")
		}
	})
	for i := 0; i < 2; i++ {
		bus.Publish(events.Event{Type: protocol.EventAutopilotRunDone, WorkspaceID: testWorkspaceID, Payload: map[string]any{"run_id": run}})
	}
	select {
	case req := <-sent:
		if req.InstallationID != inst {
			t.Fatalf("unexpected delivery: %+v", req)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("run_done did not decide and send before compensation tick")
	}
	cancel()
	if !svc.WaitWithTimeout(3 * time.Second) {
		t.Fatal("delivery did not drain")
	}
	var status string
	fx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE run_id=$1`, run).Scan(&status)
	if status != messagedelivery.DeliveryStatusSent {
		t.Fatalf("delivery status=%s", status)
	}
	if n := fx.Count(t, `SELECT count(*) FROM labrastro_message_delivery WHERE run_id=$1`, run); n != 1 {
		t.Fatalf("repeated event created %d decisions", n)
	}
}
