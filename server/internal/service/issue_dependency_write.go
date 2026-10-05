package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type dependencyWriteKey struct{}

// WithDependencyWrite carries resolved relation inputs across the ordinary issue
// pipeline. The transaction hooks below remain independent of HTTP handlers.
func WithDependencyWrite(ctx context.Context, write DependencyWrite) context.Context {
	return context.WithValue(ctx, dependencyWriteKey{}, write)
}

func DependencyWriteFromContext(ctx context.Context) DependencyWrite {
	write, _ := ctx.Value(dependencyWriteKey{}).(DependencyWrite)
	return write
}

func (s *IssueService) beforeIssueCreate(ctx context.Context, q *db.Queries, ws pgtype.UUID) (*IssueDependencyWrite, error) {
	write := DependencyWriteFromContext(ctx)
	write.Creating = true
	return s.Dependencies.BeforeIssueWrite(ctx, q, ws, write, false)
}

func (w DependencyWrite) NeedsStructureLock(parentTouched bool) bool {
	// A new leaf without explicit prerequisites cannot introduce a cycle.
	if w.Creating {
		return w.BlockedBy != nil
	}
	return parentTouched || w.IncludeView || w.BlockedBy != nil || w.ExpectedVersion != ""
}

// IssueDependencyWrite owns the before/after state of one transaction. Both
// single and batch updates use it; it never commits or publishes events.
type IssueDependencyWrite struct {
	service *DependencyService
	before  *DependencySnapshot
	write   DependencyWrite
}

// BeforeIssueWrite precedes attachment and issue row locks. Ordinary content
// writes need neither a structure lock nor a graph snapshot.
func (s *DependencyService) BeforeIssueWrite(ctx context.Context, q *db.Queries, ws pgtype.UUID, write DependencyWrite, parentTouched bool) (*IssueDependencyWrite, error) {
	if !write.NeedsStructureLock(parentTouched) {
		return nil, nil
	}
	if err := s.LockWrite(ctx, q, ws); err != nil {
		return nil, err
	}
	before, err := s.LoadForWrite(ctx, q, ws)
	if err != nil {
		return nil, err
	}
	return &IssueDependencyWrite{service: s, before: before, write: write}, nil
}

// AfterIssueWrite applies relations in the same transaction as the issue row.
// A relation-only update still advances revision exactly once. A nil hook is
// the ordinary-write path and performs no dependency work.
func (w *IssueDependencyWrite) AfterIssueWrite(ctx context.Context, q *db.Queries, issue db.Issue, previousRevision int64) (db.Issue, *DependencySnapshot, error) {
	if w == nil {
		return issue, nil, nil
	}
	after, changed, err := w.service.Apply(ctx, q, w.before, issue, w.write)
	if err != nil {
		return db.Issue{}, nil, err
	}
	if changed && !w.write.Creating && issue.Revision == previousRevision {
		issue, err = q.TouchIssueDependencyRevision(ctx, db.TouchIssueDependencyRevisionParams{WorkspaceID: issue.WorkspaceID, ID: issue.ID})
		if err != nil {
			return db.Issue{}, nil, err
		}
	}
	return issue, after, nil
}
