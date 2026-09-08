package lark

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	messagedelivery "github.com/multica-ai/multica/server/internal/messagedelivery"
)

// Target addressing is the adapter's contract with the delivery module:
// member → open_id DM, group → chat send, topic → reply to the anchor with
// reply_in_thread.
func TestDeliveryParams_TargetAddressing(t *testing.T) {
	creds := InstallationCredentials{AppID: "cli", AppSecret: "sec"}

	member, err := deliveryParams(messagedelivery.SendRequest{
		Target:   messagedelivery.Target{Type: messagedelivery.TargetMember, OpenID: "ou_1"},
		Text:     "hello",
		SendUUID: "uuid-1",
	}, creds)
	if err != nil {
		t.Fatal(err)
	}
	if member.ReceiveIDType != "open_id" || member.ReceiveID != "ou_1" {
		t.Fatalf("member params = %+v", member)
	}
	if member.ReplyTarget.IsSet() {
		t.Fatal("member DM must not route through the reply endpoint")
	}
	if member.UUID != "uuid-1" {
		t.Fatalf("idempotency uuid = %q", member.UUID)
	}

	group, err := deliveryParams(messagedelivery.SendRequest{
		Target:   messagedelivery.Target{Type: messagedelivery.TargetGroup, ChatID: "oc_1"},
		Text:     "hello",
		SendUUID: "uuid-2",
	}, creds)
	if err != nil {
		t.Fatal(err)
	}
	if group.ReceiveIDType != "chat_id" || group.ReceiveID != "oc_1" {
		t.Fatalf("group params = %+v", group)
	}

	topic, err := deliveryParams(messagedelivery.SendRequest{
		Target:   messagedelivery.Target{Type: messagedelivery.TargetTopic, ChatID: "oc_2", MessageID: "om_9"},
		Text:     "hello",
		SendUUID: "uuid-3",
	}, creds)
	if err != nil {
		t.Fatal(err)
	}
	if !topic.ReplyTarget.IsSet() || topic.ReplyTarget.MessageID != "om_9" || !topic.ReplyTarget.InThread {
		t.Fatalf("topic reply target = %+v, want the anchor with reply_in_thread", topic.ReplyTarget)
	}
	if topic.ReceiveID != "oc_2" {
		t.Fatalf("topic chat = %q", topic.ReceiveID)
	}

	// A member target without a resolved open_id is a defect upstream, not
	// something to guess at.
	if _, err := deliveryParams(messagedelivery.SendRequest{
		Target:   messagedelivery.Target{Type: messagedelivery.TargetMember},
		Text:     "hello",
		SendUUID: "uuid-4",
	}, creds); err == nil {
		t.Fatal("member target without open_id must be refused")
	}
}

// Failure classification decides between retry, failure and uncertainty —
// the worker never sees Lark's error taxonomy directly.
func TestClassifyDeliverySendError(t *testing.T) {
	permanent := []error{
		&APIError{Op: "delivery send", Code: 230013, Msg: "no availability"},
		&APIError{Op: "delivery send", Code: 230011, Msg: "message recalled"},
		&APIError{Op: "delivery send", Code: 230019, Msg: "topic missing"},
		&APIError{Op: "delivery send", Code: 230002, Msg: "invalid receive id"},
	}
	for _, err := range permanent {
		classified := classifyDeliverySendError(err)
		var sendErr *messagedelivery.SendError
		if !errors.As(classified, &sendErr) || sendErr.Class != messagedelivery.ClassPermanent {
			t.Fatalf("%v: want permanent, got %#v", err, classified)
		}
	}

	transient := []error{
		&APIError{Op: "delivery send", Code: 230020, Msg: "rate limited"},
		&larkAPIStatusError{StatusCode: http.StatusTooManyRequests, Code: 230020, Msg: "rate limited"},
		// A 5xx that still carried a Lark envelope: the platform answered,
		// nothing was accepted, retry is safe.
		&larkAPIStatusError{StatusCode: http.StatusBadGateway, Code: 999999, Msg: "upstream"},
	}
	for _, err := range transient {
		classified := classifyDeliverySendError(err)
		var sendErr *messagedelivery.SendError
		if !errors.As(classified, &sendErr) || sendErr.Class != messagedelivery.ClassTransient {
			t.Fatalf("%v: want transient, got %#v", err, classified)
		}
	}

	ambiguous := []error{
		errors.New("context deadline exceeded"), // no Lark verdict at all
		&APIError{Op: "delivery send", Code: 230049, Msg: "message is being sent"},
		&larkAPIStatusError{StatusCode: http.StatusInternalServerError, Code: 99991663, Msg: "token"},
		// A gateway 5xx with NO Lark envelope: whether the request reached
		// the platform is unknowable, so the outcome is ambiguous.
		&larkAPIStatusError{StatusCode: http.StatusBadGateway, Code: 0, Msg: ""},
	}
	for _, err := range ambiguous {
		classified := classifyDeliverySendError(err)
		var sendErr *messagedelivery.SendError
		if !errors.As(classified, &sendErr) || sendErr.Class != messagedelivery.ClassAmbiguous {
			t.Fatalf("%v: want ambiguous, got %#v", err, classified)
		}
	}
}

