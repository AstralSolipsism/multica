package main

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Assembly must register the wakeups without starting global queue consumers:
// cmd/server runs alongside packages whose tests own queued delivery fixtures.
// The event-to-send contract runs in the serial messagedelivery test group.
func TestMessageDeliverySubscribesSourceEvents(t *testing.T) {
	bus := events.New()
	h := &handler.Handler{Queries: db.New(nil)}
	assembleMessageDelivery(h, bus)
	if h.MessageDelivery == nil {
		t.Fatal("delivery service was not assembled")
	}
	for _, eventType := range []string{
		protocol.EventAutopilotRunDone,
		protocol.EventInboxNew,
		protocol.EventActivityCreated,
		protocol.EventCommentCreated,
	} {
		if n := bus.SubscriberCount(eventType); n != 1 {
			t.Errorf("%s: expected one delivery subscription, got %d", eventType, n)
		}
	}
}
