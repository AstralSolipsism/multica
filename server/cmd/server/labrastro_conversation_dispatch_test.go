package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func policyUUID(t *testing.T, raw string) pgtype.UUID {
	t.Helper()
	id, err := util.ParseUUID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func policyWakeups() *service.IssueWakeupService {
	return &service.IssueWakeupService{Tasks: service.NewTaskService(db.New(testPool), testPool, realtime.NewHub(), events.New())}
}

func policyWakeIssue(t *testing.T, f externalPolicyFixture, agent string) string {
	t.Helper()
	issue := f.fx.Issue(t, "Wakeup external provenance", testutil.Cols{"status": "in_progress"})
	f.fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	f.fx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id=$1", issue)
	f.fx.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", issue)
	f.fx.Cleanup(t, "DELETE FROM issue_child_event WHERE parent_id=$1", issue)
	f.fx.Cleanup(t, "DELETE FROM issue_wakeup WHERE issue_id=$1", issue)
	f.fx.Cleanup(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id IN (SELECT id FROM issue_wakeup WHERE issue_id=$1)", issue)
	if agent != "" {
		f.fx.Exec(t, "UPDATE issue SET assignee_type='agent',assignee_id=$2 WHERE id=$1", issue, agent)
	}
	return issue
}

func TestExternalConversationDeferredChildDoneKeepsRoot(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		mixed, externalParent bool
	}{{"single", false, false}, {"mixed", true, false}, {"external-parent", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			mixed := tc.mixed
			fx := testutil.New(testPool, testWorkspaceID, testUserID)
			grantor := fx.User(t, "Child event grantor", "child-event-"+tc.name+"@example.test")
			fx.Member(t, testWorkspaceID, grantor, "member")
			f := externalPolicyFixtureForGrantor(t, "root", grantor)
			agent := fx.Agent(t, "parent assignee", f.runtime, testutil.Cols{"owner_id": grantor})
			parent := policyWakeIssue(t, f, agent)
			if tc.externalParent {
				previous := newExternalPolicyFixture(t, "root")
				fx.Exec(t, "UPDATE issue SET creator_type='agent',creator_id=$2,origin_type='agent_create',origin_id=$3 WHERE id=$1", parent, previous.agent, previous.root)
			}
			child := fx.Issue(t, "external completed child", testutil.Cols{"parent_issue_id": parent})
			if mixed {
				other := fx.Issue(t, "human completed child", testutil.Cols{"parent_issue_id": parent})
				fx.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", other)
			}
			ctx := context.Background()
			// Force the production immediate pass to hit its real 50ms lock timeout.
			holder, err := testPool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(ctx)
			if _, err = holder.Exec(ctx, "SELECT id FROM agent WHERE id=$1 FOR UPDATE", agent); err != nil {
				t.Fatal(err)
			}
			req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+child, map[string]any{"status": "done"}), "Authorization", "Bearer "+f.token)
			testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
			if n := fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", parent); n != 0 {
				t.Fatalf("immediate dispatch did not defer: %d runs", n)
			}
			if n := fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt r JOIN issue_wakeup w ON w.id=r.wakeup_id WHERE w.issue_id=$1 AND r.processed_at IS NULL AND r.payload->'source_task_ids' @> to_jsonb(ARRAY[$2::text])", parent, f.root); n != 1 {
				t.Fatalf("expected durable source before scheduling, got %d receipts", n)
			}
			if err = holder.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			// A scheduler has no authenticated request context to recover authority from.
			if err = policyWakeups().TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
				t.Fatal(err)
			}
			var id, root, human, source string
			fx.QueryRow(t, "SELECT id::text,COALESCE(conversation_root_task_id::text,''),originator_user_id::text,originator_source FROM agent_task_queue WHERE issue_id=$1", parent).Scan(&id, &root, &human, &source)
			if root != f.root || human != grantor || source != "delegation" {
				t.Fatalf("scheduler lost external authority: root=%s human=%s source=%s", root, human, source)
			}
			fx.Exec(t, "UPDATE agent_task_queue SET status='running' WHERE id=$1", id)
			token := mintAgentTaskToken(t, agent, id, testUserID)
			if w := policyRequest(t, token, "POST", "/api/cli-token", nil); w.Code != 403 || !strings.Contains(w.Body.String(), "external_conversation_forbidden") {
				t.Fatalf("scheduled descendant escaped HTTP policy: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestExternalConversationEventWakeupPreservesRoot(t *testing.T) {
	for _, mode := range []string{"external", "different-grantor", "coalesced-human", "condition", "waiting-first-party", "waiting-revoked", "waiting-same-conversation", "existing-first-party", "conflicting-roots", "revoked", "missing-source"} {
		t.Run(mode, func(t *testing.T) {
			grantor := testUserID
			if mode == "different-grantor" {
				fx := testutil.New(testPool, testWorkspaceID, testUserID)
				grantor = fx.User(t, "Event grantor", "event-grantor@example.test")
				fx.Member(t, testWorkspaceID, grantor, "member")
			}
			f := externalPolicyFixtureForGrantor(t, "root", grantor)
			agent := f.fx.Agent(t, "event target", f.runtime, testutil.Cols{"permission_mode": "public_to"})
			f.fx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agent, "target_type": "workspace", "target_id": testWorkspaceID})
			issue := policyWakeIssue(t, f, "")
			s := policyWakeups()
			ctx := context.Background()
			input := service.WakeupInput{AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created"}, Instruction: "Handle the new facts"}
			if mode == "condition" {
				input.Condition = json.RawMessage(`{"type":"issue_field","field":"status","value":"in_review"}`)
				input.EventTypes = nil
			}
			w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), pgtype.UUID{}, input)
			if err != nil {
				t.Fatal(err)
			}
			var ordinary string
			if mode == "waiting-first-party" || mode == "waiting-same-conversation" || mode == "waiting-revoked" {
				ordinary = f.fx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": f.runtime, "status": "queued", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID})
			}
			if mode == "waiting-same-conversation" {
				f.fx.Exec(t, "UPDATE agent_task_queue SET originator_source='delegation',delegated_from_task_id=$2 WHERE id=$1", ordinary, f.root)
			}
			if mode == "existing-first-party" {
				f.fx.Comment(t, issue, "first-party event")
				if err = s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
					t.Fatal(err)
				}
				f.fx.QueryRow(t, "SELECT id::text FROM agent_task_queue WHERE issue_id=$1", issue).Scan(&ordinary)
			}
			path, method, body := "/api/issues/"+issue+"/comments", "POST", map[string]any{"content": "External event"}
			want := http.StatusCreated
			if mode == "condition" {
				path, method, body, want = "/api/issues/"+issue, "PUT", map[string]any{"status": "in_review"}, http.StatusOK
			}
			req := testutil.WithHeaders(testutil.JSONRequest(method, path, body), "Authorization", "Bearer "+f.token)
			testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(want)
			if mode == "coalesced-human" {
				f.fx.Comment(t, issue, "later first-party event")
			}
			if mode == "conflicting-roots" {
				other := newExternalPolicyFixture(t, "root")
				f.fx.Comment(t, issue, "another conversation", testutil.Cols{"author_type": "agent", "author_id": other.agent, "source_task_id": other.root})
			}
			if mode == "revoked" || mode == "waiting-revoked" {
				f.fx.Exec(t, "UPDATE channel_installation SET status='revoked' WHERE id=$1", f.install)
			}
			if mode == "missing-source" {
				f.fx.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", f.root)
			}
			if mode == "waiting-first-party" || mode == "waiting-revoked" {
				f.fx.Exec(t, "UPDATE agent_task_queue SET status='dispatched',dispatched_at=now() WHERE id=$1", ordinary)
				task, err := s.Tasks.Queries.GetAgentTask(ctx, policyUUID(t, ordinary))
				if err != nil {
					t.Fatal(err)
				}
				joined, err := s.JoinWaitingWakeups(ctx, task)
				if err != nil {
					t.Fatal(err)
				}
				if service.JoinedWakeupNotes(joined) != "" {
					t.Fatal("ordinary run accepted an external wakeup")
				}
				f.fx.Exec(t, "UPDATE agent_task_queue SET status='queued' WHERE id=$1", ordinary)
			}
			err = s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID))
			if mode == "conflicting-roots" || mode == "revoked" || mode == "missing-source" || mode == "waiting-revoked" {
				if !errors.Is(err, channel.ErrConversationDenied) {
					t.Fatalf("expected fail-closed dispatch, got %v", err)
				}
				wantTasks := 0
				if ordinary != "" {
					wantTasks = 1
				}
				if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != wantTasks {
					t.Fatalf("denied sources changed task count: got %d want %d", n, wantTasks)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "waiting-same-conversation" {
				if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != 1 {
					t.Fatalf("compatible external run did not keep the wakeup: %d tasks", n)
				}
				f.fx.Exec(t, "UPDATE agent_task_queue SET status='dispatched',dispatched_at=now() WHERE id=$1", ordinary)
				task, err := s.Tasks.Queries.GetAgentTask(ctx, policyUUID(t, ordinary))
				if err != nil {
					t.Fatal(err)
				}
				joined, err := s.JoinWaitingWakeups(ctx, task)
				if err != nil {
					t.Fatal(err)
				}
				if service.JoinedWakeupNotes(joined) == "" {
					t.Fatal("compatible external run did not receive wakeup instructions")
				}
				return
			}
			if mode == "existing-first-party" {
				if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND processed_at IS NULL", w.ID); n != 1 {
					t.Fatalf("external evidence was merged into ordinary task: pending=%d", n)
				}
				f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", ordinary)
				if err = s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
					t.Fatal(err)
				}
			}
			var root, source, human string
			f.fx.QueryRow(t, "SELECT COALESCE(conversation_root_task_id::text,''),originator_source,originator_user_id::text FROM agent_task_queue WHERE context->>'wakeup_id'=$1 AND status='queued'", util.UUIDToString(w.ID)).Scan(&root, &source, &human)
			if root != f.root || source != "delegation" || human != grantor {
				t.Fatalf("event woke with wrong authority: root=%s source=%s", root, source)
			}
		})
	}
}

