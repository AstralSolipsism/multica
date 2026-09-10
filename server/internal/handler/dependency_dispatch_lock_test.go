package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/runtimeapps"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/featureflag"
)

// Return an observed waiter, including soft blockers ahead of it in the lock
// queue. This establishes the interleaving instead of hoping a sleep did so.
func dependencyWaiter(t *testing.T, ctx context.Context, blocker int) (int, string) {
	t.Helper()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int
		var statement string
		err := testPool.QueryRow(ctx, `SELECT pid,split_part(query,E'\n',1) FROM pg_stat_activity
			WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
			ORDER BY query_start LIMIT 1`, blocker).Scan(&pid, &statement)
		if err == nil {
			return pid, statement
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatal("expected overlapping lock wait: ", ctx.Err())
		case <-ticker.C:
		}
	}
}

func TestDependencyWaitingWriterPrecedesNewAdmissions(t *testing.T) {
	h, fx := dependencyFixture(t)
	issue := dependencyIssue(t, fx, "ordinary status write")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(ctx)
	if _, err = h.IssueService.Dependencies.LockAdmission(ctx, h.Queries.WithTx(first), parseUUID(fx.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	var firstPID int
	if err = first.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&firstPID); err != nil {
		t.Fatal(err)
	}
	written := make(chan error, 1)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		r := dependencyRequest(fx, http.MethodPatch, issue, map[string]any{"status": "todo"}, "jwt")
		requestCtx, stop := context.WithCancel(r.Context())
		stopCancel := context.AfterFunc(ctx, stop)
		defer stopCancel()
		defer stop()
		response := testutil.Call(t, h.UpdateIssue, r.WithContext(requestCtx))
		var err error
		if response.Code != http.StatusOK {
			err = fmt.Errorf("status write: HTTP %d: %s", response.Code, response.Text())
		}
		written <- err
	}()
	defer func() { cancel(); <-writerDone }()
	writerPID, statement := dependencyWaiter(t, ctx, firstPID)
	if !strings.Contains(statement, "LockIssueDependencyStructure ") {
		t.Fatalf("writer cannot reach the structure wait queue: %s", statement)
	}

	readerDone := make(chan struct{})
	read := make(chan error, 1)
	go func() {
		defer close(readerDone)
		read <- h.TaskService.WithIssueAdmission(ctx, parseUUID(fx.WorkspaceID), parseUUID(issue), func(*db.Queries) error { return nil })
	}()
	defer func() { cancel(); <-readerDone }()
	_, statement = dependencyWaiter(t, ctx, writerPID)
	if !strings.Contains(statement, "LockIssueDependencyStructureShared ") {
		t.Fatalf("new admission bypassed the waiting writer: %s", statement)
	}
	if err = first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-written; err != nil {
		t.Fatal(err)
	}
	if err = <-read; err != nil {
		t.Fatal(err)
	}
	if fx.Count(t, "SELECT count(*) FROM issue WHERE id=$1 AND status='todo'", issue) != 1 {
		t.Fatal("writer did not commit")
	}
}

