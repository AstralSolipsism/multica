package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type conversationSourceTransport struct {
	mu    sync.Mutex
	proof messagedelivery.FeedbackMessage
}

func (f *conversationSourceTransport) ReadFeedbackMessage(_ context.Context, _, _, id string) (messagedelivery.FeedbackMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.proof
	p.MessageID = id
	return p, nil
}

type conversationFixture struct {
	h                                                      *Handler
	transport                                              *conversationSourceTransport
	install, app, issue, agent, delivery, receipt, binding string
	msg                                                    channel.InboundMessage
}

func newConversationFixture(t *testing.T) *conversationFixture {
	t.Helper()
	if testPool == nil {
		t.Fatal("conversation acceptance requires PostgreSQL")
	}
	f := &conversationFixture{}
	f.agent = dbfx.Agent(t, "Feedback agent", handlerTestRuntimeID(t))
	f.issue = dbfx.Issue(t, "Feedback target", testutil.Cols{"assignee_type": "agent", "assignee_id": f.agent})
	f.app = "cli_feedback_" + f.issue
	f.install = dbfx.Insert(t, "channel_installation", testutil.Cols{"workspace_id": testWorkspaceID, "agent_id": f.agent, "channel_type": "feishu", "installer_user_id": testUserID, "status": "active", "config": fmt.Sprintf(`{"app_id":%q}`, f.app)})
	f.binding = dbfx.Insert(t, "channel_user_binding", testutil.Cols{"workspace_id": testWorkspaceID, "multica_user_id": testUserID, "installation_id": f.install, "channel_type": "feishu", "channel_user_id": "ou_feedback"})
	activity := dbfx.Insert(t, "activity_log", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": f.issue, "actor_type": "member", "actor_id": testUserID, "action": "issue_updated"})
	f.delivery = dbfx.Insert(t, "labrastro_message_delivery", testutil.Cols{"id": testutil.Raw("gen_random_uuid()"), "workspace_id": testWorkspaceID, "installation_id": f.install, "source_kind": "activity", "source_scope": "activity", "source_ref_id": activity, "status": "sent", "dedup_key": f.install, "target_key": "member:" + testUserID, "shard_total": 1,
		"source_ref": fmt.Sprintf(`{"source_kind":"activity","issue_id":%q}`, f.issue), "content_snapshot": `{"text":"Frozen report"}`, "target_snapshot": fmt.Sprintf(`{"target_type":"member","user_id":%q}`, testUserID)})
	f.receipt = dbfx.Insert(t, "labrastro_message_receipt", testutil.Cols{"delivery_id": f.delivery, "workspace_id": testWorkspaceID, "installation_id": f.install, "shard_index": 0, "shard_total": 1, "send_uuid": f.delivery, "external_message_id": "om_report"})
	grant, _ := json.Marshal(channel.ConversationGrant{ID: f.install, AuthorizedBy: testUserID, Scope: "workspace", Chats: []channel.ConversationTarget{{ChatID: "oc_feedback", ChatType: "p2p"}, {ChatID: "oc_feedback", ChatType: "group"}}})
	dbfx.Exec(t, `UPDATE channel_installation SET config = config || jsonb_build_object('conversation', $2::jsonb) WHERE id=$1`, f.install, grant)
	f.transport = &conversationSourceTransport{proof: messagedelivery.FeedbackMessage{MessageID: "om_report", ChatID: "oc_feedback", Bot: true, HasReference: true, Signed: true, DeliveryID: f.delivery, SendUUID: f.delivery}}
	h := *testHandler
	h.Bus = events.New()
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

func (f *conversationFixture) report(t *testing.T) (string, string) {
	t.Helper()
	ap := dbfx.Insert(t, "autopilot", testutil.Cols{"workspace_id": testWorkspaceID, "title": "Frozen report source", "assignee_id": f.agent, "status": "active", "execution_mode": "run_only", "created_by_type": "member", "created_by_id": testUserID})
	task := dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": handlerTestRuntimeID(t), "status": "completed", "completed_at": testutil.Raw("now()")})
	run := dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": ap, "task_id": task, "source": "schedule", "status": "completed", "completed_at": testutil.Raw("now()"), "result": `{"output":"Frozen report"}`})
	dbfx.Exec(t, `UPDATE labrastro_message_delivery SET source_kind='run_only',source_scope='run',source_ref_id=NULL,autopilot_id=$2,run_id=$3,source_ref=$4 WHERE id=$1`, f.delivery, ap, run, fmt.Sprintf(`{"run_id":%q,"execution_mode":"run_only"}`, run))
	return ap, run
}