func TestExternalConversationQuickCreateOriginMustBeAncestor(t *testing.T) {
	for _, lineage := range []string{"root", "delegation", "retry"} {
		t.Run(lineage, func(t *testing.T) {
			f := newExternalPolicyFixture(t, lineage)
			config := fmt.Sprintf(`{"type":"quick_create","workspace_id":%q,"requester_id":%q}`, testWorkspaceID, testUserID)
			f.fx.Exec(t, "UPDATE agent_task_queue SET context=$2 WHERE id=$1", f.root, config)
			otherUser := f.fx.User(t, "Unrelated originator", "quick-other-"+lineage+"@example.test")
			f.fx.Member(t, testWorkspaceID, otherUser, "member")
			unrelatedContext := fmt.Sprintf(`{"type":"quick_create","workspace_id":%q,"requester_id":%q}`, testWorkspaceID, otherUser)
			unrelated := f.fx.Task(t, f.agent, testutil.Cols{"context": unrelatedContext, "runtime_id": f.runtime, "originator_source": "direct_human", "originator_user_id": otherUser, "accountable_user_id": otherUser})
			sibling := f.fx.Task(t, f.agent, testutil.Cols{"context": config, "runtime_id": f.runtime, "originator_source": "delegation", "delegated_from_task_id": f.root, "originator_user_id": testUserID, "accountable_user_id": testUserID})
			for _, route := range []string{"/api/issues", "/api/issues/with-dependencies"} {
				for _, tc := range []struct {
					origin string
					status int
				}{{unrelated, 403}, {sibling, 403}, {f.root, 201}} {
					req := testutil.WithHeaders(testutil.JSONRequest("POST", route, map[string]any{"title": "Quick create " + route + tc.origin, "origin_type": "quick_create", "origin_id": tc.origin}), "Authorization", "Bearer "+f.token)
					res := testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(tc.status)
					if tc.status == 201 {
						id := res.Map()["id"].(string)
						f.fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", id)
						f.fx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id=$1", id)
					}
				}
			}
		})
	}
}

