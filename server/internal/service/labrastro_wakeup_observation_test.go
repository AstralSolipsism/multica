package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// Scope logTick's global scan so concurrent package tests cannot contribute
// unrelated backlog. All queries still run against PostgreSQL.
type workspaceWakeupScanDB struct {
	db.DBTX
	workspace pgtype.UUID
}

func (q workspaceWakeupScanDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.HasPrefix(sql, "-- name: ListPendingWakeupInputGroups ") {
		args[4] = []pgtype.UUID{q.workspace}
	}
	return q.DBTX.Query(ctx, sql, args...)
}

func observationSystemRule(t *testing.T, f principalFixture, issue pgtype.UUID, agent string) db.IssueWakeup {
	t.Helper()
	f.Exec(t, "UPDATE issue SET status='in_progress',assignee_type='agent',assignee_id=$2 WHERE id=$1", issue, agent)
	w, err := f.q.CreateSystemWakeup(context.Background(), db.CreateSystemWakeupParams{
		ID: dbid.NewV7(), WorkspaceID: parseTestUUID(t, f.WorkspaceID), IssueID: issue,
		EventTypes: []string{"issue.status_changed"}, Condition: childDoneCondition,
		Enabled: true, SystemRule: systemRuleText(SystemRuleChildDone),
	})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func observationReceipt(t *testing.T, f principalFixture, w db.IssueWakeup, key, payload string, age time.Duration) string {
	t.Helper()
	return f.Insert(t, "issue_wakeup_receipt", testutil.Cols{
		"id": dbid.NewV7(), "wakeup_id": w.ID, "revision": w.Revision, "event_key": key,
		"event_type": "comment.created", "payload": payload, "created_at": time.Now().Add(-age),
	})
}

func TestPendingWakeupParkedParentDoesNotWarn(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	ctx := context.Background()
	ws := parseTestUUID(t, f.WorkspaceID)
	w := observationSystemRule(t, f, issue, agent)
	f.Exec(t, "UPDATE issue SET status='backlog' WHERE id=$1", issue)
	// Discard setup hints so the test owns exactly one old input.
	f.Exec(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id=$1", w.ID)
	observationReceipt(t, f, w, "parked", "{}", 10*time.Minute)
	f.Exec(t, "UPDATE issue_wakeup SET next_fire_at=now()-interval '1 hour' WHERE id=$1", w.ID)
	s.Tasks.Queries = db.New(workspaceWakeupScanDB{DBTX: f.Pool, workspace: ws})

	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	for _, parked := range []bool{true, false} {
		if !parked {
			f.Exec(t, "UPDATE issue SET status='in_progress' WHERE id=$1", issue)
			f.Exec(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_key<>'parked'", w.ID)
		}
		p, err := s.pendingInputs(ctx, []pgtype.UUID{ws}, 1)
		if err != nil {
			t.Fatal(err)
		}
		if parked && (p.Held != 1 || p.OldestReady.Valid) {
			t.Fatalf("parked parent: %+v, want one held input", p)
		}
		if !parked && (p.Held != 0 || !p.OldestReady.Valid) {
			t.Fatalf("resumed parent: %+v, want ready input", p)
		}
		inputs, err := f.q.ListInputWakeups(ctx, db.ListInputWakeupsParams{WorkspaceIds: []pgtype.UUID{ws}, SkipIds: []pgtype.UUID{}, RowLimit: 10})
		if err != nil {
			t.Fatal(err)
		}
		due, err := f.q.ListDueWakeups(ctx, db.ListDueWakeupsParams{WorkspaceIds: []pgtype.UUID{ws}, SkipIds: []pgtype.UUID{}, RowLimit: 10})
		if err != nil {
			t.Fatal(err)
		}
		want := 1
		if parked {
			want = 0
		}
		if len(inputs) != want || len(due) != want {
			t.Fatalf("parked=%v: input/due candidates=%d/%d, want %d", parked, len(inputs), len(due), want)
		}
		logs.Reset()
		s.logTick(ctx, time.Now(), 0, 0, "drained", 0)
		var entry struct {
			Level string `json:"level"`
			Scan  string `json:"pending_scan"`
			Age   *int64 `json:"oldest_ready_input_age_s"`
			Held  int    `json:"held_inputs"`
		}
		if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
			t.Fatalf("decode log: %v: %s", err, logs.String())
		}
		if entry.Scan != "complete" {
			t.Fatalf("incomplete scan: %s", logs.String())
		}
		if parked && (entry.Level != "INFO" || entry.Age != nil || entry.Held != 1) {
			t.Fatalf("parked parent warned: %s", logs.String())
		}
		if !parked && (entry.Level != "WARN" || entry.Age == nil || *entry.Age < 9*60 || entry.Held != 0) {
			t.Fatalf("resumed backlog did not warn: %s", logs.String())
		}
	}
}

func TestPendingWakeupInputsMatchReceiptAuthority(t *testing.T) {
	for _, system := range []bool{false, true} {
		t.Run(fmt.Sprintf("system=%v", system), func(t *testing.T) {
			f, s, issue, agent := conditionFixture(t)
			ctx := context.Background()
			ws := parseTestUUID(t, f.WorkspaceID)
			grantor := f.member(t, "scan-grantor")
			extAgent := f.privateAgentOwnedBy(t, grantor, "external-source")
			f.Exec(t, "UPDATE agent SET permission_mode='public_to' WHERE id=$1", agent)
			f.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agent, "target_type": "workspace", "target_id": f.WorkspaceID})
			root := f.Task(t, extAgent, testutil.Cols{
				"runtime_id": testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + extAgent + "')"),
				"status":     "running", "originator_source": "channel_integration",
				"originator_user_id": grantor, "accountable_user_id": grantor,
			})
			config := fmt.Sprintf(`{"chat_id":"scan","conversation":{"id":%q,"authorized_by":%q,"scope":"workspace","chats":[{"chat_id":"scan","chat_type":"group"}]}}`, root, grantor)
			install := f.Insert(t, "channel_installation", testutil.Cols{
				"workspace_id": f.WorkspaceID, "agent_id": extAgent, "channel_type": "feishu",
				"installer_user_id": f.UserID, "status": "active", "config": config,
			})
			f.InsertNoID(t, "channel_task_delivery", testutil.Cols{
				"task_id": root, "binding_id": root, "installation_id": install, "channel_type": "feishu",
				"channel_chat_id": "scan", "chat_type": "group", "route_revision": 1, "config": config,
			}, "task_id=$1", root)
			var w db.IssueWakeup
			if system {
				w = observationSystemRule(t, f, issue, agent)
			} else {
				w = wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Kind: "event", Mode: "continuous",
					EventTypes: []string{"comment.created"}, Instruction: "follow up"})
				if w.CreatedBy == parseTestUUID(t, grantor) {
					t.Fatal("fixture did not separate creator from grantor")
				}
			}
			payload := fmt.Sprintf(`{"conversation_root_task_id":%q}`, root)
			observationReceipt(t, f, w, "external", payload, 20*time.Minute)
			read := func(held int, ready bool) pendingInputSummary {
				t.Helper()
				p, err := s.pendingInputs(ctx, []pgtype.UUID{ws}, 1)
				if err != nil || p.Held != held || p.OldestReady.Valid != ready {
					t.Fatalf("pending=%+v err=%v, want held=%d ready=%v", p, err, held, ready)
				}
				return p
			}
			read(0, true)
			queued := func(user, rootID string) string {
				t.Helper()
				cols := testutil.Cols{"issue_id": issue, "originator_user_id": user, "accountable_user_id": user,
					"runtime_id": testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + agent + "')")}
				if rootID != "" {
					cols["originator_source"], cols["delegated_from_task_id"] = "delegation", rootID
				}
				return f.Task(t, agent, cols)
			}
			// Neither the creator nor the grantor without the frozen root can
			// take this external input. Only the matching delegated run can.
			for _, user := range []string{f.UserID, grantor} {
				run := queued(user, "")
				read(0, true)
				f.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", run)
			}
			otherRoot := f.Task(t, extAgent, testutil.Cols{
				"runtime_id": testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + extAgent + "')"),
				"status":     "completed", "originator_source": "channel_integration",
				"originator_user_id": grantor, "accountable_user_id": grantor,
			})
			wrongRootRun := queued(grantor, otherRoot)
			read(0, true)
			f.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", wrongRootRun)
			run := queued(grantor, root)
			read(1, false)

			// One rule can contain both held external inputs and younger ready
			// first-party evidence. Read beyond a whole receipt page and keep
			// oldest_ready independent of the older held group.
			f.Exec(t, `INSERT INTO issue_wakeup_receipt(id,wakeup_id,revision,event_key,event_type,payload,created_at)
				SELECT gen_random_uuid(),$1,$2,'extra-'||n,'comment.created',$3::jsonb,now()-interval '20 minutes'
				FROM generate_series(1,$4::int) n`, w.ID, w.Revision, payload, wakeupPendingScanPage)
			readyID := observationReceipt(t, f, w, "first-party", `{"conversation_root_task_id":null}`, 5*time.Minute)
			p := read(wakeupPendingScanPage+1, true)
			if age, _ := p.age(time.Now()); age < 4*time.Minute || age > 6*time.Minute {
				t.Fatalf("held inputs distorted ready age: %v", age)
			}
			f.Exec(t, "UPDATE issue_wakeup_receipt SET processed_at=now() WHERE id=$1", readyID)
			read(wakeupPendingScanPage+1, false)
			f.Exec(t, "UPDATE agent_task_queue SET status='cancelled' WHERE id=$1", run)
			read(0, true)
			if n := f.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND processed_at IS NULL", w.ID); n != wakeupPendingScanPage+1 {
				t.Fatalf("observation consumed receipts: pending=%d", n)
			}
		})
	}
}

