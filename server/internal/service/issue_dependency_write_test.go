package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestDependencyWriteHooksSkipOrdinaryWrites(t *testing.T) {
	s := &DependencyService{}
	ctx := context.Background()
	issue := db.Issue{ID: dbid.NewV7(), WorkspaceID: dbid.NewV7(), ParentIssueID: dbid.NewV7(), Revision: 7, Title: "Ordinary edit"}
	for _, tc := range []struct {
		name          string
		write         DependencyWrite
		parentTouched bool
	}{
		{name: "content or status update"},
		{name: "ordinary child create", write: DependencyWrite{Creating: true}, parentTouched: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// No queries are available: taking a lock or loading a graph fails
			// this test, even if a real database would make it appear harmless.
			hook, err := s.BeforeIssueWrite(ctx, nil, issue.WorkspaceID, tc.write, tc.parentTouched)
			if err != nil || hook != nil {
				t.Fatalf("ordinary write requested dependency work: %v, %v", hook, err)
			}
			written, snapshot, err := hook.AfterIssueWrite(ctx, nil, issue, issue.Revision)
			if err != nil || snapshot != nil || written.ID != issue.ID || written.Revision != issue.Revision || written.ParentIssueID != issue.ParentIssueID {
				t.Fatalf("ordinary row changed in the dependency hook: %+v, %v", written, err)
			}
		})
	}
}

func TestDependencyWriteContextIsRequestScoped(t *testing.T) {
	base := context.Background()
	ids := []pgtype.UUID{dbid.NewV7()}
	ctx := WithDependencyWrite(base, DependencyWrite{BlockedBy: &ids, IncludeView: true})
	if !DependencyWriteFromContext(ctx).NeedsStructureLock(false) || DependencyWriteFromContext(base).NeedsStructureLock(false) {
		t.Fatal("dependency intent escaped its request context")
	}
	if !DependencyWriteFromContext(base).NeedsStructureLock(true) {
		t.Fatal("an ordinary hierarchy edit bypassed the shared hook")
	}
}
