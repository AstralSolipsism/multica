package handler

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestDependencyStructureWriteAllowsUnrelatedOrdinaryWrites(t *testing.T) {
	h, fx := dependencyFixture(t)
	other := dependencyIssue(t, fx, "Unrelated issue")
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if err := h.IssueService.Dependencies.LockWrite(ctx, q, parseUUID(fx.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.IssueService.Dependencies.LoadForWrite(ctx, q, parseUUID(fx.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"title", "status", "comment", "public_content"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			switch operation {
			case "public_content":
				row, err := h.Queries.GetIssue(ctx, parseUUID(other))
				if err != nil {
					t.Fatal(err)
				}
				description := "Public API description"
				if _, err := h.IssueService.UpdateContent(ctx, row, service.IssueContentPatch{Description: &description}); err != nil {
					t.Fatalf("public content update blocked by unrelated structure write: %v", err)
				}
			case "comment":
				r := dependencyRequest(fx, http.MethodPost, other, map[string]any{"content": "A comment during a structural edit"}, "jwt")
				requestCtx, requestCancel := context.WithTimeout(r.Context(), 2*time.Second)
				defer requestCancel()
				testutil.Call(t, h.CreateComment, r.WithContext(requestCtx)).Want(http.StatusCreated)
			default:
				body := map[string]any{"title": "Edited while structure is locked"}
				if operation == "status" {
					body = map[string]any{"status": "in_progress"}
				}
				r := dependencyRequest(fx, http.MethodPut, other, body, "jwt")
				requestCtx, requestCancel := context.WithTimeout(r.Context(), 2*time.Second)
				defer requestCancel()
				testutil.Call(t, h.UpdateIssue, r.WithContext(requestCtx)).Want(http.StatusOK)
			}
		})
	}
}

// Commit a concurrent request after the original request has read the issue,
// but before it starts its write transaction.
type dependencyWriteTestStarter struct {
	inner       txStarter
	beforeBegin func(context.Context)
}

func (s dependencyWriteTestStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	s.beforeBegin(ctx)
	return s.inner.Begin(ctx)
}

func TestDependencyStructureWriteAllowsConcurrentProjectDeletion(t *testing.T) {
	h, fx := dependencyFixture(t)
	project := fx.Project(t, "Project being deleted")
	projectIssues := []string{
		dependencyIssue(t, fx, "First project issue", testutil.Cols{"project_id": project}),
		dependencyIssue(t, fx, "Second project issue", testutil.Cols{"project_id": project}),
	}
	slices.Sort(projectIssues)
	parent := dependencyIssue(t, fx, "New parent")
	child := dependencyIssue(t, fx, "Reparented issue")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deletion, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	q := h.Queries.WithTx(deletion)
	if _, err := q.LockProjectForDelete(ctx, db.LockProjectForDeleteParams{ID: parseUUID(project), WorkspaceID: parseUUID(fx.WorkspaceID)}); err != nil {
		t.Fatal(err)
	}
	// Freeze project deletion after one cascade update. The old ordered full
	// scan locked the lower issue ID, then waited here; finishing the cascade
	// needed that lower ID and deadlocked with the structural writer.
	if _, err := deletion.Exec(ctx, "UPDATE issue SET project_id=NULL WHERE id=$1", projectIssues[1]); err != nil {
		t.Fatal(err)
	}
	conn, err := testPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	writer := *h
	writer.TxStarter = conn
	r := dependencyRequest(fx, http.MethodPut, child, map[string]any{"parent_issue_id": parent}, "jwt")
	requestCtx, requestCancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer requestCancel()
	done := make(chan *testutil.Response, 1)
	go func() { done <- testutil.Call(t, writer.UpdateIssue, r.WithContext(requestCtx)) }()
	var response *testutil.Response
	defer func() {
		requestCancel()
		if response == nil {
			<-done
		}
	}()
	// Advance only after the writer either completes or is demonstrably
	// waiting for this deletion transaction, never after an arbitrary sleep.
waitForWriter:
	for {
		select {
		case response = <-done:
			break waitForWriter
		case <-ctx.Done():
			t.Fatal("structural writer neither completed nor reached the deletion lock")
		default:
			var waiting bool
			if err := testPool.QueryRow(ctx, "SELECT $1::int = ANY(pg_blocking_pids($2))", deletion.Conn().PgConn().PID(), conn.Conn().PgConn().PID()).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break waitForWriter
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	deleteErr := q.DeleteProject(ctx, db.DeleteProjectParams{ID: parseUUID(project), WorkspaceID: parseUUID(fx.WorkspaceID)})
	if deleteErr == nil {
		deleteErr = deletion.Commit(ctx)
	} else {
		_ = deletion.Rollback(context.Background())
	}
	if response == nil {
		response = <-done
	}
	if deleteErr != nil {
		t.Fatalf("project deletion deadlocked or failed: %v", deleteErr)
	}
	response.Want(http.StatusOK)
	if count := fx.Count(t, "SELECT count(*) FROM issue WHERE project_id=$1", project); count != 0 {
		t.Fatal("project deletion did not detach all its issues")
	}
}

func TestDependencyOrdinaryWritesPreserveConcurrentNullableChanges(t *testing.T) {
	for _, batch := range []bool{false, true} {
		name := "single"
		if batch {
			name = "batch"
		}
		t.Run(name, func(t *testing.T) {
			h, fx := dependencyFixture(t)
			oldParent := dependencyIssue(t, fx, "Old parent")
			newParent := dependencyIssue(t, fx, "New parent")
			child := dependencyIssue(t, fx, "Child", testutil.Cols{"parent_issue_id": oldParent})
			project := fx.Project(t, "Concurrent project")
			writer := *h
			interleaved := false
			writer.TxStarter = dependencyWriteTestStarter{inner: h.TxStarter, beforeBegin: func(ctx context.Context) {
				if interleaved {
					return
				}
				interleaved = true
				// The first request already loaded/pre-filled its nullable fields.
				body := map[string]any{"parent_issue_id": newParent, "project_id": project, "stage": 2,
					"assignee_type": "member", "assignee_id": fx.UserID, "start_date": "2026-10-01", "due_date": "2026-10-10"}
				testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, child, body, "jwt")).Want(http.StatusOK)
				// Restoring the old parent would now create an ancestor dependency.
				replaceDependencies(t, h, fx, oldParent, []string{child}, "jwt", http.StatusOK)
			}}
			updates := map[string]any{"priority": "high", "due_date": nil}
			if batch {
				var result struct{ Updated int }
				testutil.Call(t, writer.BatchUpdateIssues, dependencyRequest(fx, http.MethodPost, "", map[string]any{"issue_ids": []string{child}, "updates": updates}, "jwt")).Want(http.StatusOK).JSON(&result)
				if result.Updated != 1 {
					t.Fatalf("batch updated %d issues", result.Updated)
				}
			} else {
				testutil.Call(t, writer.UpdateIssue, dependencyRequest(fx, http.MethodPut, child, updates, "jwt")).Want(http.StatusOK)
			}
			row, err := h.Queries.GetIssue(context.Background(), parseUUID(child))
			if err != nil {
				t.Fatal(err)
			}
			if !interleaved || row.ParentIssueID != parseUUID(newParent) || row.ProjectID != parseUUID(project) || !row.Stage.Valid || row.Stage.Int32 != 2 ||
				row.AssigneeType.String != "member" || row.AssigneeID != parseUUID(fx.UserID) || !row.StartDate.Valid || row.StartDate.Time.Format("2006-01-02") != "2026-10-01" {
				t.Fatalf("ordinary update overwrote concurrent nullable fields: %+v", row)
			}
			if row.Priority != "high" || row.DueDate.Valid {
				t.Fatal("explicit priority/deadline patch was not applied")
			}
			dependencies(t, h, fx, child) // The graph remains valid after the race.
		})
	}
}

func TestDependencyBatchReparentRejectsInheritedCycle(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	a1 := dependencyIssue(t, fx, "A child", testutil.Cols{"parent_issue_id": a})
	b := dependencyIssue(t, fx, "B")
	b1 := dependencyIssue(t, fx, "B child candidate")
	free := dependencyIssue(t, fx, "Valid batch candidate")
	replaceDependencies(t, h, fx, b, []string{a1}, "jwt", http.StatusOK)
	replaceDependencies(t, h, fx, a, []string{b1}, "jwt", http.StatusOK)
	var result struct{ Updated int }
	testutil.Call(t, h.BatchUpdateIssues, dependencyRequest(fx, http.MethodPost, "", map[string]any{
		"issue_ids": []string{b1, free}, "updates": map[string]any{"parent_issue_id": b, "title": "Accepted batch edit"},
	}, "jwt")).Want(http.StatusOK).JSON(&result)
	if result.Updated != 1 {
		t.Fatalf("batch must skip the inherited cycle and apply the valid entry: %+v", result)
	}
	for _, id := range []string{b1, free} {
		row, err := h.Queries.GetIssue(context.Background(), parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		if id == b1 && (row.ParentIssueID.Valid || row.Title != "B child candidate" || row.Revision != 1) {
			t.Fatal("invalid batch entry partially committed")
		}
		if id == free && (row.ParentIssueID != parseUUID(b) || row.Title != "Accepted batch edit") {
			t.Fatal("valid batch entry did not commit")
		}
	}
}

func TestDependencyRelationOnlyRevision(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "Prerequisite")
	b := dependencyIssue(t, fx, "Dependent")
	for _, tc := range []struct {
		refs     []string
		revision int64
	}{{[]string{a}, 2}, {[]string{a, a}, 2}, {[]string{}, 3}, {[]string{}, 3}} {
		var response IssueResponse
		replaceDependencies(t, h, fx, b, tc.refs, "jwt", http.StatusOK).JSON(&response)
		row, err := h.Queries.GetIssue(context.Background(), parseUUID(b))
		if err != nil || row.Revision != tc.revision || response.Revision != tc.revision {
			t.Fatalf("relation replacement %v: stored revision=%d response=%d want=%d err=%v", tc.refs, row.Revision, response.Revision, tc.revision, err)
		}
	}
	version := dependencies(t, h, fx, b).DependencyVersion
	var combined IssueResponse
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, map[string]any{
		"blocked_by": []string{a}, "title": "Content and relation", "expected_dependency_version": version,
	}, "jwt")).Want(http.StatusOK).JSON(&combined)
	if combined.Revision != 4 {
		t.Fatalf("combined edit advanced revision more than once: %d", combined.Revision)
	}
}

