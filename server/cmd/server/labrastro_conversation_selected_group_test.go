package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestExternalConversationValidRootsDispatchSeparately(t *testing.T) {
	f, other := newExternalPolicyFixture(t, "root"), newExternalPolicyFixture(t, "root")
	agent := f.fx.Agent(t, "separate roots target", f.runtime)
	issue := policyWakeIssue(t, f, "")
	s, ctx := policyWakeups(), context.Background()
	w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, service.WakeupInput{
		AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created", "issue.updated"}, Instruction: "Separate roots",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.fx.Comment(t, issue, "root one", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
	req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+issue, map[string]any{"title": "Root two"}), "Authorization", "Bearer "+other.token)
	testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
	for _, root := range []string{f.root, other.root} {
		if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
			t.Fatal(err)
		}
		var note string
		f.fx.QueryRow(t, "SELECT handoff_note FROM agent_task_queue WHERE context->>'wakeup_id'=$1 AND status='queued' AND conversation_root_task_id=$2 AND originator_user_id=$3", util.UUIDToString(w.ID), root, testUserID).Scan(&note)
		if strings.Contains(note, f.root) == strings.Contains(note, other.root) {
			t.Fatalf("expected exactly one root in evidence: %s", note)
		}
		if root == f.root {
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='issue.updated' AND processed_at IS NULL", w.ID); n != 1 {
				t.Fatal("second root merged into first queued task")
			}
		}
		f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE context->>'wakeup_id'=$1", util.UUIDToString(w.ID))
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected'", issue); n != 0 {
		t.Fatal("individually valid roots were rejected")
	}
}

func TestExternalConversationGroupsRespectFiringLimits(t *testing.T) {
	for _, mode := range []string{"once", "continuous"} {
		t.Run(mode, func(t *testing.T) {
			f := newExternalPolicyFixture(t, "root")
			agent := f.fx.Agent(t, "bounded groups target", f.runtime)
			issue := policyWakeIssue(t, f, "")
			s, ctx := policyWakeups(), context.Background()
			in := service.WakeupInput{AgentID: agent, Kind: "event", Mode: mode, EventTypes: []string{"comment.created", "issue.updated"}, Instruction: "Fire only once"}
			if mode == "continuous" {
				in.MaxFires = 1
			}
			w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, in)
			if err != nil {
				t.Fatal(err)
			}
			f.fx.Comment(t, issue, "external group", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
			f.fx.Exec(t, "UPDATE issue SET title='Another valid group' WHERE id=$1", issue)
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE issue_id=$1", issue)
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND conversation_root_task_id=$2", issue, f.root); n != 1 {
				t.Fatal("first valid group did not fire")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != 1 {
				t.Fatal("remaining group exceeded the firing limit")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND processed_at IS NULL", w.ID); n != 0 {
				t.Fatal("ended rule retained another group's input")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup WHERE id=$1 AND NOT enabled AND fire_count=1", w.ID); n != 1 {
				t.Fatal("grouping changed the rule's firing count")
			}
		})
	}
}

func TestExternalConversationSelfAcknowledgementUsesSelectedGroup(t *testing.T) {
	for _, selfFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "self-first", false: "human-first"}[selfFirst], func(t *testing.T) {
			f := newExternalPolicyFixture(t, "root")
			issue := policyWakeIssue(t, f, "")
			s, ctx := policyWakeups(), context.Background()
			w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, service.WakeupInput{
				AgentID: f.agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created", "issue.updated"}, Instruction: "Only independent inputs wake me",
			})
			if err != nil {
				t.Fatal(err)
			}
			self := func() {
				f.fx.Comment(t, issue, "agent knows this", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
			}
			human := func() { f.fx.Exec(t, "UPDATE issue SET title='Human needs attention' WHERE id=$1", issue) }
			if selfFirst {
				self()
				human()
			} else {
				human()
				self()
			}
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if selfFirst {
				if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != 0 {
					t.Fatal("unselected human input made agent repeat its own action")
				}
				if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='issue.updated' AND processed_at IS NULL", w.ID); n != 1 {
					t.Fatal("human input was self-acknowledged")
				}
				if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
					t.Fatal(err)
				}
			}
			var note string
			f.fx.QueryRow(t, "SELECT handoff_note FROM agent_task_queue WHERE context->>'wakeup_id'=$1 AND conversation_root_task_id IS NULL", util.UUIDToString(w.ID)).Scan(&note)
			if !strings.Contains(note, "issue.updated ") || strings.Contains(note, "comment.created ") {
				t.Fatalf("wrong selected evidence: %s", note)
			}
			f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE issue_id=$1", issue)
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != 1 {
				t.Fatal("self group created a duplicate run")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='acknowledged' AND details->'events'='[\"comment.created\"]'::jsonb", issue); n != 1 {
				t.Fatal("self acknowledgement included unselected human facts")
			}
		})
	}
}

