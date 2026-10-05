package main

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

func TestExternalConversationRejectedWakeupRecovers(t *testing.T) {
	for _, tc := range []struct {
		name             string
		private, waiting bool
		change           func(*testing.T, externalPolicyFixture, string)
	}{
		{name: "revoked", change: func(t *testing.T, f externalPolicyFixture, _ string) {
			f.fx.Exec(t, "UPDATE channel_installation SET status='revoked' WHERE id=$1", f.install)
		}},
		{name: "waiting-revoked", waiting: true, change: func(t *testing.T, f externalPolicyFixture, _ string) {
			f.fx.Exec(t, "UPDATE channel_installation SET status='revoked' WHERE id=$1", f.install)
		}},
		{name: "missing-root", change: func(t *testing.T, f externalPolicyFixture, _ string) {
			f.fx.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", f.root)
		}},
		{name: "uninvocable-target", private: true},
		{name: "coalesced-conflict-r1-r2-r1", change: func(t *testing.T, f externalPolicyFixture, issue string) {
			other := newExternalPolicyFixture(t, "root")
			f.fx.Comment(t, issue, "other conversation", testutil.Cols{"author_type": "agent", "author_id": other.agent, "source_task_id": other.root})
			f.fx.Comment(t, issue, "first conversation again", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
		}},
		{name: "receipt-internal-conflict", change: func(t *testing.T, f externalPolicyFixture, issue string) {
			other := newExternalPolicyFixture(t, "root")
			// A combined condition can list different sources without a captured
			// root or conflict flag. Its source-task check must stand on its own.
			f.fx.Exec(t, "UPDATE issue_wakeup_receipt SET payload=jsonb_build_object('source_task_ids',jsonb_build_array($2::text,$3::text)) WHERE wakeup_id IN (SELECT id FROM issue_wakeup WHERE issue_id=$1)", issue, f.root, other.root)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := testutil.New(testPool, testWorkspaceID, testUserID)
			grantor := fx.User(t, "Recovery grantor", "recovery-"+tc.name+"@example.test")
			fx.Member(t, testWorkspaceID, grantor, "member")
			f := externalPolicyFixtureForGrantor(t, "root", grantor)
			agent := f.fx.Agent(t, "recovery target", f.runtime)
			if !tc.private {
				f.fx.Exec(t, "UPDATE agent SET permission_mode='public_to' WHERE id=$1", agent)
				f.fx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agent, "target_type": "workspace", "target_id": testWorkspaceID})
			}
			issue := policyWakeIssue(t, f, "")
			s, ctx := policyWakeups(), context.Background()
			w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, service.WakeupInput{AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created", "issue.updated"}, Instruction: "Handle facts"})
			if err != nil {
				t.Fatal(err)
			}
			var waiting string
			wantTasks := 0
			if tc.waiting {
				waiting = f.fx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": f.runtime, "status": "dispatched", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID})
				wantTasks = 1
			}
			f.fx.Comment(t, issue, "external event", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": f.root})
			if tc.change != nil {
				tc.change(t, f, issue)
			}
			if waiting != "" {
				task, err := s.Tasks.Queries.GetAgentTask(ctx, policyUUID(t, waiting))
				if err != nil {
					t.Fatal(err)
				}
				joined, err := s.JoinWaitingWakeups(ctx, task)
				if err != nil || service.JoinedWakeupNotes(joined) != "" {
					t.Fatalf("denied input affected independent claim: %s %v", joined, err)
				}
			}
			for i := 0; i < 3; i++ {
				if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
					t.Fatalf("denial must commit, tick %d: %v", i, err)
				}
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != wantTasks {
				t.Fatalf("denied input ran: %d tasks", n)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND (processed_at IS NULL OR task_id IS NOT NULL)", w.ID); n != 0 {
				t.Fatalf("denied receipts not discarded: %d", n)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND action='wakeup_triggered' AND details->>'outcome'='rejected' AND details->>'reason' IS NOT NULL", issue); n != 1 {
				t.Fatalf("expected one durable rejection activity, got %d", n)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup WHERE id=$1 AND enabled AND fire_count=0", w.ID); n != 1 {
				t.Fatal("rejected input disabled or fired the rule")
			}
			if waiting != "" {
				f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", waiting)
			}
			f.fx.Comment(t, issue, "independent human event")
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE context->>'wakeup_id'=$1 AND conversation_root_task_id IS NULL AND originator_user_id=$2", util.UUIDToString(w.ID), testUserID); n != 1 {
				t.Fatalf("human could not recover rule: %d ordinary runs", n)
			}
		})
	}
}

