package main

import (
	"encoding/json"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func registerLabrastroYSKListeners(bus *events.Bus, b realtime.Broadcaster) {
	bus.Subscribe(protocol.EventIssueTipStateChanged, func(e events.Event) {
		payload, ok := e.Payload.(map[string]any)
		if !ok {
			return
		}
		userID, _ := payload["user_id"].(string)
		if userID == "" {
			return
		}
		frame, err := json.Marshal(map[string]any{
			"type": e.Type, "payload": payload, "actor_type": e.ActorType, "actor_id": e.ActorID,
		})
		if err != nil {
			return
		}
		realtime.M.RecordEvent(e.Type)
		b.SendToUser(userID, frame)
	})
}