func TestDependencyOrdinaryCreateAndDeleteSkipSnapshot(t *testing.T) {
	h, fx := dependencyFixture(t)
	parent := dependencyIssue(t, fx, "Parent with historical invalid data")
	fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": parent, "depends_on_issue_id": parent, "type": "blocked_by"})
	noSnapshot := graphTestStarter{inner: h.TxStarter, beforeQuery: func(query string) error {
		if strings.Contains(query, "ListIssueDependencyNodes") {
			return errors.New("ordinary operation loaded a dependency snapshot")
		}
		return nil
	}}
	h.TxStarter = noSnapshot
	h.IssueService.TxStarter = noSnapshot
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := h.Queries.WithTx(tx).LockIssueDependencyStructure(ctx, parseUUID(fx.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	r := dependencyRequest(fx, http.MethodPost, "", map[string]any{"title": "New child", "parent_issue_id": parent, "status": "backlog"}, "jwt")
	deadline, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	var child IssueResponse
	testutil.Call(t, h.CreateIssue, r.WithContext(deadline)).Want(http.StatusCreated).JSON(&child)
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM issue WHERE id=$1", child.ID) })
	if child.ParentIssueID == nil || *child.ParentIssueID != parent {
		t.Fatal("ordinary child lost its parent")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, parent, nil, "jwt")).Want(http.StatusNoContent)
	row, err := h.Queries.GetIssue(ctx, parseUUID(child.ID))
	if err != nil || row.ParentIssueID.Valid {
		t.Fatalf("delete did not detach the surviving child: %v", err)
	}
	if count := fx.Count(t, "SELECT count(*) FROM issue_dependency WHERE issue_id=$1 OR depends_on_issue_id=$1", parent); count != 0 {
		t.Fatal("delete did not remove incident edges")
	}
}
