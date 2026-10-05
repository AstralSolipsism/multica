package main

import (
	"context"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestExternalConversationChildDoneDoesNotMergeIntoOrdinaryTask(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	agent := f.fx.Agent(t, "ordinary queued parent", f.runtime)
	parent := policyWakeIssue(t, f, agent)
	child := f.fx.Issue(t, "human child", testutil.Cols{"parent_issue_id": parent})
	f.fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", child)
	s, ctx := policyWakeups(), context.Background()
	if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
		t.Fatal(err)
	}
	var ordinary string
	f.fx.QueryRow(t, "SELECT id::text FROM agent_task_queue WHERE issue_id=$1 AND conversation_root_task_id IS NULL", parent).Scan(&ordinary)
	other := f.fx.Issue(t, "external child", testutil.Cols{"parent_issue_id": parent})
	if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
		t.Fatal(err)
	}
	req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+other, map[string]any{"status": "done"}), "Authorization", "Bearer "+f.token)
	testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
	if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt r JOIN issue_wakeup w ON w.id=r.wakeup_id WHERE w.issue_id=$1 AND r.event_type='condition.met' AND r.processed_at IS NULL", parent); n != 1 {
		t.Fatalf("different grant merged into ordinary pending task: %d receipts", n)
	}
	f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", ordinary)
	if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND conversation_root_task_id=$2", parent, f.root); n != 1 {
		t.Fatalf("separate external run missing: %d", n)
	}
}

func TestExternalConversationMixedSelfAndHumanChildrenWakeAgain(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	parent := policyWakeIssue(t, f, f.agent)
	acting := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "issue_id": parent, "status": "running", "originator_source": "delegation", "delegated_from_task_id": f.root, "originator_user_id": testUserID, "accountable_user_id": testUserID})
	first := f.fx.Issue(t, "member closes this", testutil.Cols{"parent_issue_id": parent})
	second := f.fx.Issue(t, "agent closes this", testutil.Cols{"parent_issue_id": parent})
	f.fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", first)
	token := mintAgentTaskToken(t, f.agent, acting, testUserID)
	req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+second, map[string]any{"status": "done"}), "Authorization", "Bearer "+token)
	testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
	if err := policyWakeups().TickWorkspaces(context.Background(), policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND id<>$2 AND conversation_root_task_id=$3", parent, acting, f.root); n != 1 {
		t.Fatalf("human contribution incorrectly self-acknowledged: %d runs", n)
	}
}

func TestExternalConversationParentOriginAppliesToHumanChildEvent(t *testing.T) {
	for _, allowed := range []bool{true, false} {
		t.Run(map[bool]string{true: "allowed", false: "target-forbidden"}[allowed], func(t *testing.T) {
			fx := testutil.New(testPool, testWorkspaceID, testUserID)
			grantor := fx.User(t, "Parent origin grantor", "parent-origin@example.test")
			fx.Member(t, testWorkspaceID, grantor, "member")
			f := externalPolicyFixtureForGrantor(t, "root", grantor)
			owner := testUserID
			if allowed {
				owner = grantor
			}
			agent := f.fx.Agent(t, "external parent's assignee", f.runtime, testutil.Cols{"owner_id": owner})
			parent := policyWakeIssue(t, f, agent)
			f.fx.Exec(t, "UPDATE issue SET creator_type='agent',creator_id=$2,origin_type='agent_create',origin_id=$3 WHERE id=$1", parent, f.agent, f.root)
			child := f.fx.Issue(t, "member closes child", testutil.Cols{"parent_issue_id": parent})
			f.fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", child)
			s, ctx := policyWakeups(), context.Background()
			if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
				t.Fatal(err)
			}
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			want := 0
			if allowed {
				want = 1
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND conversation_root_task_id=$2 AND originator_source='delegation'", parent, f.root); n != want {
				t.Fatalf("historical external origin was not authorized: got %d want %d", n, want)
			}
			if !allowed {
				if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected'", parent); n != 1 {
					t.Fatal("historical grant rejection was not consumed and audited")
				}
			}
		})
	}
}
