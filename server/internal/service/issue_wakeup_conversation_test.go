package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func externalWakeupFixture(t *testing.T) (principalFixture, *IssueWakeupService, pgtype.UUID, string, db.AgentTaskQueue, db.AgentTaskQueue, string) {
	t.Helper()
	f, s, issue, agent := wakeFixture(t)
	a, err := f.q.GetAgent(context.Background(), parseTestUUID(t, agent))
	if err != nil {
		t.Fatal(err)
	}
	rootID := f.Task(t, agent, testutil.Cols{"runtime_id": a.RuntimeID, "status": "completed",
		"originator_source": channel.ConversationOrigin, "originator_user_id": f.UserID, "accountable_user_id": f.UserID})
	root, err := f.q.GetAgentTask(context.Background(), parseTestUUID(t, rootID))
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(channel.ConversationConfig{ChatID: "oc_wakeup", Grant: &channel.ConversationGrant{
		ID: rootID, AuthorizedBy: f.UserID, Scope: "workspace", Chats: []channel.ConversationTarget{{ChatID: "oc_wakeup", ChatType: "group"}},
	}})
	install := f.Insert(t, "channel_installation", testutil.Cols{"workspace_id": f.WorkspaceID, "agent_id": agent,
		"channel_type": "feishu", "installer_user_id": f.UserID, "config": cfg})
	f.InsertNoID(t, "channel_task_delivery", testutil.Cols{"task_id": rootID, "binding_id": dbid.NewV7(), "installation_id": install,
		"channel_type": "feishu", "channel_chat_id": "external/wakeup", "chat_type": "group", "route_revision": 1, "config": cfg}, "task_id=$1", rootID)
	sourceID := f.Task(t, agent, testutil.Cols{"runtime_id": a.RuntimeID, "issue_id": issue, "status": "completed",
		"originator_source": "delegation", "delegated_from_task_id": root.ID, "originator_user_id": f.UserID, "accountable_user_id": f.UserID})
	source, err := f.q.GetAgentTask(context.Background(), parseTestUUID(t, sourceID))
	if err != nil {
		t.Fatal(err)
	}
	return f, s, issue, agent, root, source, install
}

func createExternalWakeup(t *testing.T, f principalFixture, s *IssueWakeupService, issue pgtype.UUID, agent string, source db.AgentTaskQueue) db.IssueWakeup {
	t.Helper()
	w, err := s.Create(context.Background(), issue, parseTestUUID(t, f.UserID), source.ID, WakeupInput{
		AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created"}, Instruction: "External customer's instruction",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !w.ConversationRootTaskID.Valid || w.ConversationRootTaskID != source.ConversationRootTaskID {
		t.Fatal("wakeup lost its external consent root")
	}
	return w
}

func TestConversationWakeupRevocationStopsDispatch(t *testing.T) {
	for _, reason := range []string{"revoked", "replaced", "grantor removed", "target no longer invocable", "root deleted"} {
		t.Run(reason, func(t *testing.T) {
			f, s, issue, agent, root, source, install := externalWakeupFixture(t)
			w := createExternalWakeup(t, f, s, issue, agent, source)
			f.Comment(t, util.UUIDToString(issue), "trigger")
			switch reason {
			case "revoked":
				f.Exec(t, "UPDATE channel_installation SET config='{}' WHERE id=$1", install)
			case "replaced":
				f.Exec(t, "UPDATE channel_installation SET config=jsonb_set(config,'{conversation,id}','\"replacement\"') WHERE id=$1", install)
			case "grantor removed":
				f.Exec(t, "DELETE FROM member WHERE user_id=$1 AND workspace_id=$2", f.UserID, f.WorkspaceID)
			case "target no longer invocable":
				f.Exec(t, "UPDATE agent SET owner_id=$2 WHERE id=$1", agent, f.member(t, "wakeup-owner-"+util.UUIDToString(w.ID)))
				f.Cleanup(t, "UPDATE agent SET owner_id=$2 WHERE id=$1", agent, f.UserID)
			case "root deleted":
				f.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", root.ID)
			}
			wakeDispatch(t, s, w)
			if n := wakeRuns(t, f, w.ID); n != 0 {
				t.Fatalf("revoked wakeup started %d runs", n)
			}
			got, err := f.q.LocklessWakeup(context.Background(), w.ID)
			if err != nil || got.Enabled || !got.DisabledAt.Valid {
				t.Fatalf("wakeup not disabled: %+v %v", got, err)
			}
			if n := f.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1 AND processed_at IS NULL", w.ID); n != 0 {
				t.Fatal("revoked inputs remain pending")
			}
		})
	}
}

