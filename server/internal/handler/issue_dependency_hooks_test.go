package handler

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestDependencyWriteHooksUseCallerTransaction(t *testing.T) {
	for _, contentChanged := range []bool{false, true} {
		name := "relation only"
		if contentChanged {
			name = "content and relation"
		}
		t.Run(name, func(t *testing.T) {
			h, fx := dependencyFixture(t)
			a := dependencyIssue(t, fx, "Prerequisite")
			b := dependencyIssue(t, fx, "Dependent")
			ids := []pgtype.UUID{parseUUID(a)}
			write := service.DependencyWrite{BlockedBy: &ids, ExpectedVersion: dependencies(t, h, fx, b).DependencyVersion, IncludeView: true}
			ctx := service.WithDependencyWrite(context.Background(), write)
			tx, err := h.TxStarter.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			q := h.Queries.WithTx(tx)
			hook, err := h.beforeIssueWrite(ctx, q, parseUUID(fx.WorkspaceID), nil)
			if err != nil || hook == nil {
				t.Fatalf("before hook: %v", err)
			}
			params := db.GetIssueInWorkspaceParams{ID: parseUUID(b), WorkspaceID: parseUUID(fx.WorkspaceID)}
			original, err := q.GetIssueInWorkspace(ctx, params)
			if err != nil {
				t.Fatal(err)
			}
			issue := original
			if contentChanged {
				issue, err = q.UpdateIssue(ctx, db.UpdateIssueParams{ID: original.ID, Title: pgtype.Text{String: "New title", Valid: true}})
				if err != nil {
					t.Fatal(err)
				}
			}
			issue, snapshot, err := hook.AfterIssueWrite(ctx, q, issue, original.Revision)
			if err != nil {
				t.Fatal(err)
			}
			if issue.Revision != original.Revision+1 || len(snapshot.Model.Prerequisites(b)) != 1 {
				t.Fatalf("row/relation update did not advance revision once: %+v", issue)
			}
			var audits int
			if err := tx.QueryRow(ctx, "SELECT count(*) FROM issue_dependency_audit WHERE issue_id=$1", issue.ID).Scan(&audits); err != nil || audits != 1 {
				t.Fatalf("audit not persisted in caller transaction: count=%d, %v", audits, err)
			}
			write.ExpectedVersion = snapshot.Version(b)
			ctx = service.WithDependencyWrite(ctx, write)
			hook, err = h.beforeIssueWrite(ctx, q, original.WorkspaceID, nil)
			if err != nil {
				t.Fatal(err)
			}
			noOp, _, err := hook.AfterIssueWrite(ctx, q, issue, issue.Revision)
			if err != nil || noOp.Revision != issue.Revision {
				t.Fatalf("no-op relation replacement bumped revision: %+v, %v", noOp, err)
			}
			if err := tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			stored, err := h.Queries.GetIssueInWorkspace(ctx, params)
			if err != nil || stored.Revision != original.Revision || stored.Title != original.Title {
				t.Fatalf("row escaped caller rollback: %+v, %v", stored, err)
			}
			if n := fx.Count(t, "SELECT count(*) FROM issue_dependency WHERE issue_id=$1", b); n != 0 {
				t.Fatal("relation escaped caller rollback")
			}
			if n := fx.Count(t, "SELECT count(*) FROM issue_dependency_audit WHERE issue_id=$1", b); n != 0 {
				t.Fatal("audit escaped caller rollback")
			}
		})
	}
}

func TestDependencyWriteHookGuardsExplicitNullParent(t *testing.T) {
	ctx := context.Background()
	if issueWriteNeedsStructureLock(ctx, map[string]json.RawMessage{"title": json.RawMessage(`"rename"`)}) {
		t.Fatal("ordinary content edit requested a structure lock")
	}
	if !issueWriteNeedsStructureLock(ctx, map[string]json.RawMessage{"parent_issue_id": json.RawMessage(`null`)}) {
		t.Fatal("detaching a parent bypassed structural validation")
	}
}

func TestDependencyDeleteHookRejectsMixedWorkspacesBeforeLocking(t *testing.T) {
	h := &Handler{}
	if err := h.beforeIssueDelete(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
	issues := []db.Issue{{WorkspaceID: dbid.NewV7()}, {WorkspaceID: dbid.NewV7()}}
	if err := h.beforeIssueDelete(context.Background(), nil, issues); err == nil {
		t.Fatal("mixed-workspace delete reached the lock phase")
	}
}
