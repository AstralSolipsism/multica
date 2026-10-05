package lark

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
// Why a dedicated method instead of SendTextMessage: proactive delivery needs
// several message types, member DMs and topic anchors, and every
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
// GET /open-apis/im/v1/chats/{chat_id}. It returns provider errors unchanged;
// VerifyGroupTarget classifies them once at the delivery-module boundary.
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
		return &APIError{Op: "delivery chat info", Code: resp.Code, Msg: resp.Msg}
	}
	return nil
}

// VerifyGroupTarget implements the messagedelivery TargetVerifier port:
// a group route may only be saved/sent when the pinned bot can see the chat.
func (s *DeliverySender) VerifyGroupTarget(ctx context.Context, req messagedelivery.VerifyTargetRequest) error {
	creds, _, err := s.resolveInstallation(ctx, req.WorkspaceID, req.InstallationID)
	if err != nil {
		return err
	}
	if err := s.client.GetDeliveryChatInfo(ctx, creds, req.ChatID); err != nil {
		return classifyVerifyError(err)
	}
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
		return "", classifyVerifyError(err)
	}
	if anchorChat != req.ChatID {
		return "", fmt.Errorf("%w: anchor %s lives in chat %s, not declared %s",
			messagedelivery.ErrTargetAnchorMismatch, req.MessageID, anchorChat, req.ChatID)
	}
	return anchorChat, nil
}

// classifyVerifyError distinguishes definitive target/permission refusals from
// transient provider failures. An unknown transport verdict is returned to the
// caller, which must fail closed and retry before sending unverified.
func classifyVerifyError(err error) error {
	if errors.Is(err, messagedelivery.ErrTargetUnreachable) {
		return err
	}
	switch classifyLarkFailure(err) {
	case larkChatUnavailable, larkMessageUnavailable:
		return fmt.Errorf("%w: %v", messagedelivery.ErrTargetUnreachable, err)
	case larkRateLimited, larkUnavailable:
		return &messagedelivery.SendError{Class: messagedelivery.ClassTransient, Err: err}
	case larkRejected, larkInvalidRequest, larkPermissionDenied:
		return &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Err: err}
	}
	return err
}

// resolveInstallation centralizes the workspace-scoped installation lookup +
// decrypt shared by Send and the verifier.
func (s *DeliverySender) resolveInstallation(ctx context.Context, workspaceID, installationID string) (InstallationCredentials, Installation, error) {
	if s == nil || s.client == nil || s.installations == nil {
		return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Code:  messagedelivery.ErrorCodeSenderUnavailable,
			Err:   ErrAPIClientNotConfigured,
		}
	}
	instID, err := util.ParseUUID(installationID)
	if err != nil {
		return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Err: errors.New("installation id is not a uuid")}
	}
	wsID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Err: errors.New("workspace id is not a uuid")}
	}
	inst, err := s.installations.GetInWorkspace(ctx, instID, wsID)
	if err != nil {
		if errors.Is(err, ErrInstallationNotFound) {
			return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Err: ErrInstallationNotFound}
		}
		slog.Warn("lark delivery: load installation failed", "installation_id", installationID, "error", err)
		return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{Class: messagedelivery.ClassTransient, Err: errors.New("load installation failed")}
	}
	if inst.Status != "active" {
		return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Err: ErrInstallationRevoked}
	}
	secret, err := s.installations.DecryptAppSecret(inst)
	if err != nil {
		return InstallationCredentials{}, Installation{}, &messagedelivery.SendError{Class: messagedelivery.ClassPermanent, Err: fmt.Errorf("decrypt app_secret: %w", err)}
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

// Send performs one shard send. SendRequest.Message is the typed frozen shard;
// the target came from the decision's snapshot and the worker has already
// re-validated the installation — this adapter only dials.
func (s *DeliverySender) Send(ctx context.Context, req messagedelivery.SendRequest) (messagedelivery.SendResult, error) {
	if s == nil || s.client == nil || s.installations == nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Code:  messagedelivery.ErrorCodeSenderUnavailable,
			Err:   ErrAPIClientNotConfigured,
		}
	}
	// Workspace-scoped lookup: a forged or stale installation id from
	// another workspace cannot be dialed.
	creds, _, err := s.resolveInstallation(ctx, req.WorkspaceID, req.InstallationID)
	if err != nil {
		return messagedelivery.SendResult{}, err
	}
	params, err := deliveryParams(req, creds)
	if err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{
			Class: messagedelivery.ClassPermanent,
			Err:   err,
		}
	}
	if err := ctx.Err(); err != nil {
		return messagedelivery.SendResult{}, &messagedelivery.SendError{Class: messagedelivery.ClassTransient, Err: err}
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
	contentBytes, err := json.Marshal(newDeliveryPost(req.Message))
	if err != nil {
		return DeliveryMessageParams{}, fmt.Errorf("encode post content: %w", err)
	}
	base := DeliveryMessageParams{
		InstallationID: creds,
		MsgType:        "post",
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

type deliveryPostNode struct {
	Tag  string `json:"tag"`
	Text string `json:"text"`
	Href string `json:"href,omitempty"`
}

type deliveryPost struct {
	ZhCN struct {
		Title   string               `json:"title"`
		Content [][]deliveryPostNode `json:"content"`
	} `json:"zh_cn"`
}

// newDeliveryPost is the only delivery content encoder. A post text node does
// not parse text-message <at> syntax or Markdown links; un_escape stays false
// (the provider default). Never infer node types or links from source text.
func newDeliveryPost(message messagedelivery.Message) deliveryPost {
	var post deliveryPost
	post.ZhCN.Content = [][]deliveryPostNode{{{Tag: "text", Text: string(message.Body)}}}
	if message.Source != "" {
		// The URL is its own label: a source cannot masquerade as another site.
		post.ZhCN.Content = append(post.ZhCN.Content, []deliveryPostNode{
			{Tag: "text", Text: "Source: "},
			{Tag: "a", Text: string(message.Source), Href: string(message.Source)},
		})
	}
	return post
}

// classifyDeliverySendError sorts a transport-layer send failure into the
// three classes the delivery worker understands.
//
// Definitive business refusals (the platform answered and said no) are
// PERMANENT: retrying cannot help. Transport failures and Lark's explicit
// "still in flight" code are AMBIGUOUS: the message may exist, so only a
// verify-then-retry with the same UUID may resolve it. Rate limits and
// provider-coded 5xx refusals are TRANSIENT: back off and retry. A gateway
// failure without a provider verdict remains ambiguous.
func classifyDeliverySendError(err error) error {
	class := messagedelivery.ClassPermanent
	switch classifyLarkFailure(err) {
	case larkUnknown:
		class = messagedelivery.ClassAmbiguous
	case larkRateLimited, larkUnavailable:
		class = messagedelivery.ClassTransient
	}
	out := &messagedelivery.SendError{Class: class, Err: err}
	if code, _, ok := larkErrorCodeMsg(err); ok && class == messagedelivery.ClassPermanent {
		out.Code = fmt.Sprintf("%d", code)
	}
	return out
}

// compile-time checks: the adapter satisfies the port; the real client
// satisfies the optional capability interface.
var (
	_ messagedelivery.Sender = (*DeliverySender)(nil)
	_ DeliveryAPIClient      = (*httpAPIClient)(nil)
)
