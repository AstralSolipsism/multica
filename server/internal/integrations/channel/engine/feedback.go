package engine

import (
	"context"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

// FeedbackHandler runs after sender binding/membership and before any Chat
// creation. handled=false retains the channel's ordinary entry semantics.
type FeedbackHandler func(context.Context, ResolvedInstallation, ResolvedIdentity, channel.InboundMessage) (Result, bool, error)

func (r *Router) SetFeedbackHandler(handler FeedbackHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.feedback = handler
}
