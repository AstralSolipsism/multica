package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type feedbackTransportTest struct {
	mu        sync.Mutex
	proof     messagedelivery.FeedbackMessage
	ackErr    error
	acks      map[pgtype.UUID]bool
	beforeAck func()
}

func (f *feedbackTransportTest) ReadFeedbackMessage(_ context.Context, _, _, id string) (messagedelivery.FeedbackMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.proof
	p.MessageID = id
	return p, nil
}
func (f *feedbackTransportTest) SendFeedbackNotice(_ context.Context, row db.LabrastroMessageFeedback) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.beforeAck != nil {
		f.beforeAck()
	}
	if f.ackErr != nil {
		return f.ackErr
	}
	f.acks[row.AckUuid] = true
	return nil
}

type feedbackFixture struct {
	h                                                      *Handler
	transport                                              *feedbackTransportTest
	install, app, issue, agent, delivery, receipt, binding string
	msg                                                    channel.InboundMessage
	queued                                                 atomic.Int64
}

func newFeedbackFixture(t *testing.T) *feedbackFixture {
	t.Helper()
	if testPool == nil {
		t.Fatal("feedback acceptance requires PostgreSQL")
	}
	f := &feedbackFixture{}
	f.agent = dbfx.Agent(t, "Feedback agent", handlerTestRuntimeID(t))
	f.issue = dbfx.Issue(t, "Feedback target", testutil.Cols{"assignee_type": "agent", "assignee_id": f.agent})
	f.app = "cli_feedback_" + f.issue
	f.install = dbfx.Insert(t, "channel_installation", testutil.Cols{"workspace_id": testWorkspaceID, "agent_id": f.agent, "channel_type": "feishu", "installer_user_id": testUserID, "status": "active", "config": fmt.Sprintf(`{"app_id":%q}`, f.app)})
	f.binding = dbfx.Insert(t, "channel_user_binding", testutil.Cols{"workspace_id": testWorkspaceID, "multica_user_id": testUserID, "installation_id": f.install, "channel_type": "feishu", "channel_user_id": "ou_feedback"})
	activity := dbfx.Insert(t, "activity_log", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": f.issue, "actor_type": "member", "actor_id": testUserID, "action": "issue_updated"})
	f.delivery = dbfx.Insert(t, "labrastro_message_delivery", testutil.Cols{"id": testutil.Raw("gen_random_uuid()"), "workspace_id": testWorkspaceID, "installation_id": f.install, "source_kind": "activity", "source_scope": "activity", "source_ref_id": activity, "status": "sent", "dedup_key": f.install, "target_key": "member:" + testUserID, "shard_total": 1,
		"source_ref": fmt.Sprintf(`{"source_kind":"activity","issue_id":%q}`, f.issue), "content_snapshot": `{"text":"Frozen report"}`, "target_snapshot": fmt.Sprintf(`{"target_type":"member","user_id":%q}`, testUserID)})
	f.receipt = dbfx.Insert(t, "labrastro_message_receipt", testutil.Cols{"delivery_id": f.delivery, "workspace_id": testWorkspaceID, "installation_id": f.install, "shard_index": 0, "shard_total": 1, "send_uuid": f.delivery, "external_message_id": "om_report"})
	f.transport = &feedbackTransportTest{proof: messagedelivery.FeedbackMessage{MessageID: "om_report", ChatID: "oc_feedback", Bot: true, HasReference: true, Signed: true, DeliveryID: f.delivery, SendUUID: f.delivery}, acks: map[pgtype.UUID]bool{}}
	h := *testHandler
	h.Bus = events.New()
	h.Bus.Subscribe(protocol.EventTaskQueued, func(events.Event) { f.queued.Add(1) })
	h.TaskService = service.NewTaskService(h.Queries, testPool, h.Hub, h.Bus)
	h.MessageDelivery = messagedelivery.New(h.Queries)
	h.MessageDelivery.Tx, h.MessageDelivery.FeedbackTransport, h.MessageDelivery.AppURL = testPool, f.transport, "https://example.test"
	f.h = &h
	raw, _ := json.Marshal(lark.InboundMessage{AppID: f.app})
	f.msg = channel.InboundMessage{MessageID: "om_input", EventID: "evt_input", Type: channel.MsgTypeText, Text: "> /issue quoted instruction\n\n修复边界", CommandText: "修复边界", CommandTextSet: true, AddressedToBot: true, ReplyTo: &channel.ReplyCtx{MessageID: "om_report"}, Source: channel.Source{ChannelType: channel.TypeFeishu, ChatType: channel.ChatTypeP2P, ChatID: "oc_feedback", SenderID: "ou_feedback"}, Raw: raw}
	// Rows created by the production entrypoints are cleaned within this fixture.
	dbfx.Cleanup(t, `DELETE FROM comment WHERE issue_id=$1`, f.issue)
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE agent_id=$1`, f.agent)
	dbfx.Cleanup(t, `DELETE FROM channel_task_delivery WHERE task_id IN (SELECT id FROM agent_task_queue WHERE agent_id=$1)`, f.agent)
	dbfx.Cleanup(t, `DELETE FROM chat_session WHERE agent_id=$1`, f.agent)
	dbfx.Cleanup(t, `DELETE FROM channel_chat_context_generation WHERE chat_session_id IN (SELECT id FROM chat_session WHERE agent_id=$1)`, f.agent)
	dbfx.Cleanup(t, `DELETE FROM channel_chat_session_binding WHERE installation_id=$1`, f.install)
	dbfx.Cleanup(t, `DELETE FROM chat_message WHERE chat_session_id IN (SELECT id FROM chat_session WHERE agent_id=$1)`, f.agent)
	dbfx.Cleanup(t, `DELETE FROM channel_inbound_dedup WHERE installation_id=$1`, f.install)
	dbfx.Cleanup(t, `DELETE FROM channel_inbound_audit WHERE installation_id=$1`, f.install)
	dbfx.Cleanup(t, `DELETE FROM labrastro_message_feedback WHERE installation_id=$1`, f.install)
	return f
}

func (f *feedbackFixture) report(t *testing.T) (string, string) {
	t.Helper()
	ap := dbfx.Insert(t, "autopilot", testutil.Cols{"workspace_id": testWorkspaceID, "title": "Frozen report source", "assignee_id": f.agent, "status": "active", "execution_mode": "run_only", "created_by_type": "member", "created_by_id": testUserID})
	task := dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed", "completed_at": testutil.Raw("now()")})
	run := dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": ap, "task_id": task, "source": "schedule", "status": "completed", "completed_at": testutil.Raw("now()"), "result": `{"output":"Frozen report"}`})
	dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='run_only',source_scope='run',source_ref_id=NULL,autopilot_id=$2,run_id=$3,source_ref=$4 WHERE id=$1`, f.delivery, ap, run, fmt.Sprintf(`{"run_id":%q,"execution_mode":"run_only"}`, run))
	return ap, run
}

