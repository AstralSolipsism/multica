package engine

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

// ConversationHandler runs after installation, dedup and group addressing when
// the sender has no member identity. It must validate the explicit grant and
// the recorded grantor's live invocation rights before creating any session or
// storing input. A bound member's denied invocation must never fall through to
// this path. Participating channels persist input, claim fence and Chat task
// together. Other channels return false.
type ConversationHandler func(ctx context.Context, inst ResolvedInstallation, msg channel.InboundMessage, claimToken pgtype.UUID, bareFresh, startChat bool, mediaSeconds float64) (result Result, handled bool, err error)

func (r *Router) SetConversationHandler(handler ConversationHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conversation = handler
}
