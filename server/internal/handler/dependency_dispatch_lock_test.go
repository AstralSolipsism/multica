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
func dependencyWaiter(t *testing.T, ctx context.Context, blocker int, expected string) int {
	t.Helper()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int
		var statement string
		err := testPool.QueryRow(ctx, `SELECT pid,split_part(query,E'\n',1) FROM pg_stat_activity
			WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
			ORDER BY query_start LIMIT 1`, blocker).Scan(&pid, &statement)
		// The blocker and pg_stat_activity query can change between observations.
		// Establish both the wait and its intended phase before releasing a lock.
		if err == nil && strings.Contains(statement, expected) {
			return pid
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("expected overlapping lock wait for %s: %v (last query: %s)", expected, ctx.Err(), statement)
		case <-ticker.C:
		}
	}
}

func TestDependencyWaitingWriterPrecedesNewAdmissions(t *testing.T) {
	for _, field := range []string{"status", "title"} {
		for _, writers := range []int{1, 2} {
			t.Run(fmt.Sprintf("%s/writers=%d", field, writers), func(t *testing.T) { dependencyWaitingWriterPrecedesNewAdmissions(t, field, writers) })
		}
	}
}

func dependencyWaitingWriterPrecedesNewAdmissions(t *testing.T, field string, writers int) {
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
		r := dependencyRequest(fx, http.MethodPatch, issue, map[string]any{field: "todo"}, "jwt")
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
	writerPID := dependencyWaiter(t, ctx, firstPID, "LockIssueDependencyStructure ")
	var secondWrite chan error
	if writers == 2 {
		secondWrite = make(chan error, 1)
		secondDone := make(chan struct{})
		go func() {
			defer close(secondDone)
			r := dependencyRequest(fx, http.MethodPatch, issue, map[string]any{field: "todo"}, "jwt")
			requestCtx, stop := context.WithCancel(r.Context())
			stopCancel := context.AfterFunc(ctx, stop)
			defer stopCancel()
			defer stop()
			response := testutil.Call(t, h.UpdateIssue, r.WithContext(requestCtx))
			var err error
			if response.Code != http.StatusOK {
				err = fmt.Errorf("second writer: HTTP %d: %s", response.Code, response.Text())
			}
			secondWrite <- err
		}()
		defer func() { cancel(); <-secondDone }()
		writerPID = dependencyWaiter(t, ctx, writerPID, "LockIssueDependencyStructure ")
	}

	readerDone := make(chan struct{})
	read := make(chan error, 1)
	go func() {
		defer close(readerDone)
		read <- h.TaskService.WithIssueAdmission(ctx, parseUUID(fx.WorkspaceID), parseUUID(issue), func(*db.Queries) error { return nil })
	}()
	defer func() { cancel(); <-readerDone }()
	dependencyWaiter(t, ctx, writerPID, "LockIssueDependencyStructureShared ")
	if err = first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-written; err != nil {
		t.Fatal(err)
	}
	if secondWrite != nil {
		if err = <-secondWrite; err != nil {
			t.Fatal(err)
		}
	}
	if err = <-read; err != nil {
		t.Fatal(err)
	}
	row, err := h.Queries.GetIssue(ctx, parseUUID(issue))
	if err != nil || (field == "title" && row.Title != "todo") || (field == "status" && row.Status != "todo") {
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
	dependencyWaiter(t, ctx, pid, "LockWorkspaceForDelete ")
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err != nil {
		t.Fatal(err)
	}
}

func TestDependencyEnqueueDoesNotLockUnrelatedStatus(t *testing.T) {
	h, fx, a, b, c, agent, _ := dispatchFixture(t)
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
	unrelated := dependencyIssue(t, fx, "unrelated external status update")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	holder, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = h.Queries.WithTx(holder).LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{ID: parseUUID(unrelated), WorkspaceID: parseUUID(fx.WorkspaceID)}); err != nil {
		t.Fatal(err)
	}
	issue, err := h.Queries.GetIssue(ctx, parseUUID(b))
	if err != nil {
		t.Fatal(err)
	}
	issue.AssigneeID, issue.AssigneeType = parseUUID(agent), pgtype.Text{String: "agent", Valid: true}
	queued, err := h.TaskService.EnqueueTaskForIssue(ctx, issue)
	if err != nil {
		t.Fatalf("unrelated locked status prevented enqueue: %v", err)
	}
	if !queued.ID.Valid || fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE id=$1", queued.ID) != 1 {
		t.Fatal("enqueue did not commit exactly one task while unrelated row stayed locked")
	}
}