func TestFeedbackReportCreatesRealConversationAndPreservesRun(t *testing.T) {
	f := newFeedbackFixture(t)
	ap, run := f.report(t)
	f.msg.CommandText = "解释报告里的变化原因"
	var original string
	dbfx.QueryRow(t, `SELECT row_to_json(r)::text FROM autopilot_run r WHERE id=$1`, run).Scan(&original)
	f.ingest(t)
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE agent_id=$1`, f.agent); n != 0 {
		t.Fatalf("eager Chat creation: %d", n)
	}
	// Changing today's automation selection must not choose a different agent.
	other := dbfx.Agent(t, "New automation agent", handlerTestRuntimeID(t))
	dbfx.Exec(t, `UPDATE autopilot SET assignee_id=$2 WHERE id=$1`, ap, other)
	f.recover(t)
	f.recover(t)
	row := f.row(t)
	if !row.ChatSessionID.Valid || row.Status != "complete" || row.CommentID.Valid {
		t.Fatalf("not a real report Chat: %+v", row)
	}
	var owner, agent, body, after string
	dbfx.QueryRow(t, `SELECT s.creator_id,s.agent_id,m.content FROM chat_session s JOIN chat_message m ON m.chat_session_id=s.id WHERE s.id=$1`, row.ChatSessionID).Scan(&owner, &agent, &body)
	if owner != testUserID || agent != f.agent || !strings.Contains(body, "Frozen report") || !strings.Contains(body, run) || !strings.HasSuffix(body, f.msg.CommandText) {
		t.Fatalf("scope/actor/context mismatch: %s/%s/%s", owner, agent, body)
	}
	dbfx.QueryRow(t, `SELECT row_to_json(r)::text FROM autopilot_run r WHERE id=$1`, run).Scan(&after)
	if original != after {
		t.Fatal("original terminal run was modified")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE chat_session_id=$1 AND originator_user_id=$2 AND accountable_user_id=$2`, row.ChatSessionID, testUserID); n != 1 {
		t.Fatalf("follow-up task count/identity: %d", n)
	}
	if c, q := f.counts(t); c != 0 || q != 0 {
		t.Fatalf("report invented issue work: %d/%d", c, q)
	}
	// A later ordinary turn continues the actual channel route, with the frozen
	// context still in the same transcript; no synthetic binding is stranded.
	f.msg.MessageID, f.msg.EventID, f.msg.CommandText, f.msg.Text, f.msg.ReplyTo, f.msg.SkipAgentRun = "om_next", "evt_next", "再解释一点", "再解释一点", nil, true
	f.ingest(t)
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1`, row.ChatSessionID); n != 2 {
		t.Fatalf("continuation left the report Chat: %d", n)
	}
}

func TestFeedbackReportSelectionAndPrivateAgent(t *testing.T) {
	for _, kind := range []string{"ambiguous", "multiple", "unanchored_tasks", "explicit", "private", "missing_run"} {
		t.Run(kind, func(t *testing.T) {
			f := newFeedbackFixture(t)
			_, run := f.report(t)
			var key string
			dbfx.QueryRow(t, `SELECT w.issue_prefix||'-'||i.number FROM issue i JOIN workspace w ON w.id=i.workspace_id WHERE i.id=$1`, f.issue).Scan(&key)
			switch kind {
			case "ambiguous":
				f.msg.CommandText = "可以"
			case "multiple":
				f.msg.CommandText = key + " 和 OTHER-999 都继续"
			case "explicit":
				f.msg.CommandText = key + " 请修复边界"
			case "unanchored_tasks":
				f.msg.CommandText = "这些都可以继续"
				dbfx.Exec(t, `UPDATE labrastro_message_delivery SET content_snapshot=$2 WHERE id=$1`, f.delivery, fmt.Sprintf(`{"text":%q}`, key+" and OTHER-999 need decisions"))
			default:
				f.msg.CommandText = "解释原因"
			}
			f.ingest(t)
			if kind == "private" {
				other := dbfx.User(t, "Other owner", "other-"+f.install+"@test.invalid")
				dbfx.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, other)
			}
			if kind == "missing_run" {
				dbfx.Exec(t, `DELETE FROM autopilot_run WHERE id=$1`, run)
			}
			f.recover(t)
			f.recover(t)
			want := 0
			if kind == "explicit" {
				want = 1
			}
			if c, q := f.counts(t); c != want || q != want {
				t.Fatalf("selection wrote/triggered %d/%d want %d", c, q, want)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE agent_id=$1`, f.agent); n != 0 {
				t.Fatalf("refusal/selection created Chat: %d", n)
			}
		})
	}
}

