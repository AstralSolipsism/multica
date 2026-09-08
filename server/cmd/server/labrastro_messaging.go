package main

// labrastro_messaging.go — assembly for the Labrastro message-delivery
// module (OL-25). This is the ONE place that wires the module to the rest
// of the server: main.go and router.go keep only the start/join calls, so
// the next upstream sync has a single file to re-check for this feature.

import (
	"log/slog"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	messagedelivery "github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// assembleMessageDelivery builds the module and mounts it on the handler.
// Called from NewRouterWithOptions AFTER the lark transport is wired, so
// the sender sees the real availability of the Feishu integration.
//
// Sender selection is deliberate: the module sends ONLY through the lark
// installation service + the optional DeliveryAPIClient capability. A
// deployment without MULTICA_LARK_SECRET_KEY gets a nil sender — deliveries
// then fail with the stable sender_unavailable code instead of silently
// dropping or pretending to succeed. No other channel is widened.
func assembleMessageDelivery(h *handler.Handler, bus *events.Bus) {
	if h == nil || h.Queries == nil {
		return
	}
	svc := messagedelivery.New(h.Queries)
	svc.AppURL = appURLFromEnv()
	// Terminal-state compensation reuses the EXISTING autopilot sync; the
	// module runs no second state machine.
	svc.Syncer = h.AutopilotService
	if h.LarkInstallations != nil {
		if client, ok := h.LarkAPIClient.(lark.DeliveryAPIClient); ok {
			svc.Sender = lark.NewDeliverySender(h.LarkInstallations, client)
		} else {
			slog.Warn("messagedelivery: lark client lacks the delivery capability; sends will fail as unavailable")
		}
	} else {
		slog.Info("messagedelivery: lark integration not configured; deliveries will be recorded but not sent")
	}

	// EventBus wakeup: a latency hint only. The subscription body touches
	// nothing but the notify channel — publishing stays on the run-sync
	// goroutine — and every wakeup the channel drops is recovered by the
	// compensation scanner, which re-derives the missing set from
	// persisted rows.
	bus.Subscribe(protocol.EventAutopilotRunDone, func(events.Event) {
		svc.Notify()
	})

	h.MessageDelivery = svc
}
