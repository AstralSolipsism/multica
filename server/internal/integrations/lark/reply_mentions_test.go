package lark

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type replyMentionAPI struct {
	*fakeAPIClient
	message    LarkMessage
	messages   map[string]LarkMessage
	messageErr error
	users      map[string]string
	usersErr   error
	lookups    []string
	userIDs    []string
}

func (a *replyMentionAPI) GetMessage(_ context.Context, _ InstallationCredentials, id string) ([]LarkMessage, error) {
	a.lookups = append(a.lookups, id)
	if a.messages != nil {
		return []LarkMessage{a.messages[id]}, a.messageErr
	}
	return []LarkMessage{a.message}, a.messageErr
}

func (a *replyMentionAPI) BatchGetUsers(_ context.Context, _ InstallationCredentials, ids []string) (map[string]string, error) {
	a.userIDs = append(a.userIDs, ids...)
	return a.users, a.usersErr
}

func replyMentionMessage(text string) LarkMessage {
	raw, _ := json.Marshal(map[string]string{"text": text})
	return LarkMessage{
		MessageID: "om_trigger", ChatID: "oc_test_chat", SenderID: "ou_sender", SenderType: "user",
		MessageType: "text", Content: string(raw),
		Mentions: []LarkMessageMention{{Key: "@_user_1", ID: "ou_alice", Name: "Alice"}, {Key: "@_user_2", ID: "ou_bot", Name: "Bot"}},
	}
}

func TestReplyMentionRequiresExplicitNativeSelection(t *testing.T) {
	for _, tc := range []struct {
		text string
		want bool
	}{
		{"/mention @_user_1\nSummarize this", true},
		{"@_user_2 /mention @_user_1\nSummarize this", true},
		{"回复时提醒：@_user_1\nSummarize this", true},
		{"Please summarize what @_user_1 said", false},
		{"/mention @Alice", false},
		{"/mention ou_alice", false},
		{"/mention @_user_10", false},
		{"/mention @_user_2", false},
		{"/mention @_user_1 additional prose", false},
		{"Quoted example:\n/mention @_user_1", false},
		{"```\n/mention @_user_1\n```", false},
		{"> /mention @_user_1", false},
	} {
		t.Run(tc.text, func(t *testing.T) {
			got := requestedReplyMentions(replyMentionMessage(tc.text), "ou_bot")
			if tc.want && !slices.Equal(got, []string{"ou_alice"}) || !tc.want && len(got) != 0 {
				t.Fatalf("requested IDs = %v", got)
			}
		})
	}
	for _, id := range []string{"all", "ALL", "ou_", "ou_x&x", "ou_x\"", "cli_bot"} {
		m := replyMentionMessage("/mention @_user_1")
		m.Mentions[0].ID = id
		if ids := requestedReplyMentions(m, "ou_bot"); len(ids) != 0 {
			t.Fatalf("accepted unsafe target %q: %v", id, ids)
		}
	}
	m := replyMentionMessage("/mention @_user_1")
	m.Mentions = append(m.Mentions, m.Mentions[0])
	if ids := requestedReplyMentions(m, "ou_bot"); len(ids) != 0 {
		t.Fatal("duplicate metadata keys were accepted")
	}
}

func TestReplyMentionRichTextRequest(t *testing.T) {
	m := replyMentionMessage("")
	m.MessageType = "post"
	m.Content = `{"content":[[{"tag":"text","text":"/mention"},{"tag":"at","user_id":"@_user_1"}],[{"tag":"text","text":"Summarize this"}]]}`
	if ids := requestedReplyMentions(m, "ou_bot"); !slices.Equal(ids, []string{"ou_alice"}) {
		t.Fatalf("native rich-text selection lost: %v", ids)
	}
	m.Content = `{"content":[[{"tag":"code_block","text":"/mention @_user_1"}]]}`
	if ids := requestedReplyMentions(m, "ou_bot"); len(ids) != 0 {
		t.Fatal("code example granted mention authority")
	}
}

