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

	// GetDeliveryMessageChat resolves which chat a message lives in. The
	// topic-target verifier uses it to prove an anchor message actually
	// belongs to the chat a route declares.
	GetDeliveryMessageChat(ctx context.Context, creds InstallationCredentials, messageID string) (string, error)

	// GetDeliveryChatInfo fetches a chat's basic info. The group-target
	// verifier uses it to prove the bot can see the chat before a route
	// pointing at it may be saved or sent.
	GetDeliveryChatInfo(ctx context.Context, creds InstallationCredentials, chatID string) error
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
			// Lark's CreateMessageReqBody defines uuid as a JSON body
			// field — the idempotency key MUST travel in the body, not
			// the query string, or the dedup window never sees it.
			"uuid": p.UUID,
		}
	} else {
		q := url.Values{}
		q.Set("receive_id_type", p.ReceiveIDType)
		path = "/open-apis/im/v1/messages?" + q.Encode()
		body = map[string]any{
			"receive_id": p.ReceiveID,
			"msg_type":   p.MsgType,
			"content":    p.Content,
			"uuid":       p.UUID,
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

// GetDeliveryMessageChat resolves the owning chat of one message via
// GET /open-apis/im/v1/messages/{id}. Only the chat id is read here; the
// delivery module owns all content decisions.
func (c *httpAPIClient) GetDeliveryMessageChat(ctx context.Context, creds InstallationCredentials, messageID string) (string, error) {
	if messageID == "" {
		return "", errors.New("lark delivery: missing message id")
	}
	path := "/open-apis/im/v1/messages/" + url.PathEscape(messageID)
	var resp struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			Items []struct {
				ChatID string `json:"chat_id"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := c.doAuthedJSON(ctx, creds, http.MethodGet, path, nil, &resp); err != nil {
		return "", fmt.Errorf("lark delivery: get message chat: %w", err)
	}
	if resp.Code != 0 {
		if isTokenError(resp.Code) {
			c.invalidateToken(creds.AppID)
		}
		return "", &APIError{Op: "delivery message chat", Code: resp.Code, Msg: resp.Msg}
	}
	if len(resp.Data.Items) == 0 || resp.Data.Items[0].ChatID == "" {
		return "", errors.New("lark delivery: message chat lookup returned no item")
	}
	return resp.Data.Items[0].ChatID, nil
}

// GetDeliveryChatInfo proves the bot can see one chat via
// GET /open-apis/im/v1/chats/{chat_id}. A definitive "no such chat / bot
// not a member" verdict maps to ErrDeliveryTargetUnreachable; anything
// else (transport, scopes) surfaces as-is so the caller can fail closed.
func (c *httpAPIClient) GetDeliveryChatInfo(ctx context.Context, creds InstallationCredentials, chatID string) error {
	if chatID == "" {
		return errors.New("lark delivery: missing chat id")
	}
	path := "/open-apis/im/v1/chats/" + url.PathEscape(chatID)
	var resp struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			ChatID string `json:"chat_id"`
		} `json:"data"`
	}
	if err := c.doAuthedJSON(ctx, creds, http.MethodGet, path, nil, &resp); err != nil {
		return fmt.Errorf("lark delivery: get chat info: %w", err)
	}
	if resp.Code != 0 {
		if isTokenError(resp.Code) {
			c.invalidateToken(creds.AppID)
		}
		err := &APIError{Op: "delivery chat info", Code: resp.Code, Msg: resp.Msg}
		switch resp.Code {
		case 230002, 230013, 230014: // unknown chat / bot outside visibility / bot not a member
			return fmt.Errorf("%w: %v", messagedelivery.ErrTargetUnreachable, err)
		}
		return err
	}
	return nil
}

// VerifyGroupTarget implements the messagedelivery TargetVerifier port:
// a group route may only be saved/sent when the pinned bot can see the chat.
func (s *DeliverySender) VerifyGroupTarget(ctx context.Context, req messagedelivery.VerifyTargetRequest) error {
	creds, inst, err := s.resolveInstallation(ctx, req.WorkspaceID, req.InstallationID)
	if err != nil {
		return err
	}
	if err := s.client.GetDeliveryChatInfo(ctx, creds, req.ChatID); err != nil {
		return s.classifyVerifyError(err)
	}
	_ = inst
	return nil
}

// VerifyTopicTarget proves the anchor message belongs to the declared chat
// and returns the VERIFIED chat id — the value the route stores and sends
// against, so a typo'd or foreign chat declaration can never redirect a
// topic reply.
func (s *DeliverySender) VerifyTopicTarget(ctx context.Context, req messagedelivery.VerifyTargetRequest) (string, error) {
	creds, _, err := s.resolveInstallation(ctx, req.WorkspaceID, req.InstallationID)
	if err != nil {
		return "", err
	}
	anchorChat, err := s.client.GetDeliveryMessageChat(ctx, creds, req.MessageID)
	if err != nil {
		return "", s.classifyVerifyError(err)
	}
	if anchorChat != req.ChatID {
		return "", fmt.Errorf("%w: anchor %s lives in chat %s, not declared %s",
			messagedelivery.ErrTargetAnchorMismatch, req.MessageID, anchorChat, req.ChatID)
	}
	return anchorChat, nil
}

// classifyVerifyError sorts a verification failure into the three verdicts
// the delivery module distinguishes: definitive unreachable (save/send
// refused), definitive mismatch (handled by the caller), or unknown (the
// caller must fail closed / go uncertain).
func (s *DeliverySender) classifyVerifyError(err error) error {
	if errors.Is(err, messagedelivery.ErrTargetUnreachable) {
		return err
	}
	code, _, hasCode := larkErrorCodeMsg(err)
	if hasCode {
		switch code {
		case 230002, 230011, 230013, 230014, 230019:
			return fmt.Errorf("%w: %v", messagedelivery.ErrTargetUnreachable, err)
		}
	}
	return err
}

// resolveInstallation centralizes the workspace-scoped installation lookup +
// decrypt shared by Send and the verifier.
func (s *DeliverySender) resolveInstallation(ctx context.Context, workspaceID, installationID string) (InstallationCredentials, Installation, error) {
	if s == nil || s.client == nil {
		return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Code:  messagedelivery.ErrorCodeSenderUnavailable,
			Err:   ErrAPIClientNotConfigured,
		}
	}
	instID, err := util.ParseUUID(installationID)
	if err != nil {
		return InstallationCredentials{}, Installation{}, fmt.Errorf("installation id is not a uuid")
	}
	wsID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return InstallationCredentials{}, Installation{}, fmt.Errorf("workspace id is not a uuid")
	}
	inst, err := s.installations.GetInWorkspace(ctx, instID, wsID)
	if err != nil {
		return InstallationCredentials{}, Installation{}, fmt.Errorf("load installation: %w", err)
	}
	if inst.Status != "active" {
		return InstallationCredentials{}, Installation{}, ErrInstallationRevoked
	}
	secret, err := s.installations.DecryptAppSecret(inst)
	if err != nil {
		return InstallationCredentials{}, Installation{}, fmt.Errorf("decrypt app_secret: %w", err)
	}
	creds := InstallationCredentials{
		AppID:     inst.AppID,
		AppSecret: secret,
		Region:    RegionOrDefault(inst.Region),
	}
	if inst.TenantKey.Valid {
		creds.TenantKey = inst.TenantKey.String
	}
	return creds, inst, nil
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
	// Workspace-scoped lookup: a forged or stale installation id from
	// another workspace cannot be dialed.
	creds, inst, err := s.resolveInstallation(ctx, req.WorkspaceID, req.InstallationID)
	if err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Err:   err,
		}
	}
	req.Text += signedFeedbackLink(req, creds.AppSecret, util.UUIDToString(inst.AgentID))
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
