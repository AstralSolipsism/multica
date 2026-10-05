package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestExternalConversationMissingUncapturedChildSourceIsRejected(t *testing.T) {
	for _, backlog := range []bool{false, true} {
		t.Run(map[bool]string{false: "lock-timeout", true: "backlog"}[backlog], func(t *testing.T) {
			f := newExternalPolicyFixture(t, "root")
			agent := f.fx.Agent(t, "missing child source target", f.runtime)
			parent := policyWakeIssue(t, f, agent)
			if backlog {
				f.fx.Exec(t, "UPDATE issue SET status='backlog' WHERE id=$1", parent)
			}
			child := f.fx.Issue(t, "delegated child", testutil.Cols{"parent_issue_id": parent})
			acting := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "status": "running", "originator_source": "delegation", "delegated_from_task_id": f.root,
				"originator_user_id": testUserID, "accountable_user_id": testUserID})
			token := mintAgentTaskToken(t, f.agent, acting, testUserID)
			ctx := context.Background()
			holder, err := testPool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(ctx)
			if !backlog {
				if _, err = holder.Exec(ctx, "SELECT id FROM agent WHERE id=$1 FOR UPDATE", agent); err != nil {
					t.Fatal(err)
				}
			}
			req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+child, map[string]any{"status": "done"}), "Authorization", "Bearer "+token)
			testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
			// The root is deliberately absent, not a captured JSON null. The
			// delegated source is the only durable evidence the hint can resolve.
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt r JOIN issue_wakeup w ON w.id=r.wakeup_id WHERE w.issue_id=$1 AND r.processed_at IS NULL AND NOT (r.payload ? 'conversation_root_task_id') AND r.payload->'source_task_ids' @> to_jsonb(ARRAY[$2::text])", parent, acting); n != 1 {
				t.Fatalf("expected one uncaptured pending source, got %d", n)
			}
			f.fx.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", acting)
			if err = holder.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			if backlog {
				f.fx.Exec(t, "UPDATE issue SET status='in_progress' WHERE id=$1", parent)
			}
			if err := policyWakeups().TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", parent); n != 0 {
				t.Fatalf("missing external evidence became a first-party run: %d", n)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected'", parent); n != 1 {
				t.Fatal("missing source not durably rejected")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt r JOIN issue_wakeup w ON w.id=r.wakeup_id WHERE w.issue_id=$1 AND r.processed_at IS NULL", parent); n != 0 {
				t.Fatal("missing source left the parent wedged")
			}
		})
	}
}

func TestExternalConversationMixedConditionEvaluationIsIndivisible(t *testing.T) {
	for _, mode := range []string{"once-condition", "backlog-system"} {
		t.Run(mode, func(t *testing.T) {
			f, s, _, parent, agent := deniedReceiptFixture(t, []string{"comment.created"})
			ctx := context.Background()
			var w db.IssueWakeup
			if mode == "backlog-system" {
				f.fx.Exec(t, "UPDATE issue SET assignee_type='agent',assignee_id=$2,status='backlog' WHERE id=$1", parent, agent)
			} else {
				var err error
				w, err = s.Create(ctx, policyUUID(t, parent), policyUUID(t, testUserID), pgtype.UUID{}, service.WakeupInput{
					AgentID: agent, Kind: "event", Mode: "once", Instruction: "Continue when children finish", Condition: json.RawMessage(`{"type":"children_done"}`),
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			human := f.fx.Issue(t, "human contribution", testutil.Cols{"parent_issue_id": parent})
			external := f.fx.Issue(t, "external contribution", testutil.Cols{"parent_issue_id": parent})
			f.fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", human)
			req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+external, map[string]any{"status": "done"}), "Authorization", "Bearer "+f.token)
			testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
			if mode == "backlog-system" {
				var id string
				f.fx.QueryRow(t, "SELECT id::text FROM issue_wakeup WHERE issue_id=$1 AND system_rule='child_done'", parent).Scan(&id)
				w.ID = policyUUID(t, id)
				f.fx.Exec(t, "UPDATE issue SET status='in_progress' WHERE id=$1", parent)
			}
			for i := 0; i < 3; i++ {
				if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
					t.Fatal(err)
				}
				if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", parent); n != 0 {
					t.Fatal("mixed condition or causeless retry escaped external authorization")
				}
				if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup WHERE id=$1 AND enabled AND condition_state<>'' AND fire_count=0", w.ID); n != 1 {
					t.Fatal("denial lost condition fingerprint or fired/stopped rule")
				}
				if mode == "once-condition" {
					if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup WHERE id=$1 AND next_fire_at>now()", w.ID); n != 1 {
						t.Fatal("rejection cleared once condition's fallback polling")
					}
					f.fx.Exec(t, "UPDATE issue_wakeup SET next_fire_at=now()-interval '1 second' WHERE id=$1", w.ID)
				}
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='condition.met' AND processed_at IS NOT NULL AND task_id IS NULL AND payload->>'sources_incomplete'='true' AND payload->'source_task_ids' @> to_jsonb(ARRAY[$2::text])", w.ID, f.root); n != 1 {
				t.Fatal("combined human/external condition was not rejected as one receipt")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected' AND (details->>'receipt_count')::int=1", parent); n != 1 {
				t.Fatal("condition rejection retried or omitted")
			}
		})
	}
}
