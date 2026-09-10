package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (f *conversationFixture) router(t *testing.T) *engine.Router {
	t.Helper()
	r := engine.NewRouter(f.h.IssueService, f.h.TaskService, f.h.Queries, engine.RouterConfig{})
	r.Register(channel.TypeFeishu, lark.NewFeishuResolverSet(lark.NewChannelStore(f.h.Queries), engine.NewChatSession(f.h.Queries, f.h.TxStarter, channel.TypeFeishu, engine.SessionTitles{}), lark.NewAuditLogger(f.h.Queries), nil, nil, nil))
	r.SetConversationHandler(f.h.HandleChannelConversation)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if !r.Drain(ctx) {
			t.Error("router did not drain")
		}
	})
	return r
}

func (f *conversationFixture) ingest(t *testing.T) {
	t.Helper()
	if err := f.router(t).Handle(context.Background(), f.msg); err != nil {
		t.Fatal(err)
	}
}

func (f *conversationFixture) counts(t *testing.T) (int, int, int) {
	t.Helper()
	return dbfx.Count(t, `SELECT count(*) FROM chat_message m JOIN chat_session s ON s.id=m.chat_session_id WHERE s.agent_id=$1 AND m.role='user'`, f.agent),
		dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id=$1 AND chat_session_id IS NOT NULL`, f.agent),
		dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id=$1`, f.issue)
}