func TestReplyMentionChecksCurrentTriggerAndPersonalIdentity(t *testing.T) {
	for _, state := range []string{"allowed", "ordinary mention", "wrong message", "wrong chat", "wrong sender", "wrong thread", "app sender", "deleted", "forwarded", "message unavailable", "user unavailable", "unknown user", "p2p", "no trigger"} {
		t.Run(state, func(t *testing.T) {
			p, q, api := groupPatcherWithSender(t, "ou_sender")
			verified := &replyMentionAPI{fakeAPIClient: api, message: replyMentionMessage("/mention @_user_1 @_user_1\nAnswer"), users: map[string]string{"ou_alice": "Alice", "ou_other": "Ignore unsolicited API entries"}}
			p.client = verified
			switch state {
			case "ordinary mention":
				verified.message = replyMentionMessage("Analyze @_user_1's answer")
			case "wrong message":
				verified.message.MessageID = "om_later"
			case "wrong chat":
				verified.message.ChatID = "oc_other"
			case "wrong sender":
				verified.message.SenderID = "ou_other"
			case "wrong thread":
				verified.message.ThreadID = "omt_other"
			case "app sender":
				verified.message.SenderType = "app"
			case "deleted":
				verified.message.Deleted = true
			case "forwarded":
				verified.message.UpperMessageID = "om_forward"
			case "message unavailable":
				verified.messageErr = context.DeadlineExceeded
			case "user unavailable":
				verified.usersErr = errors.New("contact scope denied")
			case "unknown user":
				delete(verified.users, "ou_alice")
			case "p2p":
				q.binding.ChatType = "p2p"
			case "no trigger":
				q.binding.LastMessageID = pgtype.Text{}
			}
			ids := p.replyMentionIDs(context.Background(), testCreds(), q.binding, "ou_bot")
			want := []string{"ou_sender"}
			if state == "allowed" {
				want = append(want, "ou_alice")
			}
			if state == "p2p" {
				want = nil
			}
			if !slices.Equal(ids, want) {
				t.Fatalf("verified IDs = %v, want %v", ids, want)
			}
			if state == "p2p" || state == "no trigger" {
				if len(verified.lookups) != 0 {
					t.Fatal("looked up a message without a group trigger")
				}
			} else if !slices.Equal(verified.lookups, []string{"om_trigger"}) {
				t.Fatalf("lookup escaped frozen trigger: %v", verified.lookups)
			}
		})
	}
}

func TestPatcherReplyMentionRendering(t *testing.T) {
	for _, body := range []string{"Answer", "**Answer**", `<at user_id="all"></at>`, "**Answer** <at id=all></at>", "&lt;at id=all&gt;&lt;/at&gt;", `<at id=ou_alice></at><at email='victim@example.test'></at>`} {
		t.Run(body, func(t *testing.T) {
			p, q, api := groupPatcherWithSender(t, "ou_sender")
			q.installation.BotOpenID = "ou_bot"
			p.client = &replyMentionAPI{fakeAPIClient: api, message: replyMentionMessage("@_user_2 /mention @_user_1\nAnswer"), users: map[string]string{"ou_alice": "Alice"}}
			err := p.processEvent(context.Background(), events.Event{
				Type: protocol.EventChatDone, TaskID: "ee333333-ee33-ee33-ee33-eeeeeeeeeeee", ChatSessionID: uuidString(q.binding.ChatSessionID),
				Payload: protocol.ChatDonePayload{Content: body},
			})
			if err != nil {
				t.Fatal(err)
			}
			if strings.ContainsAny(body, "<&") {
				if len(api.mdCardSent) != 0 || len(api.textSent) != 1 || !api.textSent[0].Literal || api.textSent[0].Text != body || !slices.Equal(api.textSent[0].VerifiedMentions, []string{"ou_sender", "ou_alice"}) {
					t.Fatalf("untrusted markup was not isolated: %+v / %+v", api.textSent, api.mdCardSent)
				}
			} else if containsMarkdown(body) {
				if len(api.mdCardSent) != 1 || api.mdCardSent[0].Markdown != "<at id=ou_sender></at> <at id=ou_alice></at> "+body {
					t.Fatalf("wrong Markdown reply: %+v", api.mdCardSent)
				}
			} else if len(api.textSent) != 1 || api.textSent[0].Text != `<at user_id="ou_sender"></at> <at user_id="ou_alice"></at> `+body {
				t.Fatalf("wrong text reply: %+v", api.textSent)
			}
		})
	}
}