// The stub client does not implement DeliveryAPIClient — a deployment
// without the real transport must surface "unavailable", never a fake
// success.
func TestDeliverySenderWithoutTransportIsPermanent(t *testing.T) {
	sender := NewDeliverySender(nil, nil)
	_, err := sender.Send(context.Background(), messagedelivery.SendRequest{
		WorkspaceID:    "ws",
		InstallationID: "inst",
		Target:         messagedelivery.Target{Type: messagedelivery.TargetGroup, ChatID: "oc"},
		Text:           "hi",
		SendUUID:       "u",
	})
	var sendErr *messagedelivery.SendError
	if !errors.As(err, &sendErr) {
		t.Fatalf("want SendError, got %#v", err)
	}
	if sendErr.Class != messagedelivery.ClassPermanent || sendErr.Code != messagedelivery.ErrorCodeSenderUnavailable {
		t.Fatalf("class=%v code=%q", sendErr.Class, sendErr.Code)
	}
}

// R8 regression: the official CreateMessageReqBody defines uuid as a JSON
// body field. The chat-level send and the topic reply must both carry the
// idempotency UUID in the body; the query keeps only receive_id_type.
func TestReviewCreateDeliveryUUIDInBody(t *testing.T) {
	for _, receiveType := range []string{"open_id", "chat_id"} {
		t.Run(receiveType, func(t *testing.T) {
			fake := newLarkFake(t)
			fake.stubToken("review_fake_token", 3600)
			fake.stubSend(map[string]any{"code": 0, "data": map[string]any{"message_id": "om_review"}}, func(r *http.Request, body map[string]string) {
				if body["uuid"] != "review-stable-uuid" {
					t.Errorf("body uuid=%q, query uuid=%q; idempotency UUID must be in JSON", body["uuid"], r.URL.Query().Get("uuid"))
				}
			})
			client := newTestClient(fake, time.Now)
			_, err := client.SendDeliveryMessage(context.Background(), testCreds(), DeliveryMessageParams{
				ReceiveIDType: receiveType, ReceiveID: "review_target", MsgType: "text",
				Content: `{"text":"synthetic review message"}`, UUID: "review-stable-uuid",
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

// The topic reply path carries the UUID in the reply request's body too.
func TestReviewCreateDeliveryUUIDInReplyBody(t *testing.T) {
	fake := newLarkFake(t)
	fake.stubToken("review_fake_token", 3600)
	fake.stubReply(map[string]any{"code": 0, "data": map[string]any{"message_id": "om_reply"}}, func(r *http.Request, id string, body map[string]any) {
		if body["uuid"] != "review-reply-uuid" {
			t.Errorf("reply body uuid=%v, query uuid=%q; idempotency UUID must be in JSON", body["uuid"], r.URL.Query().Get("uuid"))
		}
		if body["reply_in_thread"] != true {
			t.Errorf("reply_in_thread = %v, want true for topic delivery", body["reply_in_thread"])
		}
	})
	client := newTestClient(fake, time.Now)
	_, err := client.SendDeliveryMessage(context.Background(), testCreds(), DeliveryMessageParams{
		ReceiveIDType: "chat_id", ReceiveID: "oc_topic", MsgType: "text",
		Content: `{"text":"synthetic review message"}`, UUID: "review-reply-uuid",
		ReplyTarget: ReplyTarget{MessageID: "om_anchor", InThread: true},
	})
	if err != nil {
		t.Fatal(err)
	}
}