func TestPendingWakeupScanDoesNotLockReceipts(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	ctx := context.Background()
	w := observationSystemRule(t, f, issue, agent)
	observationReceipt(t, f, w, "locked", "{}", 10*time.Minute)
	holder, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(ctx)
	if _, err = f.q.WithTx(holder).ListPendingWakeupReceipts(ctx, db.ListPendingWakeupReceiptsParams{WakeupID: w.ID, Revision: w.Revision}); err != nil {
		t.Fatal(err)
	}
	reader, err := f.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Rollback(ctx)
	s.Tasks.Queries = f.q.WithTx(reader)
	scanCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	p, err := s.pendingInputs(scanCtx, []pgtype.UUID{parseTestUUID(t, f.WorkspaceID)}, 1)
	if err != nil || !p.OldestReady.Valid || p.Held != 0 {
		t.Fatalf("read-only scan behind a receipt lock: %+v, %v", p, err)
	}
	if err = reader.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// The same competing dispatch query must still wait for the held lock.
	contender, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer contender.Rollback(ctx)
	if _, err = contender.Exec(ctx, "SET LOCAL lock_timeout='25ms'"); err != nil {
		t.Fatal(err)
	}
	_, err = f.q.WithTx(contender).ListPendingWakeupReceipts(ctx, db.ListPendingWakeupReceiptsParams{WakeupID: w.ID, Revision: w.Revision})
	var lockErr *pgconn.PgError
	if !errors.As(err, &lockErr) || lockErr.Code != "55P03" {
		t.Fatalf("dispatch stopped locking receipts: %v", err)
	}
}