func (f *conversationFixture) task(t *testing.T) db.AgentTaskQueue {
	t.Helper()
	var id string
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE agent_id=$1 AND chat_session_id IS NOT NULL ORDER BY created_at LIMIT 1`, f.agent).Scan(&id)
	task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func (f *conversationFixture) token(t *testing.T, task db.AgentTaskQueue) string {
	t.Helper()
	token := "mat_conversation_" + uuidToString(task.ID)
	dbfx.Insert(t, "task_token", testutil.Cols{"task_id": task.ID, "agent_id": task.AgentID, "user_id": testUserID, "workspace_id": testWorkspaceID, "token_hash": auth.HashToken(token), "expires_at": testutil.Raw("now()+interval '1 hour'")})
	return token
}

func (f *conversationFixture) comment(t *testing.T, token, body, parent string) string {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"content": body, "parent_id": nullableConversationParent(parent)})
	req := httptest.NewRequest(http.MethodPost, "/api/issues/"+f.issue+"/comments", strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer "+token)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", f.issue)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	var response struct {
		ID string `json:"id"`
	}
	testutil.Call(t, middleware.Auth(f.h.Queries, nil, nil)(http.HandlerFunc(f.h.CreateComment)).ServeHTTP, req).Want(http.StatusCreated).JSON(&response)
	return response.ID
}

func TestConversationUnboundAndBoundAgentComment(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(fmt.Sprint(bound), func(t *testing.T) {
			f := newConversationFixture(t)
			if !bound {
				dbfx.Exec(t, `DELETE FROM channel_user_binding WHERE id=$1`, f.binding)
			}
			f.msg.Source.ChatType = channel.ChatTypeGroup
			parent := dbfx.Comment(t, f.issue, "original review", testutil.Cols{"author_type": "agent", "author_id": f.agent})
			dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='comment',source_scope='comment',source_ref=$2 WHERE id=$1`, f.delivery, fmt.Sprintf(`{"source_kind":"comment","issue_id":%q,"comment_id":%q}`, f.issue, parent))
			f.ingest(t)
			f.ingest(t)
			inputs, runs, comments := f.counts(t)
			if inputs != 1 || runs != 1 || comments != 1 {
				t.Fatalf("input/run/comment = %d/%d/%d", inputs, runs, comments)
			}
			task := f.task(t)
			if task.OriginatorSource.String != channel.ConversationOrigin || task.OriginatorUserID != parseUUID(testUserID) || task.AccountableUserID != task.OriginatorUserID {
				t.Fatalf("wrong authorization: %+v", task)
			}
			var body string
			dbfx.QueryRow(t, `SELECT content FROM chat_message WHERE task_id=$1 AND role='user'`, task.ID).Scan(&body)
			for _, text := range []string{f.issue, parent, "Frozen report", "ou_feedback", "om_input"} {
				if !strings.Contains(body, text) {
					t.Fatalf("missing context %q: %s", text, body)
				}
			}
			// A deterministic agent stand-in uses the real task-token middleware and
			// comment handler. Model understanding is deliberately not mocked as proof.
			dbfx.Exec(t, `UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1`, task.ID)
			id := f.comment(t, f.token(t, task), "项目群反馈：请补充失败重试方案。来源 om_input / ou_feedback。", parent)
			c, err := f.h.Queries.GetComment(context.Background(), parseUUID(id))
			if err != nil {
				t.Fatal(err)
			}
			if c.AuthorType != "agent" || c.AuthorID != task.AgentID || c.SourceTaskID != task.ID || c.ParentID != parseUUID(parent) {
				t.Fatalf("wrong agent comment lineage: %+v", c)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id=$1 AND author_type='member'`, f.issue); n != 0 {
				t.Fatal("member impersonation")
			}
		})
	}
}

func TestConversationScopeCommandsAndIsolation(t *testing.T) {
	for _, mode := range []string{"unconfigured", "revoked", "grantor_removed", "private_changed", "unaddressed", "unknown_chat", "issue_command", "report_question", "ambiguous"} {
		t.Run(mode, func(t *testing.T) {
			f := newConversationFixture(t)
			f.msg.ReplyTo = nil
			switch mode {
			case "unconfigured":
				dbfx.Exec(t, `UPDATE channel_installation SET config=config-'conversation' WHERE id=$1`, f.install)
			case "revoked":
				dbfx.Exec(t, `UPDATE channel_installation SET status='revoked' WHERE id=$1`, f.install)
			case "grantor_removed":
				dbfx.Exec(t, `UPDATE channel_installation SET config=jsonb_set(config,'{conversation,authorized_by}',to_jsonb($2::text)) WHERE id=$1`, f.install, dbfx.User(t, "outsider", f.install+"@test.invalid"))
			case "private_changed":
				dbfx.Exec(t, `UPDATE agent SET owner_id=$2,permission_mode='private' WHERE id=$1`, f.agent, dbfx.User(t, "other", f.install+"@test.invalid"))
			case "unaddressed":
				f.msg.Source.ChatType = channel.ChatTypeGroup
				f.msg.AddressedToBot = false
			case "unknown_chat":
				f.msg.Source.ChatID = "oc_unconfigured"
			case "issue_command":
				f.msg.Text = "/issue forbidden direct member command"
				f.msg.CommandText = f.msg.Text
			case "report_question":
				f.report(t)
				f.msg.ReplyTo = &channel.ReplyCtx{MessageID: "om_report"}
				f.msg.Text = "解释这份报告"
				f.msg.CommandText = f.msg.Text
			case "ambiguous":
				f.msg.Text = "可以，全部继续"
				f.msg.CommandText = f.msg.Text
			}
			f.ingest(t)
			inputs, runs, comments := f.counts(t)
			want := 0
			if mode == "issue_command" || mode == "report_question" || mode == "ambiguous" {
				want = 1
			}
			if inputs != want || runs != want || comments != 0 {
				t.Fatalf("input/run/comment = %d/%d/%d", inputs, runs, comments)
			}
		})
	}
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	for i, thread := range []string{"", "topic-a", "topic-b", ""} {
		f.msg.MessageID = fmt.Sprint("om_", i)
		f.msg.Source.ChatType = channel.ChatTypeGroup
		if i == 3 {
			f.msg.Source.ChatType = channel.ChatTypeP2P
		}
		f.msg.Source.ThreadID = thread
		f.ingest(t)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE agent_id=$1`, f.agent); n != 4 {
		t.Fatalf("isolated sessions=%d", n)
	}
}