func TestExternalConversationJoinReservesOnlyMatchingGroup(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	agent := f.fx.Agent(t, "claim group target", f.runtime)
	issue := policyWakeIssue(t, f, "")
	s, ctx := policyWakeups(), context.Background()
	w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, service.WakeupInput{
		AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created", "issue.updated"}, Instruction: "Join matching input",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.fx.Comment(t, issue, "external group", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
	f.fx.Exec(t, "UPDATE issue SET title='Human group' WHERE id=$1", issue)
	ordinary := f.fx.Task(t, agent, testutil.Cols{"runtime_id": f.runtime, "issue_id": issue, "status": "dispatched", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID, "dispatched_at": time.Now().UTC()})
	task, err := s.Tasks.Queries.GetAgentTask(ctx, policyUUID(t, ordinary))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		joined, err := s.JoinWaitingWakeups(ctx, task)
		if err != nil {
			t.Fatal(err)
		}
		note := service.JoinedWakeupNotes(joined)
		if !strings.Contains(note, "issue.updated ") || strings.Contains(note, "comment.created ") {
			t.Fatalf("claim got wrong authority group: %s", note)
		}
		if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='issue.updated' AND task_id=$2 AND processed_at IS NULL", w.ID, ordinary); n != 1 {
			t.Fatal("matching group not reserved")
		}
		if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='comment.created' AND task_id IS NULL AND processed_at IS NULL", w.ID); n != 1 {
			t.Fatal("claim reserved another root")
		}
	}
	// Revalidating an earlier reservation must release just the inputs that
	// no longer match, while the independent manual group can still join.
	f.fx.Exec(t, "UPDATE issue_wakeup_receipt SET payload=jsonb_build_object('source_task_id',$2::text,'conversation_root_task_id',$2::text) WHERE wakeup_id=$1 AND event_type='issue.updated'", w.ID, f.root)
	f.fx.Insert(t, "issue_wakeup_receipt", testutil.Cols{"id": dbid.NewV7(), "wakeup_id": w.ID, "revision": w.Revision, "event_key": "manual:revalidation", "event_type": "wakeup.manual", "payload": `{"actor_type":"member"}`})
	joined, err := s.JoinWaitingWakeups(ctx, task)
	if err != nil {
		t.Fatal(err)
	}
	note := service.JoinedWakeupNotes(joined)
	if !strings.Contains(note, "wakeup.manual ") || strings.Contains(note, "issue.updated ") {
		t.Fatalf("claim kept a changed authority reservation: %s", note)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='issue.updated' AND task_id IS NULL AND processed_at IS NULL", w.ID); n != 1 {
		t.Fatal("old reservation was not released")
	}
}

func TestExternalConversationManualGroupIgnoresOtherGroupsLoop(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	agent := f.fx.Agent(t, "manual group target", f.runtime)
	issue := policyWakeIssue(t, f, "")
	s, ctx := policyWakeups(), context.Background()
	w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, service.WakeupInput{
		AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created"}, Instruction: "Manual group",
	})
	if err != nil {
		t.Fatal(err)
	}
	history, _ := json.Marshal(map[string]any{"wakeup_id": util.UUIDToString(w.ID)})
	for i := 0; i < 12; i++ {
		f.fx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": f.runtime, "status": "completed", "context": string(history)})
	}
	holder, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(ctx)
	if _, err = holder.Exec(ctx, "SELECT id FROM agent WHERE id=$1 FOR UPDATE", agent); err != nil {
		t.Fatal(err)
	}
	if err = s.Trigger(ctx, policyUUID(t, issue), w.ID, policyUUID(t, testUserID)); err != nil {
		t.Fatal(err)
	}
	if err = holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	chain, _ := json.Marshal(map[string]any{"wakeup_chain": []string{util.UUIDToString(w.ID)}})
	f.fx.Exec(t, "UPDATE agent_task_queue SET context=$2 WHERE id=$1", f.root, string(chain))
	f.fx.Comment(t, issue, "loop in a different group", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
	if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND status='queued' AND conversation_root_task_id IS NULL", issue); n != 1 {
		t.Fatal("external loop suppressed manual group")
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND status='queued' AND context->'wakeup_chain'=jsonb_build_array($2::text)", issue, util.UUIDToString(w.ID)); n != 1 {
		t.Fatal("unselected external loop changed manual run's chain")
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup WHERE id=$1 AND paused_reason IS NULL", w.ID); n != 1 {
		t.Fatal("unselected loop paused rule")
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='comment.created' AND processed_at IS NULL", w.ID); n != 1 {
		t.Fatal("unselected loop was consumed")
	}
}
