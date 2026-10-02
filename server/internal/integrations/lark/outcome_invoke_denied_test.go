package lark

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
)

func TestLarkInvokeDeniedIsPrivateAndNeverFallsBackToGroup(t *testing.T) {
	for _, chatType := range []channel.ChatType{channel.ChatTypeP2P, channel.ChatTypeGroup} {
		for _, sendErr := range []error{nil, &APIError{Code: codeNoAvailability}, errors.New("network unavailable")} {
			t.Run(string(chatType)+"/"+errorLabel(sendErr), func(t *testing.T) {
				client := &stubAPIClientWithRecorder{configured: true, textErr: sendErr}
				replier := NewLarkOutcomeReplier(OutcomeReplierConfig{APIClient: client,
					BindingSvc:  fakeBindingMinter{err: errors.New("must not mint a binding token")},
					Credentials: stubCredentialsResolver{secret: "test"}, Queries: stubReplierQueries{},
					Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
				raw, err := json.Marshal(InboundMessage{ChatID: "oc_group", ChatType: ChatType(chatType), MessageID: "om_trigger", ThreadID: "omt_topic"})
				if err != nil {
					t.Fatal(err)
				}
				adapter := &feishuOutboundReplier{replier: replier}
				adapter.Reply(context.Background(), engine.ResolvedInstallation{Platform: Installation{}}, channel.InboundMessage{Raw: raw},
					engine.Result{Outcome: engine.OutcomeInvokeDenied, Sender: "ou_denied"})
				if len(client.textOut) != 1 || len(client.interactiveOut) != 0 || len(client.bindingCalls) != 0 {
					t.Fatalf("unexpected sends: %+v", client)
				}
				p := client.textOut[0]
				if p.OpenID != "ou_denied" || p.ChatID != "" || p.ReplyTarget.IsSet() || p.Text != invokeDeniedCopy {
					t.Fatalf("refusal was not private: %+v", p)
				}
			})
		}
	}
}

func errorLabel(err error) string {
	if err == nil {
		return "success"
	}
	return err.Error()
}

func TestLarkInvokeDeniedWithoutSenderDoesNotSend(t *testing.T) {
	client := &stubAPIClientWithRecorder{configured: true}
	replier := NewLarkOutcomeReplier(OutcomeReplierConfig{APIClient: client,
		Credentials: stubCredentialsResolver{secret: "test"}, Queries: stubReplierQueries{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	replier.Reply(context.Background(), Installation{}, InboundMessage{ChatID: "oc_group", MessageID: "om_trigger"}, DispatchResult{Outcome: OutcomeInvokeDenied})
	if len(client.textOut) != 0 || len(client.interactiveOut) != 0 || len(client.bindingCalls) != 0 {
		t.Fatal("missing sender produced an outbound message")
	}
}

func TestHTTPClientPrivateTextUsesOpenID(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("tok_private", 7200)
	fake.stubSend(map[string]any{"code": 0, "data": map[string]string{"message_id": "om_private"}}, func(r *http.Request, body map[string]string) {
		if r.URL.Path != "/open-apis/im/v1/messages" || r.URL.Query().Get("receive_id_type") != "open_id" || body["receive_id"] != "ou_denied" || body["msg_type"] != "text" {
			t.Fatalf("wrong private target: %s %+v", r.URL.String(), body)
		}
	})
	client := newTestClient(fake, time.Now)
	id, err := client.SendTextMessage(context.Background(), SendTextParams{InstallationID: testCreds(), OpenID: "ou_denied", Text: invokeDeniedCopy})
	if err != nil || id != "om_private" {
		t.Fatalf("private notice: %q %v", id, err)
	}
	for _, params := range []SendTextParams{
		{OpenID: "ou_denied", ChatID: "oc_group", Text: "no"},
		{OpenID: "ou_denied", ReplyTarget: ReplyTarget{MessageID: "om_group"}, Text: "no"},
	} {
		if _, err := client.SendTextMessage(context.Background(), params); err == nil {
			t.Fatal("accepted mixed private and group addressing")
		}
	}
}
