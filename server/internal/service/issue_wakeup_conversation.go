package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// A wakeup stores the original external root independently of source task
// retention. Its creator's current member rights alone are not sufficient.
func (s *IssueWakeupService) authorizeWakeup(ctx context.Context, q *db.Queries, w db.IssueWakeup, agent db.Agent) error {
	if err := s.authorize(ctx, q, w.WorkspaceID, w.CreatedBy, agent); err != nil {
		return err
	}
	err := channel.AuthorizeConversationTask(ctx, q, db.AgentTaskQueue{
		AgentID: w.AgentID, OriginatorUserID: w.CreatedBy,
		ConversationRootTaskID: w.ConversationRootTaskID,
	}, w.WorkspaceID)
	if errors.Is(err, channel.ErrConversationDenied) {
		return ErrWakeupForbidden
	}
	return err
}

func wakeupSource(ctx context.Context, q *db.Queries, source pgtype.UUID) (db.AgentTaskQueue, error) {
	if !source.Valid {
		return db.AgentTaskQueue{}, nil
	}
	task, err := q.GetAgentTask(ctx, source)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrWakeupForbidden
	}
	return task, err
}

// In-place edits and manual triggers cannot put external instructions into a
// rule with another authority. Replacing a rule uses Save's revision fence and
// records the replacement's source instead.
func (s *IssueWakeupService) authorizeWakeupMutation(ctx context.Context, q *db.Queries, w db.IssueWakeup, source pgtype.UUID) error {
	task, err := wakeupSource(ctx, q, source)
	if err != nil {
		return err
	}
	if task.ConversationRootTaskID.Valid {
		if task.ConversationRootTaskID != w.ConversationRootTaskID || task.OriginatorUserID != w.CreatedBy {
			return ErrWakeupForbidden
		}
		if err := channel.AuthorizeConversationTask(ctx, q, task, w.WorkspaceID); err != nil {
			if errors.Is(err, channel.ErrConversationDenied) {
				return ErrWakeupForbidden
			}
			return err
		}
	}
	return nil
}
