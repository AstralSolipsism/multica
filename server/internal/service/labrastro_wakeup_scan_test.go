package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestWakeupFailedDispatchAdvancesScanOrder(t *testing.T) {
	f, s, issue, agent := conditionFixture(t)
	ctx := context.Background()
	w := wakeCreate(t, f, s, issue, WakeupInput{
		AgentID: agent, Kind: "event", EventTypes: []string{"comment.created"}, Instruction: "check", ExpiresInSeconds: 3600,
	})
	f.Exec(t, "UPDATE issue_wakeup SET expires_at=now()-interval '1 second',updated_at=now()-interval '1 day' WHERE id=$1", w.ID)
	before, err := f.q.LocklessWakeup(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}

	// Block dispatch before it can lock the rule or touch its scan order.
	// The rule remains writable by the independent failure diagnostic.
	holder, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(ctx)
	if _, err := holder.Exec(ctx, "SELECT id FROM issue WHERE id=$1 FOR UPDATE NOWAIT", issue); err != nil {
		t.Fatal(err)
	}
	tickErr := s.TickWorkspaces(ctx, parseTestUUID(t, f.WorkspaceID))
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var lockErr *pgconn.PgError
	if !errors.As(tickErr, &lockErr) || lockErr.Code != "55P03" {
		t.Fatalf("expected dispatch lock timeout, got %v", tickErr)
	}
	after, err := f.q.LocklessWakeup(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.LastError.Valid || after.LastError.String == "" {
		t.Error("failed dispatch did not record its error")
	}
	if !after.UpdatedAt.Time.After(before.UpdatedAt.Time) {
		t.Errorf("failed dispatch kept scan priority: before=%v after=%v", before.UpdatedAt.Time, after.UpdatedAt.Time)
	}
}

func TestWakeupStaleSnapshotAdvancesScanOrder(t *testing.T) {
	for _, system := range []bool{false, true} {
		name := "user"
		if system {
			name = "system"
		}
		t.Run(name, func(t *testing.T) {
			f, s, issue, agent := conditionFixture(t)
			ctx := context.Background()
			var w db.IssueWakeup
			dispatch := s.dispatch
			if system {
				parent, err := f.q.GetIssue(ctx, issue)
				if err != nil {
					t.Fatal(err)
				}
				if err := s.ensureRule(ctx, parent); err != nil {
					t.Fatal(err)
				}
				w, err = f.q.GetSystemWakeup(ctx, db.GetSystemWakeupParams{IssueID: issue, SystemRule: systemRuleText(SystemRuleChildDone)})
				if err != nil {
					t.Fatal(err)
				}
				dispatch = s.dispatchSystem
			} else {
				w = wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Kind: "event", EventTypes: []string{"comment.created"}, Instruction: "check"})
			}
			// A rule edited after the batch snapshot is a successful no-op, but
			// it must still leave room for other ready rules in the next batch.
			f.Exec(t, "UPDATE issue_wakeup SET revision=revision+1,updated_at=now()-interval '1 day' WHERE id=$1", w.ID)
			before, err := f.q.LocklessWakeup(ctx, w.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := dispatch(ctx, w); err != nil {
				t.Fatal(err)
			}
			after, err := f.q.LocklessWakeup(ctx, w.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !after.UpdatedAt.Time.After(before.UpdatedAt.Time) || after.Revision != before.Revision {
				t.Fatalf("stale snapshot changed revision or kept scan priority: before=%+v after=%+v", before, after)
			}
			if n := f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE context->>'wakeup_id'=$1", util.UUIDToString(w.ID)); n != 0 {
				t.Fatalf("stale snapshot dispatched %d tasks", n)
			}
		})
	}
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
