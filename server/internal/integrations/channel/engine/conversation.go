package engine

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

// ConversationHandler runs after installation, dedup and group addressing, but
// before member identity resolution. Participating channels persist the input,
// claim fence and normal Chat task together. Other channels return false.
type ConversationHandler func(ctx context.Context, inst ResolvedInstallation, msg channel.InboundMessage, claimToken pgtype.UUID, bareFresh, startChat bool, mediaSeconds float64) (result Result, handled bool, err error)

func (r *Router) SetConversationHandler(handler ConversationHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conversation = handler
}
