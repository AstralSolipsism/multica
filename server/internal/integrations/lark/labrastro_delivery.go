package lark

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	messagedelivery "github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/util"
)

// Proactive-delivery transport (OL-25). This file is the Feishu adapter for
// the messagedelivery module's Sender port. It is deliberately OPTIONAL
// infrastructure: nothing here widens the APIClient interface every channel
// must satisfy (OL-23: "不扩大全部 Channel 必选方法"), and the stub client
// simply does not implement DeliveryAPIClient, so a deployment without the
// real transport reports deliveries as unavailable instead of pretending.
//
// Why a dedicated method instead of SendTextMessage: that path is pinned to
// receive_id_type=chat_id, while delivery targets need member DMs addressed
// by open_id AND topic anchors routed through the reply endpoint, and every
// send must carry the delivery's FIXED idempotency UUID so a retry after an
// unclear outcome cannot duplicate the message.

// DeliveryAPIClient is the optional proactive-send capability an APIClient
// may implement. Kept separate from APIClient so test doubles and the stub
// stay untouched.
type DeliveryAPIClient interface {
	// SendDeliveryMessage posts one message to one receive id and returns
	// the platform message_id. UUID is the caller's idempotency key; the
	// platform's dedup window for it is finite (about an hour per the
	// official SDK), so the caller still treats unclear outcomes as
	// uncertain.
	SendDeliveryMessage(ctx context.Context, creds InstallationCredentials, p DeliveryMessageParams) (string, error)
}

// DeliveryMessageParams is one proactive send.
type DeliveryMessageParams struct {
	InstallationID InstallationCredentials
	// ReceiveIDType selects the addressing scheme: "open_id" for member
	// DMs, "chat_id" for group chats and topic anchors.
	ReceiveIDType string
	ReceiveID     string
	// MsgType is the Lark message type ("text", "interactive", ...).
	MsgType string
	// Content is the JSON-encoded, msg_type-specific content envelope
	// Lark requires (e.g. {"text":"..."}).
	Content string
	// ReplyTarget, when set, routes the send through the reply endpoint
	// so the message lands inside the anchored 话题.
	ReplyTarget ReplyTarget
	// UUID is the idempotent-send key.
	UUID string
}

// sendDeliveryMessage is the shared implementation on the real client.
func (c *httpAPIClient) SendDeliveryMessage(ctx context.Context, creds InstallationCredentials, p DeliveryMessageParams) (string, error) {
	if p.ReceiveIDType == "" || p.ReceiveID == "" {
		return "", errors.New("lark delivery: missing receive id")
	}
	if p.MsgType == "" || p.Content == "" {
		return "", errors.New("lark delivery: missing message body")
	}
	if p.UUID == "" {
		return "", errors.New("lark delivery: missing idempotency uuid")
	}
	var path string
	var body map[string]any
	if p.ReplyTarget.IsSet() {
		path = "/open-apis/im/v1/messages/" + url.PathEscape(p.ReplyTarget.MessageID) + "/reply"
		body = map[string]any{
			"msg_type":        p.MsgType,
			"content":         p.Content,
			"reply_in_thread": p.ReplyTarget.InThread,
			"uuid":            p.UUID,
		}
	} else {
		q := url.Values{}
		q.Set("receive_id_type", p.ReceiveIDType)
		q.Set("uuid", p.UUID)
		path = "/open-apis/im/v1/messages?" + q.Encode()
		body = map[string]any{
			"receive_id": p.ReceiveID,
			"msg_type":   p.MsgType,
			"content":    p.Content,
		}
	}
	var resp struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	if err := c.doAuthedJSON(ctx, creds, http.MethodPost, path, body, &resp); err != nil {
		return "", fmt.Errorf("lark delivery: send message: %w", err)
	}
	if resp.Code != 0 || resp.Data.MessageID == "" {
		if isTokenError(resp.Code) {
			c.invalidateToken(p.InstallationID.AppID)
		}
		return "", &APIError{Op: "delivery send", Code: resp.Code, Msg: resp.Msg}
	}
	return resp.Data.MessageID, nil
}

// DeliverySender implements messagedelivery.Sender over the Feishu Open
// Platform. It resolves and decrypts the pinned installation, addresses the
// target, and classifies every failure for the delivery worker.
type DeliverySender struct {
	installations *InstallationService
	client        DeliveryAPIClient
}

// NewDeliverySender wires the adapter. client may be nil (or not implement
// DeliveryAPIClient) on deployments without the real transport; sends then
// fail with the permanent sender-unavailable classification, which the
// module records as an explainable delivery failure.
func NewDeliverySender(installations *InstallationService, client DeliveryAPIClient) *DeliverySender {
	return &DeliverySender{installations: installations, client: client}
}

