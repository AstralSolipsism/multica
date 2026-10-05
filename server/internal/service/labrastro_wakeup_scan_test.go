package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