func TestConversationNotificationContextCannotAuthorize(t *testing.T) {
	for _, invalid := range []string{"human_message", "other_chat", "bad_signature", "diagnostic", "unapproved_group"} {
		t.Run(invalid, func(t *testing.T) {
			f := newConversationFixture(t)
			switch invalid {
			case "human_message":
				f.transport.proof.Bot = false
			case "other_chat":
				f.transport.proof.ChatID = "oc_other"
			case "bad_signature":
				f.transport.proof.Signed = false
			case "diagnostic":
				dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='test_send',source_ref_id=NULL WHERE id=$1`, f.delivery)
			case "unapproved_group":
				dbfx.Exec(t, `UPDATE labrastro_message_delivery SET target_snapshot='{"target_type":"group","chat_id":"oc_feedback"}' WHERE id=$1`, f.delivery)
			}
			f.ingest(t)
			if inputs, runs, comments := f.counts(t); inputs != 0 || runs != 0 || comments != 0 {
				t.Fatalf("untrusted source created %d/%d/%d input/run/comment", inputs, runs, comments)
			}
		})
	}
}

func TestConversationRevocationSurvivesBotBackfill(t *testing.T) {
	f := newConversationFixture(t)
	writes := 0
	store := lark.NewChannelStore(db.New(conversationConfigRace{DBTX: testPool, revoke: func() {
		writes++
		dbfx.Exec(t, `UPDATE channel_installation SET config=jsonb_set(config,'{conversation}','null') WHERE id=$1`, f.install)
	}}))
	if err := store.SetLarkInstallationBotUnionID(context.Background(), lark.SetInstallationBotUnionIDParams{
		ID: parseUUID(f.install), BotUnionID: pgtype.Text{String: "on_refreshed", Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	saved, err := store.GetLarkInstallation(context.Background(), parseUUID(f.install))
	if err != nil {
		t.Fatal(err)
	}
	if writes != 1 || saved.Conversation != nil || saved.BotUnionID.String != "on_refreshed" || saved.AppID != f.app {
		t.Fatalf("backfill replaced current consent or bot config: interleavings=%d, grant=%+v", writes, saved.Conversation)
	}
}

func TestConversationAtomicIntakeAndLostCommit(t *testing.T) {
	for _, mode := range []string{"CreateChatMessage", "CreateChatTask", "commit"} {
		t.Run(mode, func(t *testing.T) {
			f := newConversationFixture(t)
			f.msg.ReplyTo = nil
			// Precreate the route so the injected COMMIT is the input+task transaction.
			f.ingest(t)
			first := f.task(t)
			dbfx.Exec(t, `UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1`, first.ID)
			f.msg.MessageID = "om_fault"
			f.msg.Text = "second input"
			fault := &feedbackFaultStarter{txStarter: testPool, query: mode, commit: mode == "commit"}
			fault.observe = func(tx pgx.Tx) {
				// Independent connection cannot see uncommitted input/task writes.
				inputs, runs, _ := f.counts(t)
				want := 1
				if tx == nil {
					want = 2
				}
				if inputs != want || runs != want {
					t.Fatalf("observer saw partial commit: %d/%d", inputs, runs)
				}
			}
			f.h.TxStarter = fault
			err := f.router(t).Handle(context.Background(), f.msg)
			if err == nil || !fault.once.Load() {
				t.Fatalf("fault not exercised: %v", err)
			}
			inputs, runs, _ := f.counts(t)
			want := 1
			if mode == "commit" {
				want = 2
			}
			if inputs != want || runs != want {
				t.Fatalf("partial intake %d/%d", inputs, runs)
			}
			f.h.TxStarter = testPool
			f.ingest(t)
			f.ingest(t)
			inputs, runs, _ = f.counts(t)
			if inputs != 2 || runs != 2 {
				t.Fatalf("recovery input/run=%d/%d", inputs, runs)
			}
		})
	}
}

func TestConversationDuplicateReplicasAndRevocation(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	routers := []*engine.Router{f.router(t), f.router(t)}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- routers[i%2].Handle(context.Background(), f.msg) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	inputs, runs, _ := f.counts(t)
	if inputs != 1 || runs != 1 {
		t.Fatalf("duplicate intake %d/%d", inputs, runs)
	}
	task := f.task(t)
	if err := channel.AuthorizeConversationTask(context.Background(), f.h.Queries, task, parseUUID(testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if err := channel.AuthorizeConversationTask(context.Background(), f.h.Queries, task, parseUUID(f.issue)); !errors.Is(err, channel.ErrConversationDenied) {
		t.Fatal("cross-workspace grant admitted")
	}
	token := f.token(t, task)
	req := httptest.NewRequest(http.MethodPost, "/api/issues/"+f.issue+"/comments/unused/sub-issues", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	testutil.Call(t, middleware.Auth(f.h.Queries, nil, nil)(RequireHumanActor(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("external task bypassed member-only command")
	}))).ServeHTTP, req).Want(http.StatusForbidden)
	dbfx.Exec(t, `UPDATE channel_installation SET config=config-'conversation' WHERE id=$1`, f.install)
	req = httptest.NewRequest(http.MethodGet, "/api/issues/"+f.issue, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	testutil.Call(t, middleware.Auth(f.h.Queries, nil, nil)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("revoked task reached tool") })).ServeHTTP, req).Want(http.StatusForbidden)
}

func TestConversationReorderedInputAndFirstPartyContinuation(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	for _, id := range []string{"om_later", "om_earlier", "om_later"} {
		f.msg.MessageID = id
		f.msg.Text, f.msg.CommandText = "arrived: "+id, "arrived: "+id
		f.ingest(t)
	}
	if inputs, runs, comments := f.counts(t); inputs != 2 || runs != 2 || comments != 0 {
		t.Fatalf("reordered input/run/comment=%d/%d/%d", inputs, runs, comments)
	}
	root := f.task(t)
	var firstBody string
	dbfx.QueryRow(t, `SELECT content FROM chat_message WHERE task_id=$1 AND role='user'`, root.ID).Scan(&firstBody)
	if !strings.Contains(firstBody, "om_later") {
		t.Fatal("distinct messages should keep arrival order")
	}
	// A fresh first-party action in this Chat uses the member's authority and
	// replies only in the application, even after external consent is revoked.
	dbfx.Exec(t, `UPDATE channel_installation SET config=config-'conversation' WHERE id=$1`, f.install)
	sessionID := uuidToString(root.ChatSessionID)
	req := newRequest(http.MethodPost, "/api/chat-sessions/"+sessionID+"/messages", map[string]any{"content": "a new member action"})
	req = withChatTestWorkspaceCtx(t, withURLParam(req, "sessionId", sessionID))
	var sent SendChatMessageResponse
	testutil.Call(t, f.h.SendChatMessage, req).Want(http.StatusCreated).JSON(&sent)
	var id string
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE chat_session_id=$1 ORDER BY created_at DESC LIMIT 1`, root.ChatSessionID).Scan(&id)
	memberTask, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(id))
	if err != nil {
		t.Fatal(err)
	}
	if memberTask.OriginatorSource.String != "direct_human" {
		t.Fatalf("first-party origin = %s", memberTask.OriginatorSource.String)
	}
	if err := channel.AuthorizeConversationTask(context.Background(), f.h.Queries, memberTask, parseUUID(testWorkspaceID)); err != nil {
		t.Fatalf("fresh member action borrowed external consent: %v", err)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM channel_task_delivery WHERE task_id=$1`, memberTask.ID); n != 0 {
		t.Fatal("first-party action gained external reply")
	}
}

func TestConversationLegacyTombstoneAndCommentRetryLimit(t *testing.T) {
	f := newConversationFixture(t)
	dbfx.Exec(t, `INSERT INTO labrastro_message_feedback (installation_id,inbound_message_id,workspace_id,delivery_id,quoted_message_id,sender_id,user_id,installation_agent_id,chat_id,content,kind,status) VALUES ($1,$2,$3,$4,'om_report','ou_feedback',$5,$6,'oc_feedback','legacy input','comment','pending')`, f.install, f.msg.MessageID, testWorkspaceID, f.delivery, testUserID, f.agent)
	f.ingest(t)
	inputs, runs, comments := f.counts(t)
	if inputs != 0 || runs != 0 || comments != 0 {
		t.Fatal("legacy input was consumed twice")
	}
	f.msg.MessageID = "om_new"
	f.ingest(t)
	task := f.task(t)
	token := f.token(t, task)
	// The ordinary comment API does not expose an idempotency key. Simulate
	// a lost HTTP response by discarding the first result and retrying it.
	f.comment(t, token, "same comment after lost confirmation", "")
	f.comment(t, token, "same comment after lost confirmation", "")
	if n := dbfx.Count(t, `SELECT count(*) FROM comment WHERE source_task_id=$1`, task.ID); n != 2 {
		t.Fatalf("normal API retry guarantee changed: %d", n)
	}
}

func nullableConversationParent(parent string) any {
	if parent == "" {
		return nil
	}
	return parent
}

func TestConversationGrantUsesActualAuthorizerAndRejectsMachines(t *testing.T) {
	f := newConversationFixture(t)
	grantor := dbfx.User(t, "Conversation authorizer", f.install+"@grant.test")
	dbfx.Member(t, testWorkspaceID, grantor, "member")
	dbfx.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, grantor)
	request := func(actor string) *http.Request {
		req := httptest.NewRequest(http.MethodPut, "/api/workspaces/"+testWorkspaceID+"/lark/installations/"+f.install+"/conversation", strings.NewReader(`{"scope":"workspace","chats":[{"chat_id":"oc_feedback","chat_type":"p2p"}],"authorized_by":"forged"}`))
		req.Header.Set("X-User-ID", grantor)
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		req.Header.Set("X-Actor-Source", actor)
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", testWorkspaceID)
		rc.URLParams.Add("installationId", f.install)
		return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	}
	testutil.Call(t, f.h.SetLarkConversationGrant, request("task_token")).Want(http.StatusForbidden)
	var saved struct {
		Conversation channel.ConversationGrant `json:"conversation"`
	}
	testutil.Call(t, f.h.SetLarkConversationGrant, request("")).Want(http.StatusOK).JSON(&saved)
	if saved.Conversation.AuthorizedBy != grantor || saved.Conversation.ID == f.install {
		t.Fatalf("grant not issued by server: %+v", saved)
	}
	f.msg.ReplyTo = nil
	f.ingest(t)
	task := f.task(t)
	if task.OriginatorUserID != parseUUID(grantor) || task.AccountableUserID != parseUUID(grantor) {
		t.Fatal("installer was substituted for explicit authorizer")
	}
	var installer string
	dbfx.QueryRow(t, `SELECT installer_user_id FROM channel_installation WHERE id=$1`, f.install).Scan(&installer)
	if installer != testUserID {
		t.Fatal("installation identity was rewritten")
	}
	// Task-token user remains the runtime owner in the existing protocol.
	// Normal delegation must resolve the grantor from the real source task.
	private := dbfx.Agent(t, "Grantor private agent", handlerTestRuntimeID(t), testutil.Cols{"owner_id": grantor, "permission_mode": "private"})
	f.comment(t, f.token(t, task), "Review [private](mention://agent/"+private+")", "")
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id=$1 AND originator_user_id=$2 AND delegated_from_task_id=$3`, private, grantor, task.ID); n != 1 {
		t.Fatal("normal tool delegation lost the actual grantor")
	}
}

func TestConversationPrivateInvocationAndDelegatedRevocation(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	task := f.task(t)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1`, task.ID)
	token := f.token(t, task)
	otherOwner := dbfx.User(t, "Private owner", f.install+"@private.test")
	private := dbfx.Agent(t, "Private target", handlerTestRuntimeID(t), testutil.Cols{"owner_id": otherOwner, "permission_mode": "private"})
	f.comment(t, token, "Please review [private](mention://agent/"+private+")", "")
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id=$1`, private); n != 0 {
		t.Fatal("integration invoked another member's private agent")
	}
	public := dbfx.Agent(t, "Allowed collaborator", handlerTestRuntimeID(t))
	f.comment(t, token, "Please review [collaborator](mention://agent/"+public+")", "")
	var childID string
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE agent_id=$1 AND issue_id=$2`, public, f.issue).Scan(&childID)
	child, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(childID))
	if err != nil {
		t.Fatal(err)
	}
	if child.DelegatedFromTaskID != task.ID || child.OriginatorUserID != task.OriginatorUserID {
		t.Fatal("normal comment tool lost integration lineage")
	}
	dbfx.Exec(t, `UPDATE channel_installation SET config=config-'conversation' WHERE id=$1`, f.install)
	if err := channel.AuthorizeConversationTask(context.Background(), f.h.Queries, child, parseUUID(testWorkspaceID)); !errors.Is(err, channel.ErrConversationDenied) {
		t.Fatalf("delegation escaped revocation: %v", err)
	}
}

func TestConversationCommentDependencyGateAndLostResponse(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	task := f.task(t)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1`, task.ID)
	worker := dbfx.Agent(t, "Worker", handlerTestRuntimeID(t))
	parent := dbfx.Issue(t, "Parent")
	blocker := dbfx.Issue(t, "Blocking task")
	dbfx.Exec(t, `UPDATE issue SET parent_issue_id=$2 WHERE id=$1`, f.issue, parent)
	dbfx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": parent, "depends_on_issue_id": blocker, "type": "blocked_by"})
	token := f.token(t, task)
	f.comment(t, token, "Review [worker](mention://agent/"+worker+")", "")
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2`, f.issue, worker); n != 0 {
		t.Fatal("comment bypassed inherited dependency")
	}
	dbfx.Exec(t, `UPDATE issue SET status='done' WHERE id=$1`, blocker)
	f.comment(t, token, "Now review [worker](mention://agent/"+worker+")", "")
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2`, f.issue, worker); n != 1 {
		t.Fatalf("ready comment failed normal wake: %d", n)
	}
}