func TestDependencyClaimDoesNotLockUnrelatedStatus(t *testing.T) {
	h, fx, a, b, c, agent, _ := dispatchFixture(t)
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	issue, err := h.Queries.GetIssue(ctx, parseUUID(b))
	if err != nil {
		t.Fatal(err)
	}
	issue.AssigneeID, issue.AssigneeType = parseUUID(agent), pgtype.Text{String: "agent", Valid: true}
	queued, err := h.TaskService.EnqueueTaskForIssue(ctx, issue)
	if err != nil {
		t.Fatal(err)
	}
	unrelated := dependencyIssue(t, fx, "unrelated claim status")
	holder, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = holder.Exec(ctx, "UPDATE issue SET status='todo' WHERE id=$1", unrelated); err != nil {
		t.Fatal(err)
	}
	claimed, err := h.TaskService.ClaimTask(ctx, parseUUID(agent))
	if err != nil || claimed == nil || claimed.ID != queued.ID {
		t.Fatalf("unrelated status lock prevented the exact claim: %+v %v", claimed, err)
	}
}

func TestDependencyClaimDefersNewUnprotectedTarget(t *testing.T) {
	h, fx, a, b, c, agent, _ := dispatchFixture(t)
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
	other := dependencyIssue(t, fx, "new high priority target", testutil.Cols{"priority": "urgent"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	enqueue := func(id string) db.AgentTaskQueue {
		issue, err := h.Queries.GetIssue(ctx, parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		issue.AssigneeID, issue.AssigneeType = parseUUID(agent), pgtype.Text{String: "agent", Valid: true}
		queued, err := h.TaskService.EnqueueTaskForIssue(ctx, issue)
		if err != nil {
			t.Fatal(err)
		}
		return queued
	}
	first := enqueue(b)
	holder, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = holder.Exec(ctx, "UPDATE issue SET revision=revision+1 WHERE id=$1", a); err != nil {
		t.Fatal(err)
	}
	var pid int
	if err = holder.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	result := make(chan *db.AgentTaskQueue, 1)
	errors := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		claimed, err := h.TaskService.ClaimTask(ctx, parseUUID(agent))
		result <- claimed
		errors <- err
	}()
	defer func() { cancel(); <-done }()
	dependencyWaiter(t, ctx, pid, "LockIssueAdmissionNodes ")
	second := enqueue(other)
	if second.Priority <= first.Priority {
		t.Fatal("fixture did not make the new target the queue's preferred candidate")
	}
	if err = holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	claimed := <-result
	if err = <-errors; err != nil || claimed == nil || claimed.ID != first.ID {
		t.Fatalf("claim selected a target outside its status locks: %+v %v", claimed, err)
	}
	if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE id=$1 AND status='queued'", second.ID) != 1 {
		t.Fatal("new target was consumed or rejected instead of remaining queued")
	}
	fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", first.ID)
	claimed, err = h.TaskService.ClaimTask(ctx, parseUUID(agent))
	if err != nil || claimed == nil || claimed.ID != second.ID {
		t.Fatalf("fresh poll did not admit the deferred target: %+v %v", claimed, err)
	}
}

func TestDependencyClaimQuarantinesForeignStatusInputs(t *testing.T) {
	for _, input := range []string{"target", "ancestor", "prerequisite"} {
		t.Run(input, func(t *testing.T) {
			h, fx, a, b, c, agent, runtime := dispatchFixture(t)
			fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
			foreign := dbfx.Issue(t, "foreign status input")
			bad := foreign
			if input != "target" {
				bad = dependencyIssue(t, fx, "broken queued target")
				if input == "ancestor" {
					fx.Exec(t, "UPDATE issue SET parent_issue_id=$2 WHERE id=$1", bad, foreign)
				} else {
					fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": bad, "depends_on_issue_id": foreign, "type": "blocked_by"})
				}
			}
			broken := fx.Task(t, agent, testutil.Cols{"issue_id": bad, "runtime_id": runtime, "priority": 10})
			ready := fx.Task(t, agent, testutil.Cols{"issue_id": b, "runtime_id": runtime, "priority": 0})
			claimed, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
			if err != nil || claimed == nil || claimed.ID != parseUUID(ready) {
				t.Fatalf("foreign status inputs stopped queue scanning: %+v %v", claimed, err)
			}
			if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE id=$1 AND status='failed' AND failure_reason='dependency_data_unverified'", broken) != 1 {
				t.Fatal("broken target was not quarantined")
			}
		})
	}
}