func TestExternalConversationRejectedChildDoneRecovers(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	grantor := fx.User(t, "Child recovery grantor", "child-recovery@example.test")
	fx.Member(t, testWorkspaceID, grantor, "member")
	f := externalPolicyFixtureForGrantor(t, "root", grantor)
	agent := fx.Agent(t, "private parent target", f.runtime)
	parent := policyWakeIssue(t, f, agent)
	child := fx.Issue(t, "external child", testutil.Cols{"parent_issue_id": parent})
	req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+child, map[string]any{"status": "done"}), "Authorization", "Bearer "+f.token)
	testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
	s, ctx := policyWakeups(), context.Background()
	if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", parent); n != 0 {
		t.Fatal("grantor invoked private assignee")
	}
	if n := fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt r JOIN issue_wakeup w ON w.id=r.wakeup_id WHERE w.issue_id=$1 AND r.processed_at IS NULL", parent); n != 0 {
		t.Fatal("rejected child input stayed pending")
	}
	if n := fx.Count(t, "SELECT count(*) FROM activity_log WHERE issue_id=$1 AND details->>'outcome'='rejected'", parent); n != 1 {
		t.Fatalf("rejection not audited: %d", n)
	}
	other := fx.Issue(t, "member child", testutil.Cols{"parent_issue_id": parent})
	if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
		t.Fatal(err)
	}
	fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", other)
	if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
		t.Fatal(err)
	}
	if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND conversation_root_task_id IS NULL", parent); n != 1 {
		t.Fatalf("human child event could not recover parent: %d", n)
	}
}

func TestWakeupDeletedFirstPartyHistoryStillDispatches(t *testing.T) {
	for _, mode := range []string{"registration", "event-source", "parent-origin"} {
		t.Run(mode, func(t *testing.T) {
			f := newExternalPolicyFixture(t, "root")
			agent := f.fx.Agent(t, "retained rule target", f.runtime)
			issue := policyWakeIssue(t, f, agent)
			planning := f.fx.Issue(t, "deleted planning")
			source := f.fx.Task(t, agent, testutil.Cols{"issue_id": planning, "runtime_id": f.runtime, "status": "completed", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID})
			s, ctx := policyWakeups(), context.Background()
			if mode == "parent-origin" {
				f.fx.Exec(t, "UPDATE issue SET creator_type='agent',creator_id=$2,origin_type='agent_create',origin_id=$3 WHERE id=$1", issue, agent, source)
				child := f.fx.Issue(t, "member child", testutil.Cols{"parent_issue_id": issue})
				f.fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", child)
			} else {
				var registered pgtype.UUID
				if mode == "registration" {
					registered = policyUUID(t, source)
				}
				_, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), registered, service.WakeupInput{AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created"}, Instruction: "Read facts", FilterActorType: "agent", FilterActorID: agent})
				if err != nil {
					t.Fatal(err)
				}
				if mode == "event-source" {
					f.fx.Comment(t, issue, "ordinary task event", testutil.Cols{"author_type": "agent", "author_id": agent, "source_task_id": source})
				}
			}
			f.fx.Exec(t, "DELETE FROM issue WHERE id=$1", planning)
			if mode == "registration" {
				f.fx.Comment(t, issue, "another task event", testutil.Cols{"author_type": "agent", "author_id": agent})
			}
			if err := s.ProcessChildEvents(ctx, policyUUID(t, issue)); err != nil {
				t.Fatal(err)
			}
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND conversation_root_task_id IS NULL", issue); n != 1 {
				t.Fatalf("deleted ordinary history blocked dispatch: %d runs", n)
			}
		})
	}
}

func TestExternalConversationBacklogKeepsCauseWithoutPolling(t *testing.T) {
	for _, closeChild := range []bool{false, true} {
		t.Run(map[bool]string{false: "attached", true: "closed-externally"}[closeChild], func(t *testing.T) {
			f := newExternalPolicyFixture(t, "root")
			agent := f.fx.Agent(t, "parked parent assignee", f.runtime)
			parent := policyWakeIssue(t, f, agent)
			f.fx.Exec(t, "UPDATE issue SET status='backlog' WHERE id=$1", parent)
			child := f.fx.Issue(t, "parked child", testutil.Cols{"parent_issue_id": parent})
			s, ctx := policyWakeups(), context.Background()
			if closeChild {
				req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+child, map[string]any{"status": "done"}), "Authorization", "Bearer "+f.token)
				testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
			} else if err := s.ProcessChildEvents(ctx, policyUUID(t, parent)); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 3; i++ {
				ready, err := s.Tasks.Queries.ListReadyWakeups(ctx, []pgtype.UUID{policyUUID(t, testWorkspaceID)})
				if err != nil {
					t.Fatal(err)
				}
				for _, w := range ready {
					if w.IssueID == policyUUID(t, parent) {
						t.Fatal("parked parent still occupies scheduler batch")
					}
				}
				if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
					t.Fatal(err)
				}
			}
			if !closeChild {
				return
			}
			f.fx.Exec(t, "UPDATE issue SET status='in_progress' WHERE id=$1", parent)
			if err := s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND conversation_root_task_id=$2", parent, f.root); n != 1 {
				t.Fatalf("resumed parent lost external cause: %d", n)
			}
		})
	}
}
