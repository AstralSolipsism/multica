package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func deniedReceiptFixture(t *testing.T, events []string) (externalPolicyFixture, *service.IssueWakeupService, db.IssueWakeup, string, string) {
	t.Helper()
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	grantor := fx.User(t, "Receipt grantor", "receipt-group@example.test")
	fx.Member(t, testWorkspaceID, grantor, "member")
	f := externalPolicyFixtureForGrantor(t, "root", grantor)
	agent := fx.Agent(t, "private receipt target", f.runtime)
	issue := policyWakeIssue(t, f, "")
	s := policyWakeups()
	w, err := s.Create(context.Background(), policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, service.WakeupInput{
		AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: events, Instruction: "Read independent inputs", ExpiresInSeconds: 3600, OnTimeout: "wake",
	})
	if err != nil {
		t.Fatal(err)
	}
	return f, s, w, issue, agent
}

func TestExternalConversationDenialKeepsIndependentReceipts(t *testing.T) {
	for _, input := range []string{"issue.updated", "wakeup.manual", "wakeup.timeout"} {
		t.Run(input, func(t *testing.T) {
			f, s, w, issue, _ := deniedReceiptFixture(t, []string{"comment.created", "issue.updated"})
			ctx := context.Background()
			f.fx.Comment(t, issue, "denied external comment", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
			switch input {
			case "issue.updated":
				f.fx.Exec(t, "UPDATE issue SET title='Human update survives' WHERE id=$1", issue)
			case "wakeup.manual":
				if err := s.Trigger(ctx, policyUUID(t, issue), w.ID, policyUUID(t, testUserID)); err != nil {
					t.Fatal(err)
				}
			case "wakeup.timeout":
				f.fx.Exec(t, "UPDATE issue_wakeup SET expires_at=now()-interval '1 second' WHERE id=$1", w.ID)
			}
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE context->>'wakeup_id'=$1 AND originator_user_id=$2 AND conversation_root_task_id IS NULL", util.UUIDToString(w.ID), testUserID); n != 1 {
				t.Fatalf("independent %s swallowed by rejected comment: %d tasks", input, n)
			}
			var note string
			f.fx.QueryRow(t, "SELECT handoff_note FROM agent_task_queue WHERE context->>'wakeup_id'=$1", util.UUIDToString(w.ID)).Scan(&note)
			if strings.Contains(note, "\ncomment.created ") || !strings.Contains(note, input) {
				t.Fatalf("unselected evidence reached task: %s", note)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND processed_at IS NULL", w.ID); n != 0 {
				t.Fatalf("inputs stayed pending: %d", n)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected' AND (details->>'receipt_count')::int=1", issue); n != 1 {
				t.Fatal("missing rejection count")
			}
			if input == "wakeup.timeout" && f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND action='wakeup_timed_out' AND details->>'woke'='true'", issue) != 1 {
				t.Fatal("timeout wake was not recorded")
			}
		})
	}
}

func TestExternalConversationDenialCommitsDespiteOccupiedSlot(t *testing.T) {
	for _, status := range []string{"queued", "dispatched", "deferred"} {
		t.Run(status, func(t *testing.T) {
			f, s, w, issue, agent := deniedReceiptFixture(t, []string{"comment.created", "issue.updated"})
			ctx := context.Background()
			// A different principal occupies the real unique-index slot.
			occupant := f.fx.User(t, "Slot occupant", "slot@example.test")
			slotContext, _ := json.Marshal(map[string]any{"wakeup_id": util.UUIDToString(w.ID), "channel_issue_media_pending": true})
			blocking := f.fx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": f.runtime, "status": status,
				"originator_source": "direct_human", "originator_user_id": occupant, "accountable_user_id": occupant, "context": string(slotContext)})
			f.fx.Comment(t, issue, "denied", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
			f.fx.Exec(t, "UPDATE issue SET title='Valid independent input' WHERE id=$1", issue)
			if status == "deferred" {
				f.fx.Exec(t, "UPDATE issue_wakeup SET expires_at=now()-interval '1 second' WHERE id=$1", w.ID)
			}
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatalf("occupied slot rolled back rejection: %v", err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='comment.created' AND processed_at IS NOT NULL AND task_id IS NULL", w.ID); n != 1 {
				t.Fatal("denial was rolled back")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='issue.updated' AND processed_at IS NULL", w.ID); n != 1 {
				t.Fatal("valid input was consumed on contention")
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected'", issue); n != 1 {
				t.Fatal("rejection activity was rolled back")
			}
			if status == "deferred" {
				if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND action='wakeup_timed_out' AND details->>'woke'='false'", issue); n != 1 {
					t.Fatal("blocked timeout falsely reported a wake or lost its deadline")
				}
			}
			f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", blocking)
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE context->>'wakeup_id'=$1 AND conversation_root_task_id IS NULL AND originator_user_id=$2", util.UUIDToString(w.ID), testUserID); n != 1 {
				t.Fatal("valid group did not recover after slot release")
			}
		})
	}
}

