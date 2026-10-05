package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
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
			if err := tx.QueryRow(ctx, "SELECT count(*) FROM issue_dependency_audit WHERE issue_id=$1", issue.ID).Scan(&audits); err != nil || audits != 1 {
				t.Fatalf("no-op relation replacement added an audit: count=%d, %v", audits, err)
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

func TestDependencyWriteResponseIncludesViewOnlyForCompoundEndpoint(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "Prerequisite")
	b := dependencyIssue(t, fx, "Dependent")
	var compound IssueResponse
	replaceDependencies(t, h, fx, b, []string{a}, "jwt", http.StatusOK).JSON(&compound)
	if compound.Dependencies == nil || len(compound.Dependencies.BlockedBy) != 1 || compound.Dependencies.BlockedBy[0].IssueID != a {
		t.Fatalf("compound PATCH omitted the updated dependencies.blocked_by: %+v", compound.Dependencies)
	}
	ordinary := testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"title": "Renamed"}, "jwt")).Want(http.StatusOK).Map()
	if _, present := ordinary["dependencies"]; present {
		t.Fatalf("ordinary PUT included dependencies: %v", ordinary["dependencies"])
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

func TestDependencyDeleteHookHoldsStructureLockUntilTransactionEnds(t *testing.T) {
	h, fx := dependencyFixture(t)
	id := dependencyIssue(t, fx, "Deleting")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	q := h.Queries.WithTx(tx)
	issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: parseUUID(id), WorkspaceID: parseUUID(fx.WorkspaceID)})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.beforeIssueDelete(ctx, q, []db.Issue{issue}); err != nil {
		t.Fatal(err)
	}
	conn, err := testPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	var locked bool
	defer func() {
		if locked {
			if _, err := conn.Exec(context.Background(), "SELECT pg_advisory_unlock(hashtextextended($1::uuid::text || ':issue_dependency', 0))", fx.WorkspaceID); err != nil {
				t.Errorf("release observer lock: %v", err)
			}
		}
	}()
	const tryLock = "SELECT pg_try_advisory_lock(hashtextextended($1::uuid::text || ':issue_dependency', 0))"
	if err := conn.QueryRow(ctx, tryLock, fx.WorkspaceID).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	if locked {
		t.Fatal("delete hook did not hold the structure lock against another connection")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, tryLock, fx.WorkspaceID).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	if !locked {
		t.Fatal("structure lock remained held after the delete transaction ended")
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