func TestConversationWakeupCannotJoinAnOrdinaryRunAndRechecksClaim(t *testing.T) {
	f, s, issue, agent, root, source, install := externalWakeupFixture(t)
	w := createExternalWakeup(t, f, s, issue, agent, source)
	f.Comment(t, util.UUIDToString(issue), "trigger")
	ordinary := wakeWaitingRun(t, f, issue, agent, f.UserID)
	if notes := wakeClaim(t, f, s, ordinary); notes != "" {
		t.Fatalf("external instructions entered ordinary work: %q", notes)
	}
	f.Exec(t, "UPDATE agent_task_queue SET status='queued',dispatched_at=NULL WHERE id=$1", ordinary)
	wakeDispatch(t, s, w)
	if n := wakeRuns(t, f, w.ID); n != 1 {
		t.Fatalf("different-authority queued run starved the wakeup: %d", n)
	}
	current, err := f.q.LocklessWakeup(context.Background(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	task, err := f.q.GetAgentTask(context.Background(), current.LastTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.ConversationRootTaskID != root.ID {
		t.Fatal("scheduled run lost the external root")
	}
	if err := s.CheckClaim(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	detached := task
	detached.ConversationRootTaskID = pgtype.UUID{}
	if err := s.CheckClaim(context.Background(), detached); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("claim lost its rule's conversation constraint: %v", err)
	}
	f.Exec(t, "UPDATE channel_installation SET config='{}' WHERE id=$1", install)
	if err := s.CheckClaim(context.Background(), task); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("claim after revocation: %v", err)
	}
	if err := channel.AuthorizeConversationTask(context.Background(), f.q, task, w.WorkspaceID); !errors.Is(err, channel.ErrConversationDenied) {
		t.Fatalf("ordinary claim gate lost wakeup consent: %v", err)
	}
}

func TestConversationWakeupSameRootJoinWithdrawsRevokedInstructions(t *testing.T) {
	f, s, issue, agent, root, source, install := externalWakeupFixture(t)
	w := createExternalWakeup(t, f, s, issue, agent, source)
	waiting := f.Task(t, agent, testutil.Cols{"runtime_id": root.RuntimeID, "issue_id": issue,
		"originator_source": "delegation", "delegated_from_task_id": source.ID, "originator_user_id": f.UserID, "accountable_user_id": f.UserID})
	f.Comment(t, util.UUIDToString(issue), "trigger")
	wakeDispatch(t, s, w)
	if n := wakeRuns(t, f, w.ID); n != 0 {
		t.Fatal("matching external run did not receive the wakeup")
	}
	if notes := wakeClaim(t, f, s, waiting); !strings.Contains(notes, w.Instruction) {
		t.Fatal("same-root run did not receive the instruction")
	}
	f.Exec(t, "UPDATE channel_installation SET config='{}' WHERE id=$1", install)
	if notes := wakeClaim(t, f, s, waiting); notes != "" {
		t.Fatalf("revoked joined instruction survived re-claim: %q", notes)
	}
}

func TestConversationWakeupBusyRuleDoesNotKeepUnsafeJoinedInstructions(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		name := "ordinary run with a pre-upgrade join"
		if revoked {
			name = "same-root run after revocation"
		}
		t.Run(name, func(t *testing.T) {
			f, s, issue, agent, root, source, install := externalWakeupFixture(t)
			w := createExternalWakeup(t, f, s, issue, agent, source)
			waiting := wakeWaitingRun(t, f, issue, agent, f.UserID)
			if revoked {
				f.Exec(t, "UPDATE agent_task_queue SET originator_source='delegation',delegated_from_task_id=$2 WHERE id=$1", waiting, root.ID)
				f.Exec(t, "UPDATE channel_installation SET config='{}' WHERE id=$1", install)
			}
			stored, err := json.Marshal(map[string]any{"wakeup_joined": []joinedWakeup{{
				WakeupID: util.UUIDToString(w.ID), Revision: w.Revision, Note: w.Instruction,
			}}})
			if err != nil {
				t.Fatal(err)
			}
			f.Exec(t, "UPDATE agent_task_queue SET context=$2 WHERE id=$1", waiting, stored)
			tx, err := s.Tasks.TxStarter.Begin(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := f.q.WithTx(tx).LockIssueWakeup(context.Background(), w.ID); err != nil {
				t.Fatal(err)
			}
			if notes := wakeClaim(t, f, s, waiting); notes != "" {
				t.Fatalf("busy rule retained unsafe instructions: %q", notes)
			}
		})
	}
}

func TestConversationWakeupKeepsConsentAcrossHistoryDeletionAndEnable(t *testing.T) {
	f, s, issue, agent, root, source, install := externalWakeupFixture(t)
	w := createExternalWakeup(t, f, s, issue, agent, source)
	f.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", source.ID)
	owner := parseTestUUID(t, f.UserID)
	if _, err := s.Disable(context.Background(), issue, w.ID, owner); err != nil {
		t.Fatal(err)
	}
	var err error
	w, err = s.Enable(context.Background(), issue, owner, pgtype.UUID{}, w.ID, WakeupEnableInput{Revision: w.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if w.ConversationRootTaskID != root.ID || w.SourceTaskID != source.ID {
		t.Fatal("human toggle detached existing instructions from consent")
	}
	f.Comment(t, util.UUIDToString(issue), "trigger")
	wakeDispatch(t, s, w)
	current, err := f.q.LocklessWakeup(context.Background(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	task, err := f.q.GetAgentTask(context.Background(), current.LastTaskID)
	if err != nil || task.ConversationRootTaskID != root.ID {
		t.Fatalf("source retention changed authority: %+v %v", task, err)
	}
	f.Exec(t, "UPDATE channel_installation SET config='{}' WHERE id=$1", install)
	if _, err := s.Enable(context.Background(), issue, owner, pgtype.UUID{}, w.ID, WakeupEnableInput{Revision: w.Revision}); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("enabled revoked instructions: %v", err)
	}
}

func TestConversationWakeupCannotLaunderThroughManagement(t *testing.T) {
	f, s, issue, agent, _, source, install := externalWakeupFixture(t)
	owner := parseTestUUID(t, f.UserID)
	w := wakeCreate(t, f, s, issue, WakeupInput{AgentID: agent, Kind: "event", Mode: "continuous", EventTypes: []string{"comment.created"}, Instruction: "Owner's instructions"})
	in := WakeupInstructionInput{Instruction: "Customer's instructions", ExpectedInstruction: w.Instruction, Revision: w.Revision}
	if err := s.EditInstruction(context.Background(), issue, w.ID, owner, source.ID, in); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("edited owner's rule: %v", err)
	}
	if err := s.Trigger(context.Background(), issue, w.ID, owner, source.ID); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("triggered owner's rule: %v", err)
	}
	if _, err := s.Enable(context.Background(), issue, owner, source.ID, w.ID, WakeupEnableInput{Revision: w.Revision}); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("enabled owner's rule: %v", err)
	}
	if n := f.Count(t, "SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id=$1", w.ID); n != 0 {
		t.Fatal("rejected management created a receipt")
	}
	f.Exec(t, "UPDATE channel_installation SET config='{}' WHERE id=$1", install)
	if _, err := s.Create(context.Background(), issue, owner, source.ID, WakeupInput{AgentID: agent, Kind: "every", IntervalSeconds: 600, Instruction: "Still run"}); !errors.Is(err, ErrWakeupForbidden) {
		t.Fatalf("created rule from revoked source: %v", err)
	}
}

func TestFirstPartyWakeupSurvivesSourceHistoryDeletion(t *testing.T) {
	f, s, issue, agent := wakeFixture(t)
	sourceID := wakeWaitingRun(t, f, issue, agent, f.UserID)
	f.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", sourceID)
	w, err := s.Create(context.Background(), issue, parseTestUUID(t, f.UserID), parseTestUUID(t, sourceID), WakeupInput{
		AgentID: agent, Kind: "event", EventTypes: []string{"comment.created"}, Instruction: "Ordinary agent-authored rule",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.Exec(t, "DELETE FROM agent_task_queue WHERE id=$1", sourceID)
	f.Comment(t, util.UUIDToString(issue), "trigger")
	wakeDispatch(t, s, w)
	current, err := f.q.LocklessWakeup(context.Background(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	task, err := f.q.GetAgentTask(context.Background(), current.LastTaskID)
	if err != nil || task.ConversationRootTaskID.Valid {
		t.Fatalf("ordinary retention acquired external consent: %+v %v", task, err)
	}
	if err := s.CheckClaim(context.Background(), task); err != nil {
		t.Fatal(err)
	}
}