func TestDependencyEnqueueRefreshesStatusAfterLock(t *testing.T) {
	for _, finalStatus := range []string{"done", "todo"} {
		t.Run(finalStatus, func(t *testing.T) {
			h, fx, a, b, c, agent, _ := dispatchFixture(t)
			initialStatus := "todo"
			if finalStatus == "todo" {
				initialStatus = "done"
			}
			fx.Exec(t, "UPDATE issue SET status=$2,revision=revision+1 WHERE id=$1", a, initialStatus)
			fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id=$1", c)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			holder, err := testPool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, "UPDATE issue SET status=$2,revision=revision+1 WHERE id=$1", a, finalStatus); err != nil {
				t.Fatal(err)
			}
			var pid int
			if err = holder.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				t.Fatal(err)
			}
			issue, err := h.Queries.GetIssue(ctx, parseUUID(b))
			if err != nil {
				t.Fatal(err)
			}
			issue.AssigneeID, issue.AssigneeType = parseUUID(agent), pgtype.Text{String: "agent", Valid: true}
			finished := make(chan struct{})
			result := make(chan error, 1)
			go func() {
				defer close(finished)
				_, err := h.TaskService.EnqueueTaskForIssue(ctx, issue)
				result <- err
			}()
			defer func() { cancel(); <-finished }()
			dependencyWaiter(t, ctx, pid, "LockIssueAdmissionNodes ")
			if err = holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-result
			wantTasks := 1
			if finalStatus == "todo" {
				wantTasks = 0
				var dep *service.DependencyError
				if !errors.As(err, &dep) || dep.Code != "dependency_unsatisfied" {
					t.Fatalf("stale completed status admitted execution: %v", err)
				}
			} else if err != nil {
				t.Fatalf("fresh completion was not observed: %v", err)
			}
			if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b) != wantTasks {
				t.Fatal("enqueue did not preserve atomic admission")
			}
		})
	}
}

func TestDependencyContentEditPreservesCurrentStructure(t *testing.T) {
	h, fx := dependencyFixture(t)
	oldParent := dependencyIssue(t, fx, "old parent")
	newParent := dependencyIssue(t, fx, "new parent")
	id := dependencyIssue(t, fx, "content target")
	fx.Exec(t, "UPDATE issue SET parent_issue_id=$2 WHERE id=$1", id, oldParent)
	ctx := context.Background()
	stale, err := h.Queries.GetIssue(ctx, parseUUID(id))
	if err != nil {
		t.Fatal(err)
	}
	agent := fx.Agent(t, "content edit assignee", fx.Runtime(t, "content edit fake runtime"))
	fx.Exec(t, "UPDATE issue SET parent_issue_id=$2,assignee_type='agent',assignee_id=$3,revision=revision+1 WHERE id=$1", id, newParent, agent)
	title := "edited title"
	updated, err := h.IssueService.UpdateContent(ctx, stale, service.IssueContentPatch{Title: &title})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ParentIssueID != parseUUID(newParent) || updated.AssigneeID != parseUUID(agent) || updated.AssigneeType.String != "agent" || updated.Title != title {
		t.Fatal("content edit restored stale hierarchy or assignment")
	}
	if _, err := h.IssueService.UpdateContent(ctx, stale, service.IssueContentPatch{Title: &title, ExpectedRevision: &stale.Revision}); !errors.Is(err, service.ErrIssueRevisionConflict) {
		t.Fatalf("stale content revision did not conflict: %v", err)
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
			dependencyWaiter(t, ctx, pid, "UPDATE issue SET status")
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