func TestExternalConversationSystemSlotCommitsDenial(t *testing.T) {
	f, s, _, parent, agent := deniedReceiptFixture(t, []string{"comment.created"})
	ctx := context.Background()
	f.fx.Exec(t, "UPDATE issue SET assignee_type='agent',assignee_id=$2 WHERE id=$1", parent, agent)
	f.fx.Exec(t, "UPDATE agent SET permission_mode='public_to' WHERE id=$1", agent)
	f.fx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agent, "target_type": "workspace", "target_id": testWorkspaceID})
	first := f.fx.Issue(t, "external stage", testutil.Cols{"parent_issue_id": parent, "stage": 1})
	second := f.fx.Issue(t, "human stage", testutil.Cols{"parent_issue_id": parent, "stage": 2})
	if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
		t.Fatal(err)
	}
	var wid string
	f.fx.QueryRow(t, "SELECT id::text FROM issue_wakeup WHERE issue_id=$1 AND system_rule='child_done'", parent).Scan(&wid)
	slotContext, _ := json.Marshal(map[string]any{"wakeup_id": wid, "channel_issue_media_pending": true})
	blocking := f.fx.Task(t, agent, testutil.Cols{"issue_id": parent, "runtime_id": f.runtime, "status": "queued", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID, "context": string(slotContext)})
	req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+first, map[string]any{"status": "done"}), "Authorization", "Bearer "+f.token)
	testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='condition.met' AND processed_at IS NULL", wid); n != 1 {
		t.Fatal("first authorized stage did not wait on the occupied slot")
	}
	f.fx.Exec(t, "UPDATE agent_task_queue SET status='deferred' WHERE id=$1", blocking)
	// A later evaluation has independent human causes; the earlier stage
	// now fails authorization. Both outcomes must survive the deferred slot.
	f.fx.Exec(t, "UPDATE agent SET permission_mode='private' WHERE id=$1", agent)
	f.fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", second)
	if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
		t.Fatal(err)
	}
	if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected' AND (details->>'receipt_count')::int=1", parent); n != 1 {
		t.Fatal("system slot rolled back rejection")
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND event_type='condition.met' AND processed_at IS NULL", wid); n != 1 {
		t.Fatal("system slot consumed independent human condition")
	}
	f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", blocking)
	if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE context->>'wakeup_id'=$1 AND status='queued' AND conversation_root_task_id IS NULL", wid); n != 1 {
		t.Fatal("human stage did not dispatch after slot release")
	}
}

func TestExternalConversationRejectionsAreAggregated(t *testing.T) {
	f, s, w, issue, _ := deniedReceiptFixture(t, []string{"comment.created", "issue.updated"})
	f.fx.Comment(t, issue, "denied comment", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
	req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+issue, map[string]any{"title": "Denied external update"}), "Authorization", "Bearer "+f.token)
	testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
	if err := s.TickWorkspaces(context.Background(), policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND processed_at IS NOT NULL AND task_id IS NULL", w.ID); n != 2 {
		t.Fatalf("expected two denied receipts, got %d", n)
	}
	var details []byte
	f.fx.QueryRow(t, "SELECT details FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected'", issue).Scan(&details)
	var activity struct {
		ReceiptCount int      `json:"receipt_count"`
		EventTypes   []string `json:"event_types"`
	}
	if err := json.Unmarshal(details, &activity); err != nil || activity.ReceiptCount != 2 {
		t.Fatalf("bad aggregate rejection: %s %v", details, err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected'", issue); n != 1 {
		t.Fatalf("rejection log spam: %d", n)
	}
}