// Send performs one shard send. SendRequest.Text is the frozen shard body;
// the target came from the decision's snapshot and the worker has already
// re-validated the installation — this adapter only dials.
func (s *DeliverySender) Send(ctx context.Context, req messagedelivery.SendRequest) (messagedelivery.SendResult, error) {
	if s == nil || s.client == nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Code:  messagedelivery.ErrorCodeSenderUnavailable,
			Err:   ErrAPIClientNotConfigured,
		}
	}
	instID, err := util.ParseUUID(req.InstallationID)
	if err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Err:   fmt.Errorf("installation id is not a uuid"),
		}
	}
	wsID, err := util.ParseUUID(req.WorkspaceID)
	if err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Err:   fmt.Errorf("workspace id is not a uuid"),
		}
	}
	// Workspace-scoped lookup: a forged or stale installation id from
	// another workspace cannot be dialed.
	inst, err := s.installations.GetInWorkspace(ctx, instID, wsID)
	if err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Code:  messagedelivery.ErrorCodeInstallationMissing,
			Err:   err,
		}
	}
	if inst.Status != "active" {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Code:  messagedelivery.ErrorCodeInstallationRevoked,
			Err:   errors.New("installation is revoked"),
		}
	}
	secret, err := s.installations.DecryptAppSecret(inst)
	if err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassAmbiguous,
			Err:   fmt.Errorf("decrypt app_secret: %w", err),
		}
	}
	creds := InstallationCredentials{
		AppID:     inst.AppID,
		AppSecret: secret,
		Region:    RegionOrDefault(inst.Region),
	}
	if inst.TenantKey.Valid {
		creds.TenantKey = inst.TenantKey.String
	}

	params, err := deliveryParams(req, creds)
	if err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Err:   err,
		}
	}
	messageID, err := s.client.SendDeliveryMessage(ctx, creds, params)
	if err != nil {
		return messagedelivery.SendResult{}, classifyDeliverySendError(err)
	}
	return messagedelivery.SendResult{ExternalMessageID: messageID}, nil
}

// deliveryParams maps a resolved target onto the Lark addressing scheme:
// member → open_id DM, group → chat send, topic → reply to the anchor
// message threaded into its 话题.
func deliveryParams(req messagedelivery.SendRequest, creds InstallationCredentials) (DeliveryMessageParams, error) {
	contentBytes, err := json.Marshal(map[string]string{"text": req.Text})
	if err != nil {
		return DeliveryMessageParams{}, fmt.Errorf("encode text content: %w", err)
	}
	base := DeliveryMessageParams{
		InstallationID: creds,
		MsgType:        "text",
		Content:        string(contentBytes),
		UUID:           req.SendUUID,
	}
	switch req.Target.Type {
	case messagedelivery.TargetMember:
		if req.Target.OpenID == "" {
			return DeliveryMessageParams{}, errors.New("member target resolved without an open_id")
		}
		base.ReceiveIDType = "open_id"
		base.ReceiveID = req.Target.OpenID
	case messagedelivery.TargetGroup:
		if req.Target.ChatID == "" {
			return DeliveryMessageParams{}, errors.New("group target resolved without a chat_id")
		}
		base.ReceiveIDType = "chat_id"
		base.ReceiveID = req.Target.ChatID
	case messagedelivery.TargetTopic:
		if req.Target.ChatID == "" || req.Target.MessageID == "" {
			return DeliveryMessageParams{}, errors.New("topic target resolved without its message anchor")
		}
		base.ReceiveIDType = "chat_id"
		base.ReceiveID = req.Target.ChatID
		// reply_in_thread keeps the message inside the anchored topic.
		base.ReplyTarget = ReplyTarget{MessageID: req.Target.MessageID, InThread: true}
	default:
		return DeliveryMessageParams{}, fmt.Errorf("unknown target type %q", req.Target.Type)
	}
	return base, nil
}

// classifyDeliverySendError sorts a transport-layer send failure into the
// three classes the delivery worker understands.
//
// Definitive business refusals (the platform answered and said no) are
// PERMANENT: retrying cannot help. Transport failures and Lark's explicit
// "still in flight" code are AMBIGUOUS: the message may exist, so only a
// verify-then-retry with the same UUID may resolve it. Rate limits and
// gateway 5xx are TRANSIENT: nothing was accepted, back off and retry.
func classifyDeliverySendError(err error) error {
	code, _, hasCode := larkErrorCodeMsg(err)
	if !hasCode {
		// No business verdict: network failure, timeout, or a non-Lark
		// response. The request may still have been processed.
		return &messagedelivery.SendError{Class: messagedelivery.ClassAmbiguous, Err: err}
	}
	switch code {
	case codeNoAvailability: // 230013: target outside the bot's scope
		return &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Code: "230013", Err: err}
	case 230011: // the anchor message was recalled; the topic is unreachable
		return &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Code: "230011", Err: err}
	case 230019: // the topic does not exist
		return &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Code: "230019", Err: err}
	case 230020: // rate limited
		return &messagedelivery.SendError{Class: messagedelivery.ClassTransient, Err: err}
	case 230049: // "message is being sent" — outcome unknown
		return &messagedelivery.SendError{Class: messagedelivery.ClassAmbiguous, Err: err}
	case codeTenantTokenInvalid, codeAppTokenInvalid:
		// doAuthedJSON already refreshed and replayed once; a second
		// credential rejection is an installation-health problem with an
		// unknown in-flight state.
		return &messagedelivery.SendError{Class: messagedelivery.ClassAmbiguous, Err: err}
	}
	var statusErr *larkAPIStatusError
	if errors.As(err, &statusErr) {
		if statusErr.StatusCode == http.StatusTooManyRequests || statusErr.StatusCode >= 500 {
			return &messagedelivery.SendError{Class: messagedelivery.ClassTransient, Err: err}
		}
	}
	// Any other business code is a definitive refusal the platform
	// already answered.
	return &messagedelivery.SendError{
		Class: messagedelivery.ClassPermanent,
		Code:  fmt.Sprintf("%d", code),
		Err:   err,
	}
}

// compile-time checks: the adapter satisfies the port; the real client
// satisfies the optional capability interface.
var (
	_ messagedelivery.Sender = (*DeliverySender)(nil)
	_ DeliveryAPIClient      = (*httpAPIClient)(nil)
)