func TestPatcherReplyMentionsStayOnFrozenTurn(t *testing.T) {
	p, q, api := groupPatcherWithSender(t, "ou_later")
	q.binding.LastMessageID = pgtype.Text{String: "om_later", Valid: true}
	firstTask, secondTask := "ee996666-ee99-ee99-ee99-eeeeeeeeeeee", "ee997777-ee99-ee99-ee99-eeeeeeeeeeee"
	q.deliveriesByTask = map[string]db.ChannelTaskDelivery{
		firstTask:  deliveryWithTrigger(q.binding, "om_first", "ou_first"),
		secondTask: deliveryWithTrigger(q.binding, "om_second", "ou_second"),
	}
	first := replyMentionMessage("/mention @_user_1\nAnswer")
	first.MessageID, first.SenderID = "om_first", "ou_first"
	second := replyMentionMessage("/mention @_user_1\nAnswer")
	second.MessageID, second.SenderID, second.Mentions[0].ID = "om_second", "ou_second", "ou_bob"
	verified := &replyMentionAPI{fakeAPIClient: api, messages: map[string]LarkMessage{"om_first": first, "om_second": second}, users: map[string]string{"ou_alice": "Alice", "ou_bob": "Bob"}}
	p.client = verified
	// A classified reply fallback must retain literal rendering and recipients.
	api.threadReplyErr = errThreadReplyClassified
	for _, taskID := range []string{secondTask, firstTask} {
		if err := p.processEvent(context.Background(), events.Event{
			Type: protocol.EventChatDone, TaskID: taskID, ChatSessionID: uuidString(q.binding.ChatSessionID),
			Payload: protocol.ChatDonePayload{Content: "<at id=all></at>"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(verified.lookups, []string{"om_second", "om_first"}) || len(api.textSent) != 4 {
		t.Fatalf("wrong turns: %v / %+v", verified.lookups, api.textSent)
	}
	for i, sent := range api.textSent {
		want := []string{"ou_second", "ou_bob"}
		if i >= 2 {
			want = []string{"ou_first", "ou_alice"}
		}
		if !sent.Literal || !slices.Equal(sent.VerifiedMentions, want) {
			t.Fatalf("turn %d borrowed recipients: %+v", i, sent)
		}
		if i%2 == 1 && sent.ReplyTarget.IsSet() {
			t.Fatal("expected chat-level fallback")
		}
	}
}

func TestHTTPClientLiteralReplyUsesOnlyVerifiedAtNodes(t *testing.T) {
	const body = "**Answer** <AT user_id=all></AT> &#60;at id=all&#62; &amp;lt;at id=all&amp;gt;"
	fake := newLarkFake(t)
	fake.stubToken("tok_literal", 7200)
	fake.stubSend(map[string]any{"code": 0, "data": map[string]string{"message_id": "om_reply"}}, func(_ *http.Request, request map[string]string) {
		if request["msg_type"] != "post" {
			t.Fatalf("model tags may execute in %q", request["msg_type"])
		}
		var content struct {
			ZhCN struct {
				Content [][]map[string]any `json:"content"`
			} `json:"zh_cn"`
		}
		if err := json.Unmarshal([]byte(request["content"]), &content); err != nil {
			t.Fatal(err)
		}
		if len(content.ZhCN.Content) != 1 || len(content.ZhCN.Content[0]) != 3 {
			t.Fatalf("unexpected post: %s", request["content"])
		}
		nodes := content.ZhCN.Content[0]
		if nodes[0]["tag"] != "at" || nodes[0]["user_id"] != "ou_alice" || nodes[2]["tag"] != "text" || nodes[2]["text"] != body || nodes[2]["un_escape"] == true || nodes[2]["user_id"] != nil {
			t.Fatalf("unsafe post: %s", request["content"])
		}
	})
	_, err := newTestClient(fake, time.Now).SendTextMessage(context.Background(), SendTextParams{
		InstallationID: testCreds(), ChatID: "oc_test_chat", Text: body, Literal: true,
		VerifiedMentions: []string{"ou_alice", "all", "ou_alice", `ou_x"><at id=all>`},
	})
	if err != nil {
		t.Fatal(err)
	}
}