func TestExternalConversationOwnConditionAcknowledged(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	issue := policyWakeIssue(t, f, "")
	s := policyWakeups()
	ctx := context.Background()
	registration := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "status": "completed"})
	w, err := s.Create(ctx, policyUUID(t, issue), policyUUID(t, testUserID), policyUUID(t, registration), service.WakeupInput{
		AgentID: f.agent, Kind: "event", Mode: "continuous", Instruction: "Review when ready",
		Condition: json.RawMessage(`{"type":"issue_field","field":"status","value":"in_review"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	acting := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "issue_id": issue, "status": "running", "originator_source": "delegation", "delegated_from_task_id": f.root, "originator_user_id": testUserID, "accountable_user_id": testUserID})
	token := mintAgentTaskToken(t, f.agent, acting, testUserID)
	req := testutil.WithHeaders(testutil.JSONRequest("PUT", "/api/issues/"+issue, map[string]any{"status": "in_review"}), "Authorization", "Bearer "+token)
	testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(200)
	if err = s.TickWorkspaces(ctx, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != 1 {
		t.Fatalf("the grant anchor was mistaken for another acting task: %d runs", n)
	}
	if n := f.fx.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND processed_at IS NULL", w.ID); n != 0 {
		t.Fatalf("self-produced condition was not acknowledged: %d receipts", n)
	}
}
