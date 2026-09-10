package lark

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type conversationPatcherQueries struct {
	*fakePatcherQueries
	deny   error
	checks int
}

func (q *conversationPatcherQueries) AuthorizeConversationTask(context.Context, pgtype.UUID, pgtype.UUID) error {
	q.checks++
	return q.deny
}

func TestConversationOutboundUsesRealChatAndLiveConsent(t *testing.T) {
	for _, state := range []string{"allowed", "revoked", "unavailable", "missing_checker"} {
		t.Run(state, func(t *testing.T) {
			p, q, api := newTestPatcher(t)
			q.binding.ChannelChatID = "external/grant/group/oc_real/topic"
			q.binding.Config = []byte(`{"chat_id":"oc_real","conversation":{"id":"grant","authorized_by":"grantor","scope":"workspace"}}`)
			checked := &conversationPatcherQueries{fakePatcherQueries: q}
			switch state {
			case "revoked":
				checked.deny = channel.ErrConversationDenied
			case "unavailable":
				checked.deny = errors.New("database unavailable")
			}
			if state != "missing_checker" {
				p.queries = checked
			}
			err := p.processEvent(context.Background(), events.Event{
				Type:          protocol.EventChatDone,
				TaskID:        "ee333333-ee33-ee33-ee33-eeeeeeeeeeee",
				ChatSessionID: uuidString(q.binding.ChatSessionID),
				Payload:       protocol.ChatDonePayload{Content: "agent response"},
			})
			if state == "unavailable" || state == "missing_checker" {
				if err == nil {
					t.Fatal("authorization error was swallowed")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if state != "missing_checker" && checked.checks != 1 {
				t.Fatal("live consent was not checked")
			}
			if state == "allowed" {
				if len(api.textSent) != 1 || api.textSent[0].ChatID != "oc_real" {
					t.Fatalf("incorrect reply route: %+v", api.textSent)
				}
			} else if len(api.textSent) != 0 {
				t.Fatal("reply escaped revoked or unavailable authorization")
			}
		})
	}
}
