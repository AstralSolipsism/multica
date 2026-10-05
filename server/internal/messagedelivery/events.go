package messagedelivery

import (
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// SubscribeEvents wires persisted-source events to the decision loop. Handlers
// only signal a buffered channel, so publishing never waits on database work.
// Wakeups are latency hints: compensation recovers lost or coalesced events
// from persisted rows, including a crash before the decision was inserted.
func (s *Service) SubscribeEvents(bus *events.Bus) {
	for _, eventType := range []string{
		protocol.EventAutopilotRunDone,
		protocol.EventInboxNew,
		protocol.EventActivityCreated,
		protocol.EventCommentCreated,
	} {
		bus.Subscribe(eventType, func(events.Event) { s.NotifyDecide() })
	}
}