func TestFeedbackChannelCompatibility(t *testing.T) {
	for _, kind := range []string{"ordinary_quote", "no_quote", "group_at", "group_no_at", "unbound", "nonmember", "new", "clear", "issue", "empty_sender"} {
		t.Run(kind, func(t *testing.T) {
			f := newFeedbackFixture(t)
			f.msg.SkipAgentRun = true
			wantFeedback, wantChat := 0, 0
			switch kind {
			case "ordinary_quote":
				dbfx.Exec(t, `UPDATE labrastro_message_receipt SET external_message_id='om_other' WHERE id=$1`, f.receipt)
				f.transport.proof.HasReference = false
				wantChat = 1
			case "no_quote":
				f.msg.ReplyTo = nil
				wantChat = 1
			case "group_at":
				f.msg.Source.ChatType = channel.ChatTypeGroup
				wantFeedback = 1
			case "group_no_at":
				f.msg.Source.ChatType = channel.ChatTypeGroup
				f.msg.AddressedToBot = false
			case "unbound":
				dbfx.Exec(t, `DELETE FROM channel_user_binding WHERE id=$1`, f.binding)
			case "nonmember":
				u := dbfx.User(t, "Nonmember", "nonmember-"+f.install+"@test.invalid")
				dbfx.Exec(t, `UPDATE channel_user_binding SET multica_user_id=$2 WHERE id=$1`, f.binding, u)
			case "new":
				f.msg.CommandText = "/new"
				wantChat = 1
			case "clear":
				f.msg.CommandText = "/clear"
				wantChat = 1
			case "issue":
				f.msg.CommandText = "/issue"
				wantChat = 1
			case "empty_sender":
				f.msg.CommandText = "" // The quote contains /issue; it must never become a command.
			}
			f.ingest(t)
			if c, q := f.counts(t); c != wantFeedback || q != 0 {
				t.Fatalf("entry semantics: comment/task %d/%d", c, q)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE agent_id=$1`, f.agent); n != wantChat {
				t.Fatalf("Chat count=%d want=%d", n, wantChat)
			}
		})
	}
}

func TestFeedbackReplyKeepsSquadLeaderParentRole(t *testing.T) {
	f := newFeedbackFixture(t)
	squad := dbfx.Squad(t, "Feedback squad", f.agent)
	dbfx.SquadMember(t, squad, "agent", f.agent)
	task := dbfx.Task(t, f.agent, testutil.Cols{"issue_id": f.issue, "runtime_id": handlerTestRuntimeID(t), "status": "completed", "is_leader_task": true, "squad_id": squad, "completed_at": testutil.Raw("now()")})
	parent := dbfx.Comment(t, f.issue, "Leader question", testutil.Cols{"author_type": "agent", "author_id": f.agent, "source_task_id": task})
	dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='comment',source_scope='comment',source_ref_id=$2,source_ref=$3 WHERE id=$1`, f.delivery, parent, fmt.Sprintf(`{"source_kind":"comment","issue_id":%q,"comment_id":%q}`, f.issue, parent))
	f.ingest(t)
	f.recover(t)
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE trigger_comment_id=$1 AND is_leader_task AND squad_id=$2 AND agent_id=$3`, f.row(t).CommentID, squad, f.agent); n != 1 {
		t.Fatalf("parent reply lost leader role: %d", n)
	}
}

func TestFeedbackGroupApprovalRevokedAtEachStage(t *testing.T) {
	for _, stage := range []string{"intake", "wake", "ack"} {
		t.Run(stage, func(t *testing.T) {
			f := newFeedbackFixture(t)
			f.msg.Source.ChatType = channel.ChatTypeGroup
			dbfx.Exec(t, `UPDATE labrastro_message_delivery SET target_key='group:oc_feedback',target_snapshot='{"target_type":"group","chat_id":"oc_feedback"}' WHERE id=$1`, f.delivery)
			approval := dbfx.Insert(t, "labrastro_message_approved_target", testutil.Cols{"workspace_id": testWorkspaceID, "installation_id": f.install, "source_kind": "activity", "target_key": "group:oc_feedback", "target_type": "group", "approved_by": testUserID})
			revoke := func() {
				dbfx.Exec(t, `UPDATE labrastro_message_approved_target SET revoked_at=now() WHERE id=$1`, approval)
			}
			if stage == "intake" {
				revoke()
			}
			f.ingest(t)
			if stage == "wake" {
				revoke()
			}
			if stage == "ack" {
				f.h.Bus.Subscribe(protocol.EventTaskQueued, func(events.Event) { revoke() })
			}
			f.recover(t)
			wantComments, wantTasks := 1, 0
			if stage == "intake" {
				wantComments = 0
			}
			if stage == "ack" {
				wantTasks = 1
			}
			if c, q := f.counts(t); c != wantComments || q != wantTasks {
				t.Fatalf("revoked at %s: comments/tasks %d/%d", stage, c, q)
			}
			if len(f.transport.acks) != 0 {
				t.Fatal("acknowledgement escaped after approval revocation")
			}
		})
	}
}

func TestFeedbackWorkspaceDeletionRemovesOwnedData(t *testing.T) {
	f := newFeedbackFixture(t)
	f.ingest(t)
	ws := dbfx.Workspace(t, "Feedback teardown", "feedback-teardown-"+f.install)
	dbfx.Member(t, ws, testUserID, "owner")
	// Seed an otherwise orphaned record, as required by the no-FK teardown
	// contract: workspace ownership alone must be enough to discover it.
	dbfx.Exec(t, `INSERT INTO labrastro_message_feedback(installation_id,inbound_message_id,workspace_id,delivery_id,quoted_message_id,sender_id,user_id,installation_agent_id,chat_id,content,kind)
	SELECT gen_random_uuid(),'orphan-feedback',$2,delivery_id,quoted_message_id,sender_id,user_id,installation_agent_id,chat_id,'private copied text',kind FROM labrastro_message_feedback WHERE installation_id=$1`, f.install, ws)
	req := withURLParam(newRequest(http.MethodDelete, "/api/workspaces/"+ws, nil), "id", ws)
	testutil.Call(t, f.h.DeleteWorkspace, req).Want(http.StatusNoContent)
	if n := dbfx.Count(t, `SELECT count(*) FROM labrastro_message_feedback WHERE workspace_id=$1`, ws); n != 0 {
		t.Fatalf("workspace left %d feedback records", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM labrastro_message_feedback WHERE installation_id=$1`, f.install); n != 1 {
		t.Fatal("teardown affected another workspace")
	}
}

func (f *feedbackFixture) router(t *testing.T, h *Handler) *engine.Router {
	t.Helper()
	r := engine.NewRouter(h.IssueService, h.TaskService, h.Queries, engine.RouterConfig{})
	r.Register(channel.TypeFeishu, lark.NewFeishuResolverSet(lark.NewChannelStore(h.Queries), engine.NewChatSession(h.Queries, h.TxStarter, channel.TypeFeishu, engine.SessionTitles{}), lark.NewAuditLogger(h.Queries), nil, nil, nil))
	r.SetFeedbackHandler(h.HandleMessageFeedback)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if !r.Drain(ctx) {
			t.Error("channel router did not drain")
		}
	})
	return r
}
func (f *feedbackFixture) ingest(t *testing.T) {
	t.Helper()
	if err := f.router(t, f.h).Handle(context.Background(), f.msg); err != nil {
		t.Fatal(err)
	}
}
func (f *feedbackFixture) row(t *testing.T) db.LabrastroMessageFeedback {
	t.Helper()
	fb, err := f.h.Queries.GetLabrastroFeedback(context.Background(), db.GetLabrastroFeedbackParams{InstallationID: parseUUID(f.install), InboundMessageID: f.msg.MessageID})
	if err != nil {
		t.Fatal(err)
	}
	return fb
}
func (f *feedbackFixture) counts(t *testing.T) (int, int) {
	t.Helper()
	return dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id=$1 AND author_type='member'`, f.issue), dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2`, f.issue, f.agent)
}
func (f *feedbackFixture) recover(t *testing.T) {
	t.Helper()
	dbfx.Exec(t, `UPDATE labrastro_message_feedback SET next_attempt_at=now() WHERE installation_id=$1`, f.install)
	if err := f.h.ProcessMessageFeedback(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFeedbackRouterSingleIssueParentAndOriginator(t *testing.T) {
	f := newFeedbackFixture(t)
	parent := dbfx.Comment(t, f.issue, "original result", testutil.Cols{"author_type": "agent", "author_id": f.agent, "resolved_at": testutil.Raw("now()"), "resolved_by_type": "member", "resolved_by_id": testUserID})
	dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='comment',source_scope='comment',source_ref=$2 WHERE id=$1`, f.delivery, fmt.Sprintf(`{"source_kind":"comment","issue_id":%q,"comment_id":%q}`, f.issue, parent))
	f.ingest(t)
	if c, q := f.counts(t); c != 1 || q != 0 {
		t.Fatalf("after durable intake: comments=%d tasks=%d", c, q)
	}
	f.recover(t)
	row := f.row(t)
	comment, err := f.h.Queries.GetComment(context.Background(), row.CommentID)
	if err != nil {
		t.Fatal(err)
	}
	if comment.Content != f.msg.CommandText || comment.ParentID != parseUUID(parent) || comment.AuthorID != parseUUID(testUserID) {
		t.Fatalf("wrong comment identity/body/parent: %+v", comment)
	}
	if c, q := f.counts(t); c != 1 || q != 1 {
		t.Fatalf("after recovery: comments=%d tasks=%d", c, q)
	}
	if f.queued.Load() != 1 {
		t.Fatalf("effective queued events=%d", f.queued.Load())
	}
	var originator, accountable string
	dbfx.QueryRow(t, `SELECT originator_user_id,accountable_user_id FROM agent_task_queue WHERE trigger_comment_id=$1`, row.CommentID).Scan(&originator, &accountable)
	if originator != testUserID || accountable != testUserID {
		t.Fatalf("attribution borrowed another actor: %s/%s", originator, accountable)
	}
	root, _ := f.h.Queries.GetComment(context.Background(), parseUUID(parent))
	if root.ResolvedAt.Valid {
		t.Fatal("thread stayed resolved")
	}
	if row.Status != "complete" || !row.AcknowledgedAt.Valid {
		t.Fatalf("unfinished feedback: %+v", row)
	}
}

// These faults surround real SQL and COMMIT, rather than replacing a service
// with a stub that merely reports that an enqueue was called.
type feedbackFaultStarter struct {
	txStarter
	query   string
	commit  bool
	once    atomic.Bool
	observe func(pgx.Tx)
}

func (f *feedbackFaultStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := f.txStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &feedbackFaultTx{Tx: tx, fault: f}, nil
}

type feedbackFaultTx struct {
	pgx.Tx
	fault *feedbackFaultStarter
}

func (t *feedbackFaultTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	r := t.Tx.QueryRow(ctx, sql, args...)
	if t.fault.query != "" && strings.Contains(sql, "-- name: "+t.fault.query+" ") && t.fault.once.CompareAndSwap(false, true) {
		return feedbackFaultRow{Row: r, after: func() {
			if t.fault.observe != nil {
				t.fault.observe(t.Tx)
			}
		}}
	}
	return r
}

func (t *feedbackFaultTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tag, err := t.Tx.Exec(ctx, sql, args...)
	if err == nil && t.fault.query != "" && strings.Contains(sql, "-- name: "+t.fault.query+" ") && t.fault.once.CompareAndSwap(false, true) {
		if t.fault.observe != nil {
			t.fault.observe(t.Tx)
		}
		return tag, errors.New("injected failure after SQL landed")
	}
	return tag, err
}
func (t *feedbackFaultTx) Commit(ctx context.Context) error {
	err := t.Tx.Commit(ctx)
	if err == nil && t.fault.commit && t.fault.once.CompareAndSwap(false, true) {
		if t.fault.observe != nil {
			t.fault.observe(nil)
		}
		return errors.New("injected missing commit acknowledgement")
	}
	return err
}

type feedbackFaultRow struct {
	pgx.Row
	after func()
}

func (r feedbackFaultRow) Scan(dest ...any) error {
	if err := r.Row.Scan(dest...); err != nil {
		return err
	}
	r.after()
	return errors.New("injected failure after SQL landed")
}

func TestFeedbackCommentAndDedupRollbackTogether(t *testing.T) {
	f := newFeedbackFixture(t)
	var observed bool
	fault := &feedbackFaultStarter{txStarter: testPool, query: "CreateComment", observe: func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(context.Background(), `SELECT count(*) FROM comment WHERE issue_id=$1`, f.issue).Scan(&n); err != nil {
			t.Fatal(err)
		}
		observed = n == 1
	}}
	f.h.TxStarter = fault
	if err := f.router(t, f.h).Handle(context.Background(), f.msg); err == nil {
		t.Fatal("expected intake failure")
	}
	if !observed {
		t.Fatal("fault never observed inserted comment")
	}
	if c, q := f.counts(t); c != 0 || q != 0 {
		t.Fatalf("rollback leaked %d comments/%d tasks", c, q)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM labrastro_message_feedback WHERE installation_id=$1`, f.install); n != 0 {
		t.Fatalf("rollback left %d dedup rows", n)
	}
	f.h.TxStarter = testPool
	f.ingest(t)
	f.recover(t)
	if c, q := f.counts(t); c != 1 || q != 1 {
		t.Fatalf("retry produced %d comments/%d tasks", c, q)
	}
}

func TestFeedbackDeletionRollsBackRedactionWithComment(t *testing.T) {
	f := newFeedbackFixture(t)
	parent := dbfx.Comment(t, f.issue, "report", testutil.Cols{"author_type": "agent", "author_id": f.agent})
	dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='comment',source_scope='comment',source_ref_id=$2,source_ref=$3 WHERE id=$1`, f.delivery, parent, fmt.Sprintf(`{"source_kind":"comment","issue_id":%q,"comment_id":%q}`, f.issue, parent))
	f.ingest(t)
	observed := false
	f.h.TxStarter = &feedbackFaultStarter{txStarter: testPool, query: "RedactLabrastroFeedbackByComment", observe: func(tx pgx.Tx) {
		var remaining, redacted int
		if err := tx.QueryRow(context.Background(), `SELECT count(*) FROM comment WHERE id=$1`, parent).Scan(&remaining); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(context.Background(), `SELECT count(*) FROM labrastro_message_feedback WHERE installation_id=$1 AND content=''`, f.install).Scan(&redacted); err != nil {
			t.Fatal(err)
		}
		observed = remaining == 0 && redacted == 1 && f.row(t).Content == f.msg.CommandText && dbfx.Count(t, `SELECT count(*) FROM comment WHERE id=$1`, parent) == 1
	}}
	req := withURLParam(newRequest(http.MethodDelete, "/api/comments/"+parent, nil), "commentId", parent)
	testutil.Call(t, f.h.DeleteComment, req).Want(http.StatusInternalServerError)
	if !observed {
		t.Fatal("fault did not surround real deletion and redaction before commit")
	}
	if c, q := f.counts(t); c != 1 || q != 0 {
		t.Fatalf("failed cleanup left comment/task %d/%d", c, q)
	}
	if f.row(t).Content != f.msg.CommandText {
		t.Fatal("rollback lost the copied feedback")
	}
	f.h.TxStarter = testPool
	f.recover(t)
	if c, q := f.counts(t); c != 1 || q != 1 {
		t.Fatalf("recovery after rolled-back deletion: %d/%d", c, q)
	}
}

func TestFeedbackRecoveryAfterCommentCommitAndWakeFailure(t *testing.T) {
	f := newFeedbackFixture(t)
	f.ingest(t)
	var observed bool
	fault := &feedbackFaultStarter{txStarter: testPool, query: "CreateAgentTask", observe: func(tx pgx.Tx) {
		var n int
		if err := tx.QueryRow(context.Background(), `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, f.issue).Scan(&n); err != nil {
			t.Fatal(err)
		}
		c, q := f.counts(t)
		observed = n == 1 && c == 1 && q == 0
	}}
	f.h.TxStarter = fault
	if err := f.h.ProcessMessageFeedback(context.Background()); err == nil {
		t.Fatal("expected enqueue phase failure")
	}
	if !observed {
		t.Fatal("did not observe durable comment plus uncommitted task")
	}
	if c, q := f.counts(t); c != 1 || q != 0 {
		t.Fatalf("phase rollback: %d/%d", c, q)
	}
	if f.row(t).Status != "pending" || f.queued.Load() != 0 {
		t.Fatal("failed transaction published success")
	}
	// Restart with a new Handler and TaskService; only PostgreSQL carries state.
	restarted := *f.h
	restarted.TxStarter = testPool
	restarted.TaskService = service.NewTaskService(restarted.Queries, testPool, restarted.Hub, restarted.Bus)
	f.h = &restarted
	f.recover(t)
	if c, q := f.counts(t); c != 1 || q != 1 {
		t.Fatalf("restart recovery: %d/%d", c, q)
	}
	if f.queued.Load() != 1 {
		t.Fatalf("effective queued events=%d", f.queued.Load())
	}
}