func TestDependencyAdmissionFencesWorkspaceDeletion(t *testing.T) {
	h, fx := dependencyFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = h.IssueService.Dependencies.LockAdmission(ctx, h.Queries.WithTx(tx), parseUUID(fx.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	var pid int
	if err = tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		defer close(done)
		// Use the real deletion fence, without destroying fixture-owned rows.
		_, err := h.Queries.LockWorkspaceForDelete(ctx, parseUUID(fx.WorkspaceID))
		result <- err
	}()
	defer func() { cancel(); <-done }()
	_, statement := dependencyWaiter(t, ctx, pid)
	if !strings.Contains(statement, "LockWorkspaceForDelete ") {
		t.Fatalf("unexpected deletion waiter: %s", statement)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err != nil {
		t.Fatal(err)
	}
}

func TestDependencyAdmissionSavepointKeepsOuterTransaction(t *testing.T) {
	for _, commit := range []bool{false, true} {
		t.Run(fmt.Sprintf("commit=%t", commit), func(t *testing.T) {
			h, fx, a, b, c, agent, _ := dispatchFixture(t)
			fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			tx, err := testPool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			q := h.Queries.WithTx(tx)
			if err = h.IssueService.Dependencies.LockWrite(ctx, q, parseUUID(fx.WorkspaceID)); err != nil {
				t.Fatal(err)
			}
			issue, err := q.GetIssue(ctx, parseUUID(b))
			if err != nil {
				t.Fatal(err)
			}
			issue.AssigneeID, issue.AssigneeType = parseUUID(agent), pgtype.Text{String: "agent", Valid: true}
			svc := service.NewTaskService(q, tx, nil, h.TaskService.Bus)
			queued, err := svc.EnqueueTaskForIssue(ctx, issue)
			if err != nil {
				t.Fatal(err)
			}
			if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE id=$1", queued.ID) != 0 {
				t.Fatal("savepoint committed the caller's transaction")
			}
			var pid int
			if err = tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			mutated := make(chan error, 1)
			go func() {
				defer close(done)
				_, err := testPool.Exec(ctx, "UPDATE issue SET status='todo',revision=revision+1 WHERE id=$1", a)
				mutated <- err
			}()
			defer func() { cancel(); <-done }()
			dependencyWaiter(t, ctx, pid)
			if commit {
				err = tx.Commit(ctx)
			} else {
				err = tx.Rollback(ctx)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = <-mutated; err != nil {
				t.Fatal(err)
			}
			want := 0
			if commit {
				want = 1
			}
			if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE id=$1", queued.ID) != want {
				t.Fatal("queue row did not follow outer transaction settlement")
			}
		})
	}
}

type dependencyPausedOverlay struct {
	entered chan struct{}
	release chan struct{}
}

func (o dependencyPausedOverlay) BuildTaskOverlay(ctx context.Context, _ pgtype.UUID, _ db.Agent) (runtimeapps.MCPOverlayResult, error) {
	close(o.entered)
	select {
	case <-o.release:
		return runtimeapps.MCPOverlayResult{}, nil
	case <-ctx.Done():
		return runtimeapps.MCPOverlayResult{}, ctx.Err()
	}
}

func TestDependencyOverlayPrecedesLocksAndRechecksAdmission(t *testing.T) {
	for _, compound := range []bool{false, true} {
		t.Run(fmt.Sprintf("compound=%t", compound), func(t *testing.T) {
			h, fx, a, b, c, agent, _ := dispatchFixture(t)
			fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
			flags := featureflag.NewStaticProvider()
			flags.Set(featureflags.ComposioMCPApps, featureflag.Rule{Default: true})
			h.TaskService = service.NewTaskService(h.Queries, testPool, h.Hub, h.Bus)
			h.IssueService.TaskService = h.TaskService
			h.TaskService.FeatureFlags = featureflag.NewService(flags)
			overlay := dependencyPausedOverlay{entered: make(chan struct{}), release: make(chan struct{})}
			h.TaskService.Composio = overlay
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			before, err := h.Queries.GetIssue(ctx, parseUUID(b))
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			result := make(chan error, 1)
			go func() {
				defer close(done)
				var err error
				if compound {
					r := dependencyRequest(fx, http.MethodPatch, b, map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}, "task")
					requestCtx, stop := context.WithCancel(r.Context())
					stopCancel := context.AfterFunc(ctx, stop)
					defer stopCancel()
					defer stop()
					response := testutil.Call(t, h.UpdateIssue, r.WithContext(requestCtx))
					if response.Code != http.StatusConflict || !strings.Contains(response.Text(), "dependency_unsatisfied") {
						err = fmt.Errorf("compound admission: HTTP %d: %s", response.Code, response.Text())
					}
				} else {
					issue := before
					issue.AssigneeID, issue.AssigneeType = parseUUID(agent), pgtype.Text{String: "agent", Valid: true}
					_, got := h.TaskService.EnqueueTaskForIssue(ctx, issue)
					var dep *service.DependencyError
					if !errors.As(got, &dep) || dep.Code != "dependency_unsatisfied" {
						err = fmt.Errorf("enqueue did not recheck dependencies: %v", got)
					}
				}
				result <- err
			}()
			defer func() { cancel(); <-done }()
			select {
			case <-overlay.entered:
			case <-ctx.Done():
				t.Fatal("enabled overlay was not called")
			}
			// A real handler write must finish while external preparation is paused.
			r := dependencyRequest(fx, http.MethodPatch, a, map[string]any{"status": "todo"}, "jwt")
			deadline, _ := ctx.Deadline()
			requestCtx, stop := context.WithDeadline(r.Context(), deadline)
			defer stop()
			testutil.Call(t, h.UpdateIssue, r.WithContext(requestCtx)).Want(http.StatusOK)
			close(overlay.release)
			if err = <-result; err != nil {
				t.Fatal(err)
			}
			after, err := h.Queries.GetIssue(ctx, parseUUID(b))
			if err != nil {
				t.Fatal(err)
			}
			if after.Revision != before.Revision || after.AssigneeID != before.AssigneeID || after.Status != before.Status || fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b) != 0 {
				t.Fatal("stale overlay preparation bypassed admission or left mutation side effects")
			}
		})
	}
}