func TestConversationControlCommandsAndQueuedRecovery(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	for i, body := range []string{"/new", "/clear", "actual input"} {
		f.msg.MessageID = fmt.Sprint("om_control_", i)
		f.msg.CommandText = body
		f.msg.Text = body
		f.ingest(t)
	}
	inputs, runs, _ := f.counts(t)
	if inputs != 1 || runs != 1 {
		t.Fatalf("bare controls ran agent: %d/%d", inputs, runs)
	}
	task := f.task(t)
	if !task.ForceFreshSession {
		t.Fatal("fresh boundary lost")
	}
	// Recreate service state after the transaction committed but before any
	// daemon observed an event: the existing durable queue remains claimable.
	claimed, err := f.h.TaskService.ClaimTask(context.Background(), task.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.ID != task.ID {
		t.Fatal("durable task was not recovered through normal claim")
	}
	runtime, err := f.h.Queries.GetAgentRuntime(context.Background(), task.RuntimeID)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/runtimes/claim", nil)
	resp, _, _, _, failure := f.h.buildClaimedTaskResponse(req, claimed, runtime, uuidToString(runtime.ID), testWorkspaceID)
	if failure != nil || !strings.Contains(resp.Agent.Instructions, conversationInstructions) {
		t.Fatalf("conversation instructions did not reach real claim payload: %+v", failure)
	}
	dbfx.Exec(t, `UPDATE channel_installation SET config=config-'conversation' WHERE id=$1`, f.install)
	_, _, _, _, failure = f.h.buildClaimedTaskResponse(req, claimed, runtime, uuidToString(runtime.ID), testWorkspaceID)
	if failure == nil {
		t.Fatal("revoked queued task reached daemon")
	}
	settled, err := f.h.Queries.GetAgentTask(context.Background(), task.ID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	if settled.Status != "failed" {
		t.Fatalf("revoked claim not settled: %s", settled.Status)
	}
}
