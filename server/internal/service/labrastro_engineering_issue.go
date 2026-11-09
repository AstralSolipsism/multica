package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Labrastro engineering carrier-issue hooks for IssueService.Create. They keep
// issue.go down to the option field and thin calls; the review-resume rules
// live in labrastro_baseline_annotations.go.

// prepareLabrastroEngineeringIssue resumes a durable baseline-annotation
// review when opts carries a batch ID. handled is true when the create is
// already complete (the batch had a carrier issue) or failed.
func prepareLabrastroEngineeringIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, opts IssueCreateOpts) (IssueCreateResult, bool, error) {
	if !opts.BaselineAnnotationBatchID.Valid {
		return IssueCreateResult{}, false, nil
	}
	existing, err := prepareBaselineAnnotationIssue(ctx, q, p, opts.BaselineAnnotationBatchID)
	if err != nil {
		return IssueCreateResult{}, true, err
	}
	if existing != nil {
		return *existing, true, nil
	}
	return IssueCreateResult{}, false, nil
}

// bindLabrastroEngineeringCarrier atomically attaches the review's carrier
// issue and enqueues its assigned task inside the create transaction. No-op
// without a batch ID.
func bindLabrastroEngineeringCarrier(ctx context.Context, s *IssueService, q *db.Queries, p IssueCreateParams, issue db.Issue, opts IssueCreateOpts) (db.AgentTaskQueue, error) {
	if !opts.BaselineAnnotationBatchID.Valid {
		return db.AgentTaskQueue{}, nil
	}
	if !s.shouldEnqueueAgentTaskWithQueries(ctx, q, issue) {
		return db.AgentTaskQueue{}, errors.New("baseline annotation agent unavailable")
	}
	if _, err := q.LabrastroSetAnnotationCarrier(ctx, db.LabrastroSetAnnotationCarrierParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ID: opts.BaselineAnnotationBatchID, IssueID: issue.ID}); err != nil {
		return db.AgentTaskQueue{}, err
	}
	return s.TaskService.EnqueueBaselineAnnotationInTx(ctx, q, issue, issue.AssigneeID, pgtype.UUID{})
}

// finalizeLabrastroEngineeringEnqueue broadcasts the queued review task after
// the transaction commits; ok is false when the create was not a carrier.
func finalizeLabrastroEngineeringEnqueue(ctx context.Context, s *IssueService, opts IssueCreateOpts, task db.AgentTaskQueue) (pgtype.UUID, bool) {
	if !opts.BaselineAnnotationBatchID.Valid {
		return pgtype.UUID{}, false
	}
	s.TaskService.FinalizeBaselineAnnotationEnqueue(ctx, task)
	return task.ID, true
}
