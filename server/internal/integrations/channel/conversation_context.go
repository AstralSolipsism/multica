package channel

import (
	"context"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type conversationTaskKey struct{}

// WithConversationTask carries the authenticated external caller to the shared
// enqueue attribution boundary. It is set only after live grant validation.
// An issue's original creator is not the authority for a later external edit.
func WithConversationTask(ctx context.Context, task db.AgentTaskQueue) context.Context {
	if !task.ConversationRootTaskID.Valid {
		return ctx
	}
	return context.WithValue(ctx, conversationTaskKey{}, task)
}

func ConversationTaskFromContext(ctx context.Context) (db.AgentTaskQueue, bool) {
	task, ok := ctx.Value(conversationTaskKey{}).(db.AgentTaskQueue)
	return task, ok && task.ConversationRootTaskID.Valid
}
