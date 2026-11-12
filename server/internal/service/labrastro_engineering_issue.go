package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *IssueService) prepareBaselineThread(ctx context.Context, q *db.Queries, p *IssueCreateParams, opts IssueCreateOpts) (IssueCreateResult, bool, error) {
	if !opts.BaselineThreadID.Valid {
		return IssueCreateResult{}, false, nil
	}
	issue, err := s.prepareWikiCarrier(ctx, q, p, opts)
	if err != nil {
		return IssueCreateResult{}, true, err
	}
	if issue != nil {
		return IssueCreateResult{Issue: *issue}, true, nil
	}
	return IssueCreateResult{}, false, nil
}

// Serializes carrier creation against other mentions, thread deletion and
// project teardown. Reuse exits before numbering, broadcasts or enqueue.
func (s *IssueService) prepareWikiCarrier(ctx context.Context, q *db.Queries, p *IssueCreateParams, opts IssueCreateOpts) (*db.Issue, error) {
	if !opts.BaselineThreadID.Valid {
		return nil, nil
	}
	if _, err := q.LabrastroLockEngineeringProject(ctx, db.LabrastroLockEngineeringProjectParams{WorkspaceID: p.WorkspaceID, ID: p.ProjectID}); err != nil {
		return nil, err
	}
	thread, err := q.LabrastroLockBaselineThread(ctx, db.LabrastroLockBaselineThreadParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ID: opts.BaselineThreadID})
	if err != nil {
		return nil, err
	}
	if thread.IssueID.Valid {
		issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: thread.IssueID})
		if err != nil {
			return nil, err
		}
		if issue.ProjectID != p.ProjectID {
			return nil, ErrProjectNotFound
		}
		return &issue, nil
	}
	def, err := s.createWorkflow(ctx, q, *p)
	if err != nil {
		return nil, err
	}
	steps := issueworkflow.Arrange(nil)
	if def != nil {
		steps = def.Steps
	}
	p.Status = ""
	for _, step := range steps {
		category := issuestatus.Effective(ctx, q, p.WorkspaceID, step.StatusKey)
		if (category == "backlog" || category == "todo") && (!issueworkflow.AcceptsHandoff(step.StatusKey) || !step.HandsOff()) {
			p.Status = step.StatusKey
			break
		}
	}
	if p.Status == "" {
		return nil, errors.New("baseline carrier requires an unstarted workflow step without a handler")
	}
	p.AssigneeID, p.AssigneeType = pgtype.UUID{}, pgtype.Text{}
	p.AllowDuplicate = true
	return nil, nil
}

func bindBaselineThread(ctx context.Context, q *db.Queries, issue db.Issue, opts IssueCreateOpts) error {
	if !opts.BaselineThreadID.Valid {
		return nil
	}
	return q.LabrastroBindBaselineThread(ctx, db.LabrastroBindBaselineThreadParams{WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID, ID: opts.BaselineThreadID, IssueID: issue.ID})
}