func TestFeedbackRecoveryAfterTaskCommitMissingConfirmation(t *testing.T) {
	for _, missingCommit := range []bool{false, true} {
		t.Run(fmt.Sprintf("commit_ack_missing_%t", missingCommit), func(t *testing.T) {
			f := newFeedbackFixture(t)
			f.ingest(t)
			observed := false
			if missingCommit {
				f.h.TxStarter = &feedbackFaultStarter{txStarter: testPool, commit: true, observe: func(pgx.Tx) { c, q := f.counts(t); observed = c == 1 && q == 1 && f.row(t).Status == "complete" }}
			} else {
				f.transport.ackErr = errors.New("injected platform acknowledgement failure")
				f.transport.beforeAck = func() { c, q := f.counts(t); observed = c == 1 && q == 1 && !f.row(t).AcknowledgedAt.Valid }
			}
			if err := f.h.ProcessMessageFeedback(context.Background()); err == nil {
				t.Fatal("expected missing acknowledgement")
			}
			if !observed {
				t.Fatal("fault did not occur after task was externally visible")
			}
			// Simulate the daemon consuming the persisted task before the retry.
			dbfx.Exec(t, `UPDATE agent_task_queue SET status='completed',delivered_comment_ids=ARRAY[trigger_comment_id] WHERE issue_id=$1`, f.issue)
			f.h.TxStarter = testPool
			f.transport.ackErr = nil
			f.transport.beforeAck = nil
			f.recover(t)
			f.recover(t)
			if c, q := f.counts(t); c != 1 || q != 1 {
				t.Fatalf("ack replay generated a second effective task: %d/%d", c, q)
			}
			if !f.row(t).AcknowledgedAt.Valid {
				t.Fatal("ack stage did not recover")
			}
		})
	}
}