type dispatchOutcomeDB struct {
	db.DBTX
	touches int
}

func (q *dispatchOutcomeDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.HasPrefix(sql, "-- name: TouchWakeupDispatch ") {
		q.touches++
	}
	return q.DBTX.Exec(ctx, sql, args...)
}

func TestWakeupTickRotatesWithoutOuterTouch(t *testing.T) {
	for _, system := range []bool{false, true} {
		for _, fail := range []bool{false, true} {
			t.Run(fmt.Sprintf("system=%v/fail=%v", system, fail), func(t *testing.T) {
				f, s, issue, agent := conditionFixture(t)
				ctx := context.Background()
				ws := parseTestUUID(t, f.WorkspaceID)
				var w db.IssueWakeup
				if system {
					w = observationSystemRule(t, f, issue, agent)
				} else {
					w = wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Kind: "event",
						EventTypes: []string{"comment.created"}, Instruction: "first"})
				}
				next := wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Kind: "event",
					EventTypes: []string{"comment.created"}, Instruction: "next"})
				for _, rule := range []db.IssueWakeup{w, next} {
					observationReceipt(t, f, rule, "pending", "{}", time.Minute)
				}
				f.Exec(t, "UPDATE issue_wakeup SET updated_at=now()-interval '1 hour' WHERE id=$1", next.ID)
				// A stale snapshot succeeds without consuming inputs; it must
				// rotate just as a pre-rule-lock failure does.
				f.Exec(t, "UPDATE issue_wakeup SET revision=revision+1,updated_at=now()-interval '2 hours' WHERE id=$1", w.ID)
				probe := &dispatchOutcomeDB{DBTX: f.Pool}
				s.Tasks.Queries = db.New(probe)
				if fail {
					holder, err := f.Pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer holder.Rollback(ctx)
					if _, err = holder.Exec(ctx, "SELECT id FROM issue WHERE id=$1 FOR UPDATE", issue); err != nil {
						t.Fatal(err)
					}
				}
				errs := s.dispatchFromTick(ctx, w)
				if (len(errs) > 0) != fail {
					t.Fatalf("fail=%v: dispatch errors=%v", fail, errs)
				}
				if probe.touches != 0 {
					t.Fatalf("dispatch repeated %d outer scan-order writes", probe.touches)
				}
				for _, lane := range []string{"input", "due"} {
					// Keep both rules due to exercise the same ordering in
					// both candidate lanes without rewriting updated_at.
					f.Exec(t, "UPDATE issue_wakeup SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])", []pgtype.UUID{w.ID, next.ID})
					var rows []db.IssueWakeup
					var err error
					if lane == "input" {
						rows, err = f.q.ListInputWakeups(ctx, db.ListInputWakeupsParams{WorkspaceIds: []pgtype.UUID{ws}, SkipIds: []pgtype.UUID{}, RowLimit: 2})
					} else {
						rows, err = f.q.ListDueWakeups(ctx, db.ListDueWakeupsParams{WorkspaceIds: []pgtype.UUID{ws}, SkipIds: []pgtype.UUID{}, RowLimit: 2})
					}
					if err != nil || len(rows) != 2 || rows[0].ID != next.ID || rows[1].ID != w.ID {
						t.Fatalf("%s lane did not rotate past visited rule: %v, %v", lane, rows, err)
					}
				}
			})
		}
	}
}
