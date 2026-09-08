package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// These regressions use the suite test database. Run service and message-delivery
// suites sequentially: scanner cursors are global. No external sends are made.
type v1ReviewScanFixture struct {
	pool    *pgxpool.Pool
	q       *db.Queries
	fx      *testutil.Fixture
	ap      db.Autopilot
	run     db.AutopilotRun
	userID  pgtype.UUID
	agentID string
	runtime string
	issueID string
}

func v1ReviewScanSetup(t *testing.T, mode string) v1ReviewScanFixture {
	t.Helper()
	ctx := context.Background()
	pool := newResolveOriginatorPool(t)
	fx := testutil.New(pool, "", "")
	label := fmt.Sprintf("v1-scan-%d", time.Now().UnixNano())
	userID := fx.User(t, label, label+"@example.invalid")
	workspaceID := fx.Workspace(t, label, label)
	fx.UserID, fx.WorkspaceID = userID, workspaceID
	fx.Member(t, workspaceID, userID, "owner")
	runtimeID := fx.Runtime(t, label, testutil.Cols{"provider": "codex"})
	agentID := fx.Agent(t, label, runtimeID, testutil.Cols{"visibility": "workspace"})
	apID := fx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id": workspaceID, "title": label, "assignee_type": "agent",
		"assignee_id": agentID, "status": "active", "execution_mode": mode,
		"created_by_type": "member", "created_by_id": userID,
	})
	runCols := testutil.Cols{"autopilot_id": apID, "source": "manual", "status": "running"}
	issueID := ""
	if mode == "create_issue" {
		issueID = fx.Issue(t, label, testutil.Cols{
			"status": "in_progress", "origin_type": "autopilot",
			"assignee_type": "agent", "assignee_id": agentID,
		})
		runCols["status"], runCols["issue_id"] = "issue_created", issueID
	}
	runID := fx.Insert(t, "autopilot_run", runCols)
	q := db.New(pool)
	ap, err := q.GetAutopilot(ctx, util.MustParseUUID(apID))
	if err != nil {
		t.Fatal(err)
	}
	run, err := q.GetAutopilotRun(ctx, util.MustParseUUID(runID))
	if err != nil {
		t.Fatal(err)
	}
	fx.Exec(t, `DELETE FROM labrastro_message_scan_cursor`)
	t.Cleanup(func() { fx.Exec(t, `DELETE FROM labrastro_message_scan_cursor`) })
	return v1ReviewScanFixture{
		pool: pool, q: q, fx: fx, ap: ap, run: run,
		userID: util.MustParseUUID(userID), agentID: agentID, runtime: runtimeID, issueID: issueID,
	}
}

func (f v1ReviewScanFixture) syncer() *AutopilotService {
	return NewAutopilotService(f.q, f.pool, events.New(), nil)
}

func (f v1ReviewScanFixture) scan(t *testing.T, ctx context.Context) {
	t.Helper()
	scanner := messagedelivery.New(f.q)
	scanner.Tx, scanner.Syncer = f.pool, f.syncer()
	if err := scanner.ScanOnce(ctx); err != nil {
		t.Fatalf("ScanOnce failed before the behavior assertion: %v", err)
	}
}

// Fail the reverse-link update inside the dispatch transaction.
type v1ReviewMissingReverseLinkDB struct {
	*pgxpool.Pool
	failed bool
}

type v1ReviewRowError struct{ err error }

func (r v1ReviewRowError) Scan(...any) error { return r.err }

func (p *v1ReviewMissingReverseLinkDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "-- name: UpdateAutopilotRunRunning") {
		p.failed = true
		return v1ReviewRowError{errors.New("synthetic reverse-link write unavailable")}
	}
	return p.Pool.QueryRow(ctx, sql, args...)
}

type v1ReviewMissingReverseLinkTx struct {
	pgx.Tx
	owner *v1ReviewMissingReverseLinkDB
}

func (p *v1ReviewMissingReverseLinkDB) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &v1ReviewMissingReverseLinkTx{Tx: tx, owner: p}, nil
}

func (tx *v1ReviewMissingReverseLinkTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "-- name: UpdateAutopilotRunRunning") {
		tx.owner.failed = true
		return v1ReviewRowError{errors.New("synthetic reverse-link write unavailable")}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func TestAutopilotDispatchRollsBackWhenReverseLinkFails(t *testing.T) {
	f := v1ReviewScanSetup(t, "run_only")
	broken := &v1ReviewMissingReverseLinkDB{Pool: f.pool}
	tasks := NewTaskService(f.q, broken, nil, events.New())
	dispatcher := NewAutopilotService(f.q, broken, events.New(), tasks)
	err := dispatcher.dispatchRunOnly(context.Background(), f.ap, &f.run, f.userID)
	if err == nil || !broken.failed {
		t.Fatalf("dispatch did not exercise the transaction failure: %v", err)
	}
	if _, err := f.q.GetAutopilotTaskByRun(context.Background(), f.run.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("failed dispatch left a task: %v", err)
	}
	if f.run.TaskID.Valid {
		t.Fatal("failed dispatch exposed an uncommitted task")
	}
}

func TestV1ReviewScannerRecoversCommittedTaskWithoutRunReverseLink(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f := v1ReviewScanSetup(t, "run_only")
	taskService := &TaskService{Queries: f.q, TxStarter: f.pool, Bus: events.New()}
	dispatcher := NewAutopilotService(f.q, f.pool, events.New(), taskService)
	if err := dispatcher.dispatchRunOnly(ctx, f.ap, &f.run, f.userID); err != nil {
		t.Fatalf("real dispatch failed: %v", err)
	}
	// Reproduce the historical row shape left by pre-OL-41 servers, whose
	// reverse-link write followed the task commit. New dispatch is atomic, but
	// the scanner must continue recovering records created by older producers.
	f.fx.Exec(t, `UPDATE autopilot_run SET task_id = NULL WHERE id = $1`, f.run.ID)
	t.Cleanup(func() {
		f.fx.Exec(t, `DELETE FROM agent_task_queue WHERE autopilot_run_id = $1`, f.run.ID)
	})
	task, err := f.q.GetAutopilotTaskByRun(ctx, f.run.ID)
	if err != nil {
		t.Fatalf("real task INSERT was not committed: %v", err)
	}
	before, err := f.q.GetAutopilotRun(ctx, f.run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if before.TaskID.Valid || task.AutopilotRunID != before.ID {
		t.Fatal("fixture did not reproduce the one-sided persisted task link")
	}
	f.fx.Exec(t, `UPDATE agent_task_queue SET status = 'running' WHERE id = $1`, task.ID)
	task, err = f.q.CompleteAgentTask(ctx, db.CompleteAgentTaskParams{
		ID: task.ID, Result: []byte(`{"output":"synthetic successful task"}`),
	})
	if err != nil {
		t.Fatalf("real terminal task write: %v", err)
	}
	// Do not deliver the task-done event: the scanner must recover it.
	f.scan(t, ctx)
	afterScan, err := f.q.GetAutopilotRun(ctx, f.run.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The same persisted task is accepted by the real direct sync, establishing
	// the expected result independently of scanner selection.
	f.syncer().SyncRunFromTask(ctx, task)
	afterDirect, err := f.q.GetAutopilotRun(ctx, f.run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterDirect.Status != "completed" {
		t.Fatalf("control sync rejected persisted terminal task: %s", afterDirect.Status)
	}
	t.Logf("committed task=%s reverse_link_valid=%t scan=%s direct_sync=%s",
		task.Status, before.TaskID.Valid, afterScan.Status, afterDirect.Status)
	if afterScan.Status != "completed" {
		t.Fatalf("scanner missed real committed task with absent reverse link: scan=%s, direct_sync=%s",
			afterScan.Status, afterDirect.Status)
	}
}

func TestV1ReviewScannerDoesNotReplayFailureAfterSuccessfulRetry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f := v1ReviewScanSetup(t, "create_issue")
	failedID := f.fx.Task(t, f.agentID, testutil.Cols{
		"runtime_id": f.runtime, "issue_id": f.issueID, "status": "running",
		"created_at": testutil.Raw("now() - interval '2 minutes'"),
	})
	failed, err := f.q.FailAgentTask(ctx, db.FailAgentTaskParams{
		ID:            util.MustParseUUID(failedID),
		Error:         pgtype.Text{String: "synthetic first-attempt timeout", Valid: true},
		FailureReason: pgtype.Text{String: "timeout", Valid: true},
	})
	if err != nil {
		t.Fatalf("real first-attempt failure write: %v", err)
	}
	retryID := f.fx.Task(t, f.agentID, testutil.Cols{
		"runtime_id": f.runtime, "issue_id": f.issueID, "status": "running",
		"retry_of_task_id": failedID, "attempt": 2,
		"created_at": testutil.Raw("now() - interval '1 minute'"),
	})
	// At the original failure event, the retry is active and the existing
	// state machine correctly leaves the create_issue run awaiting its issue.
	f.syncer().SyncRunFromLinkedIssueTask(ctx, failed)
	whileRetryActive, err := f.q.GetAutopilotRun(ctx, f.run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if whileRetryActive.Status != "issue_created" {
		t.Fatalf("control active-retry guard failed: %s", whileRetryActive.Status)
	}
	completed, err := f.q.CompleteAgentTask(ctx, db.CompleteAgentTaskParams{
		ID: util.MustParseUUID(retryID), Result: []byte(`{"output":"synthetic retry succeeded"}`),
	})
	if err != nil {
		t.Fatalf("real retry completion write: %v", err)
	}
	active, err := f.q.HasActiveTaskForIssue(ctx, util.MustParseUUID(f.issueID))
	if err != nil || active || completed.Status != "completed" || !completed.CreatedAt.Time.After(failed.CreatedAt.Time) {
		t.Fatalf("fixture did not reach successful later retry with no active task: active=%t status=%s error=%v", active, completed.Status, err)
	}
	f.scan(t, ctx)
	afterScan, err := f.q.GetAutopilotRun(ctx, f.run.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("active_retry_guard=%s successor=%s no_active=%t scan=%s reason=%q",
		whileRetryActive.Status, completed.Status, !active, afterScan.Status, afterScan.FailureReason.String)
	if afterScan.Status != "issue_created" {
		t.Fatalf("scanner replayed historical failure after successful retry: status=%s reason=%q",
			afterScan.Status, afterScan.FailureReason.String)
	}
}

func TestContractScannerRecoversRunSideOnlyTaskLink(t *testing.T) {
	f := v1ReviewScanSetup(t, "run_only")
	taskID := f.fx.Task(t, f.agentID, testutil.Cols{"runtime_id": f.runtime, "status": "failed", "completed_at": testutil.Raw("now()")})
	f.fx.Exec(t, `UPDATE autopilot_run SET task_id=$1 WHERE id=$2`, taskID, f.run.ID)
	// Only the run's task_id is committed; task.autopilot_run_id is absent.
	f.scan(t, context.Background())
	run, err := f.q.GetAutopilotRun(context.Background(), f.run.ID)
	if err != nil || run.Status != "failed" || run.TaskID != util.MustParseUUID(taskID) {
		t.Fatalf("one-sided run link was not recovered: %s %v", run.Status, err)
	}
}

func TestContractHistoricalFailureCannotOutrunTerminalIssue(t *testing.T) {
	f := v1ReviewScanSetup(t, "create_issue")
	taskID := f.fx.Task(t, f.agentID, testutil.Cols{"runtime_id": f.runtime, "issue_id": f.issueID, "status": "failed", "completed_at": testutil.Raw("now()")})
	f.fx.Exec(t, `UPDATE issue SET status='done' WHERE id=$1`, f.issueID)
	task, err := f.q.GetAgentTask(context.Background(), util.MustParseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	f.syncer().SyncRunFromLinkedIssueTask(context.Background(), task)
	run, err := f.q.GetAutopilotRun(context.Background(), f.run.ID)
	if err != nil || run.Status != "completed" || !strings.Contains(string(run.Result), `"first_terminal_status": "done"`) {
		t.Fatalf("historical failure replaced issue outcome: %s %s %v", run.Status, run.Result, err)
	}
}
