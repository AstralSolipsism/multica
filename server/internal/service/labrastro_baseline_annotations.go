package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

var ErrBaselineAnnotationBatchClosed = errors.New("baseline annotation batch closed")

// Called after the workspace lock and before issue creation. The project lock
// serializes retries with reviews, decisions and project deletion.
func prepareBaselineAnnotationIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, batchID pgtype.UUID) (*IssueCreateResult, error) {
	if _, err := q.LabrastroLockEngineeringProject(ctx, db.LabrastroLockEngineeringProjectParams{WorkspaceID: p.WorkspaceID, ID: p.ProjectID}); err != nil {
		return nil, err
	}
	b, err := q.LabrastroGetAnnotationBatch(ctx, db.LabrastroGetAnnotationBatchParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ID: batchID})
	if err != nil {
		return nil, err
	}
	if b.IssueID.Valid {
		i, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: b.IssueID})
		return &IssueCreateResult{Issue: i}, err
	}
	if b.ClosedAt.Valid {
		return nil, ErrBaselineAnnotationBatchClosed
	}
	if b.CarrierKind != "revision_issue" || b.AgentID != p.AssigneeID || b.CreatedByID != p.CreatorID || p.AssigneeType.String != "agent" || p.CreatorType != "member" {
		return nil, errors.New("invalid baseline annotation carrier")
	}
	return nil, nil
}

// Keep the task, review receipt and carrier atomic. The scoped service reuses
// assignment/mention attribution and runtime overlays; notifications wait for
// commit so a daemon cannot claim an incomplete review.
func (s *TaskService) EnqueueBaselineAnnotationInTx(ctx context.Context, q *db.Queries, issue db.Issue, agent, comment pgtype.UUID) (db.AgentTaskQueue, error) {
	scoped := &TaskService{Queries: q, Composio: s.Composio, FeatureFlags: s.FeatureFlags, deferEnqueueNotifications: true}
	if comment.Valid {
		return scoped.EnqueueTaskForMention(ctx, issue, agent, comment, OriginNamed)
	}
	return scoped.EnqueueTaskForIssue(ctx, issue)
}

func (s *TaskService) FinalizeBaselineAnnotationEnqueue(ctx context.Context, task db.AgentTaskQueue) {
	s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, task)
	s.NotifyTaskEnqueued(ctx, task)
}