func TestFeedbackMultipleReplicasAndReorderedCallbacks(t *testing.T) {
	f := newFeedbackFixture(t)
	second := *f.h
	second.TaskService = service.NewTaskService(second.Queries, testPool, second.Hub, second.Bus)
	routers := []*engine.Router{f.router(t, f.h), f.router(t, &second)}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			msg := f.msg
			msg.EventID = fmt.Sprint("evt_", i)
			errs <- routers[i%2].Handle(context.Background(), msg)
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	prior := f.row(t)
	errs = make(chan error, 2)
	for _, h := range []*Handler{f.h, &second} {
		wg.Add(1)
		go func(h *Handler) { defer wg.Done(); errs <- h.processMessageFeedback(context.Background(), prior) }(h)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// A replay with a changed body/target cannot replace the first input.
	f.msg.CommandText = "伪造的重复正文"
	f.msg.ReplyTo = &channel.ReplyCtx{MessageID: "om_other"}
	f.ingest(t)
	if c, q := f.counts(t); c != 1 || q != 1 {
		t.Fatalf("replicas produced %d comments/%d tasks", c, q)
	}
	if f.queued.Load() != 1 {
		t.Fatalf("effective queued events=%d", f.queued.Load())
	}
	if f.row(t).Content != "修复边界" {
		t.Fatal("duplicate payload rewrote accepted input")
	}
}

func TestFeedbackReceiptRecoveryAndTrustRefusals(t *testing.T) {
	for _, kind := range []string{"lost_receipt", "bad_signature", "human_forgery", "foreign_bot_chat", "diagnostic"} {
		t.Run(kind, func(t *testing.T) {
			f := newFeedbackFixture(t)
			switch kind {
			case "lost_receipt":
				dbfx.Exec(t, `UPDATE labrastro_message_receipt SET external_message_id=NULL WHERE id=$1`, f.receipt)
			case "bad_signature":
				dbfx.Exec(t, `UPDATE labrastro_message_receipt SET external_message_id=NULL WHERE id=$1`, f.receipt)
				f.transport.proof.Signed = false
			case "human_forgery":
				f.transport.proof.Bot = false
			case "foreign_bot_chat":
				f.transport.proof.ChatID = "oc_other"
			case "diagnostic":
				dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='test_send',source_ref_id=NULL WHERE id=$1`, f.delivery)
			}
			f.ingest(t)
			f.recover(t)
			want := 0
			if kind == "lost_receipt" {
				want = 1
			}
			if c, q := f.counts(t); c != want || q != want {
				t.Fatalf("%s: comments=%d tasks=%d want=%d", kind, c, q, want)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE agent_id=$1`, f.agent); n != 0 {
				t.Fatalf("recognized source fell through to Chat: %d", n)
			}
		})
	}
}

func TestFeedbackRevocationAndParentDeletion(t *testing.T) {
	for _, kind := range []string{"unbound", "removed_member", "rebound_bot", "deleted_issue", "deleted_parent", "deleted_ancestor", "private_agent"} {
		t.Run(kind, func(t *testing.T) {
			f := newFeedbackFixture(t)
			var parent string
			var ancestor string
			if kind == "deleted_parent" || kind == "deleted_ancestor" {
				parent = dbfx.Comment(t, f.issue, "report", testutil.Cols{"author_type": "agent", "author_id": f.agent})
				if kind == "deleted_ancestor" {
					ancestor = dbfx.Comment(t, f.issue, "Root", testutil.Cols{"author_type": "agent", "author_id": f.agent})
					dbfx.Exec(t, `UPDATE comment SET parent_id=$2 WHERE id=$1`, parent, ancestor)
				}
				dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='comment',source_scope='comment',source_ref=$2 WHERE id=$1`, f.delivery, fmt.Sprintf(`{"source_kind":"comment","issue_id":%q,"comment_id":%q}`, f.issue, parent))
			}
			f.ingest(t)
			switch kind {
			case "unbound":
				dbfx.Exec(t, `DELETE FROM channel_user_binding WHERE id=$1`, f.binding)
			case "removed_member":
				dbfx.Exec(t, `DELETE FROM member WHERE workspace_id=$1 AND user_id=$2`, testWorkspaceID, testUserID)
				t.Cleanup(func() {
					dbfx.Exec(t, `INSERT INTO member(workspace_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING`, testWorkspaceID, testUserID)
				})
			case "rebound_bot":
				other := dbfx.Agent(t, "Other bot agent", handlerTestRuntimeID(t))
				dbfx.Exec(t, `UPDATE channel_installation SET agent_id=$2 WHERE id=$1`, f.install, other)
			case "deleted_issue":
				req := withURLParam(newRequest(http.MethodDelete, "/api/issues/"+f.issue, nil), "id", f.issue)
				testutil.Call(t, f.h.DeleteIssue, req).Want(http.StatusNoContent)
			case "deleted_parent", "deleted_ancestor":
				if ancestor != "" {
					parent = ancestor
				}
				req := withURLParam(newRequest(http.MethodDelete, "/api/comments/"+parent, nil), "commentId", parent)
				testutil.Call(t, f.h.DeleteComment, req).Want(http.StatusNoContent)
			case "private_agent":
				other := dbfx.User(t, "Private owner", "private-"+f.install+"@test.invalid")
				dbfx.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, other)
			}
			f.recover(t)
			_, q := f.counts(t)
			if q != 0 {
				t.Fatalf("revoked/deleted source triggered %d tasks", q)
			}
			if kind == "deleted_issue" || kind == "deleted_parent" || kind == "deleted_ancestor" {
				row := f.row(t)
				if row.Content != "" || row.CommentID.Valid || row.ParentCommentID.Valid {
					t.Fatalf("deleted source retained feedback data: %+v", row)
				}
			}
		})
	}
}
