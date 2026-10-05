package messagedelivery

import (
	"context"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// A one-hour scan interval makes this depend on the event waking decisions,
// not merely sends. This package runs serially because workers claim globally.
func TestRunDoneEventDecidesAndSends(t *testing.T) {
	fx := newMDFixture(t, "run-done-wakeup", nil)
	fx.bindMember(t, testUID, "ou_wakeup")
	fx.memberTargetRoute(t, "member", testUID, nil)
	run := fx.run(t, "completed", nil)
	sent := make(chan SendRequest, 2)
	svc := newTestService(contextDeliverySender(func(_ context.Context, req SendRequest) (SendResult, error) {
		sent <- req
		return SendResult{ExternalMessageID: "om_run_done"}, nil
	}), nil)
	svc.ScanEvery = time.Hour
	bus := events.New()
	svc.SubscribeEvents(bus)
	ctx, cancel := context.WithCancel(context.Background())
	go svc.Run(ctx)
	t.Cleanup(func() {
		cancel()
		if !svc.WaitWithTimeout(ShutdownTimeout) {
			t.Error("worker did not stop")
		}
	})
	for i := 0; i < 2; i++ {
		bus.Publish(events.Event{Type: protocol.EventAutopilotRunDone, WorkspaceID: testWSID, Payload: map[string]any{"run_id": run}})
	}
	select {
	case req := <-sent:
		if req.InstallationID != fx.install {
			t.Fatalf("unexpected delivery: %+v", req)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("run_done did not decide and send before compensation tick")
	}
	cancel()
	if !svc.WaitWithTimeout(3 * time.Second) {
		t.Fatal("delivery did not drain")
	}
	if status, _, _, _ := deliveryStatus(t, firstDeliveryForRun(t, run)); status != DeliveryStatusSent {
		t.Fatalf("delivery status=%s", status)
	}
	if n := countDeliveries(t, "run_id=$1", run); n != 1 {
		t.Fatalf("repeated event created %d decisions", n)
	}
}
