package lark

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

// TargetDiscoveryClient is optional: inbound context readers and stub transports
// retain their existing contract. Discovery does not authorize a delivery target.
type TargetDiscoveryClient interface {
	ListJoinedChats(context.Context, InstallationCredentials, DiscoveryParams, string) (DiscoveryPage[DiscoveryChat], error)
	ListMessageAnchors(context.Context, InstallationCredentials, DiscoveryParams, string) (DiscoveryPage[MessageAnchor], error)
}

type DiscoveryParams struct {
	PageSize  int
	PageToken string
}

type DiscoveryPage[T any] struct {
	Items     []T
	HasMore   bool
	PageToken string
}

// DiscoveryChat deliberately excludes tenant keys and owner/contact identities.
type DiscoveryChat struct {
	ChatID      string `json:"chat_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Avatar      string `json:"avatar"`
	External    bool   `json:"external"`
	ChatStatus  string `json:"chat_status"`
}

type AnchorSender struct {
	Type   string `json:"type"`
	ID     string `json:"id,omitempty"`
	IDType string `json:"id_type,omitempty"`
}

type MessageAnchor struct {
	MessageID   string       `json:"message_id"`
	ChatID      string       `json:"chat_id"`
	MessageType string       `json:"message_type"`
	Summary     string       `json:"summary"`
	CreateTime  string       `json:"create_time"`
	ThreadID    string       `json:"thread_id,omitempty"`
	Sender      AnchorSender `json:"sender"`
}

var (
	ErrDiscoveryInvalidRequest = errors.New("invalid discovery request")
	ErrDiscoveryPermission     = errors.New("provider permission denied")
	ErrDiscoveryChat           = errors.New("group unavailable or bot is not a member")
	ErrDiscoveryMessage        = errors.New("message unavailable")
	ErrDiscoveryUnavailable    = errors.New("provider or bot unavailable")
	ErrDiscoveryRateLimited    = errors.New("provider rate limited")
	ErrDiscoveryResponse       = errors.New("invalid provider response")
)

// Pointers distinguish a valid empty page from a missing/malformed envelope.
type discoveryResponse[T any] struct {
	Code *int `json:"code"`
	Data *struct {
		Items     []T    `json:"items"`
		HasMore   *bool  `json:"has_more"`
		PageToken string `json:"page_token"`
	} `json:"data"`
}

func (r discoveryResponse[T]) validate(p DiscoveryParams) error {
	if r.Code == nil {
		return ErrDiscoveryResponse
	}
	if *r.Code != 0 {
		return discoveryError(&APIError{Code: *r.Code})
	}
	if r.Data == nil || r.Data.HasMore == nil || r.Data.Items == nil || len(r.Data.Items) > p.PageSize {
		return ErrDiscoveryResponse
	}
	if *r.Data.HasMore && (r.Data.PageToken == "" || len(r.Data.PageToken) > 4096 || r.Data.PageToken == p.PageToken) {
		return ErrDiscoveryResponse
	}
	return nil
}

func discoveryQuery(p DiscoveryParams, maxSize int) (url.Values, error) {
	if p.PageSize < 1 || p.PageSize > maxSize || len(p.PageToken) > 4096 {
		return nil, ErrDiscoveryInvalidRequest
	}
	q := url.Values{"page_size": {strconv.Itoa(p.PageSize)}}
	if p.PageToken != "" {
		q.Set("page_token", p.PageToken)
	}
	return q, nil
}

// ListJoinedChats filters only the current joined-groups page. A filtered empty
// page can still have a successor; callers must follow HasMore, not item count.
// SearchChat is intentionally unused because it also returns public unjoined groups.
func (c *httpAPIClient) ListJoinedChats(ctx context.Context, creds InstallationCredentials, p DiscoveryParams, query string) (DiscoveryPage[DiscoveryChat], error) {
	out := DiscoveryPage[DiscoveryChat]{Items: []DiscoveryChat{}}
	q, err := discoveryQuery(p, 100)
	if err != nil {
		return out, err
	}
	q.Set("sort_type", "ByCreateTimeAsc")
	var resp discoveryResponse[DiscoveryChat]
	if err := c.doAuthedJSON(ctx, creds, http.MethodGet, "/open-apis/im/v1/chats?"+q.Encode(), nil, &resp); err != nil {
		return out, discoveryError(err)
	}
	if resp.Code != nil && isTokenError(*resp.Code) {
		c.invalidateToken(creds.AppID)
	}
	if err := resp.validate(p); err != nil {
		return out, err
	}
	for _, chat := range resp.Data.Items {
		if !ValidDiscoveryChatID(chat.ChatID) {
			return out, ErrDiscoveryResponse
		}
		if chat.ChatStatus == "dissolved" || chat.ChatStatus == "dissolved_save" || !strings.Contains(strings.ToLower(chat.Name), strings.ToLower(query)) {
			continue
		}
		out.Items = append(out.Items, chat)
	}
	out.HasMore, out.PageToken = *resp.Data.HasMore, resp.Data.PageToken
	return out, nil
}

// ListMessageAnchors is a UI history page, separate from ListChatMessages's
// single recent inbound window. The chat container includes topic roots; it
// does not expand every topic's replies or forwarded child messages.
func (c *httpAPIClient) ListMessageAnchors(ctx context.Context, creds InstallationCredentials, p DiscoveryParams, chatID string) (DiscoveryPage[MessageAnchor], error) {
	out := DiscoveryPage[MessageAnchor]{Items: []MessageAnchor{}}
	q, err := discoveryQuery(p, 50)
	if err != nil || !ValidDiscoveryChatID(chatID) {
		return out, ErrDiscoveryInvalidRequest
	}
	// Reject p2p IDs even when a manager supplies one manually. Get-chat may
	// return limited public information to non-members; the message endpoint
	// independently checks live bot membership on EVERY page.
	var chat struct {
		Code *int `json:"code"`
		Data struct {
			Mode string `json:"chat_mode"`
		} `json:"data"`
	}
	if err := c.doAuthedJSON(ctx, creds, http.MethodGet, "/open-apis/im/v1/chats/"+url.PathEscape(chatID), nil, &chat); err != nil {
		return out, discoveryError(err)
	}
	if chat.Code == nil {
		return out, ErrDiscoveryResponse
	}
	if *chat.Code != 0 {
		if isTokenError(*chat.Code) {
			c.invalidateToken(creds.AppID)
		}
		return out, discoveryError(&APIError{Code: *chat.Code})
	}
	if chat.Data.Mode != "group" && chat.Data.Mode != "topic" {
		return out, ErrDiscoveryChat
	}
	q.Set("container_id_type", "chat")
	q.Set("container_id", chatID)
	q.Set("sort_type", "ByCreateTimeDesc")
	var resp discoveryResponse[larkRESTMessageItem]
	if err := c.doAuthedJSON(ctx, creds, http.MethodGet, "/open-apis/im/v1/messages?"+q.Encode(), nil, &resp); err != nil {
		return out, discoveryError(err)
	}
	if resp.Code != nil && isTokenError(*resp.Code) {
		c.invalidateToken(creds.AppID)
	}
	if err := resp.validate(p); err != nil {
		return out, err
	}
	for _, msg := range resp.Data.Items {
		if msg.ChatID != chatID {
			return out, ErrDiscoveryResponse
		}
		if msg.Deleted || msg.UpperMessageID != "" {
			continue
		}
		created, err := strconv.ParseInt(msg.CreateTime, 10, 64)
		if !validDiscoveryID(msg.MessageID, "om_") || err != nil || created < 0 {
			return out, ErrDiscoveryResponse
		}
		summary := flattenContent(msg.MsgType, msg.Body.Content)
		for _, mention := range msg.Mentions {
			if mention.Key != "" && mention.Name != "" {
				summary = strings.ReplaceAll(summary, mention.Key, "@"+mention.Name)
			}
		}
		summary = strings.Join(strings.FieldsFunc(summary, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
		if summary == "" {
			summary = "[Message]"
		}
		if runes := []rune(summary); len(runes) > 200 {
			summary = string(runes[:200]) + "…"
		}
		sender := AnchorSender{Type: "unknown"}
		switch msg.Sender.SenderType {
		case "user", "app":
			sender.Type = msg.Sender.SenderType
			if (sender.Type == "user" && msg.Sender.IDType == "open_id") || (sender.Type == "app" && msg.Sender.IDType == "app_id") {
				sender.ID, sender.IDType = msg.Sender.ID, msg.Sender.IDType
			}
		case "anonymous":
			sender.Type = "anonymous"
		}
		out.Items = append(out.Items, MessageAnchor{MessageID: msg.MessageID, ChatID: chatID, MessageType: msg.MsgType,
			Summary: summary, CreateTime: strconv.FormatInt(created, 10), ThreadID: msg.ThreadID, Sender: sender})
	}
	out.HasMore, out.PageToken = *resp.Data.HasMore, resp.Data.PageToken
	return out, nil
}

func ValidDiscoveryChatID(id string) bool { return validDiscoveryID(id, "oc_") }

func validDiscoveryID(id, prefix string) bool {
	if !strings.HasPrefix(id, prefix) || len(id) <= len(prefix) || len(id) > 200 {
		return false
	}
	for _, r := range id[len(prefix):] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// Never expose upstream messages, URLs, raw bodies or token errors to the UI.
func discoveryError(err error) error {
	var syntax *json.SyntaxError
	var shape *json.UnmarshalTypeError
	if errors.As(err, &syntax) || errors.As(err, &shape) {
		return ErrDiscoveryResponse
	}
	code := larkErrorCode(err)
	switch code {
	case 230001, 232001:
		return ErrDiscoveryInvalidRequest
	case 230002, 230013, 230073, 232006, 232009, 232010, 232011:
		return ErrDiscoveryChat
	case 230011, 230019, 230110:
		return ErrDiscoveryMessage
	case 230027, 232033, 99991672, 99991676, 99991679:
		return ErrDiscoveryPermission
	case 230020, 99991400, 99991403:
		return ErrDiscoveryRateLimited
	case 230006, 232004, 232025, 232034:
		return ErrDiscoveryUnavailable
	}
	var status *larkAPIStatusError
	if errors.As(err, &status) {
		switch status.StatusCode {
		case http.StatusTooManyRequests:
			return ErrDiscoveryRateLimited
		case http.StatusForbidden:
			return ErrDiscoveryPermission
		}
	}
	return ErrDiscoveryUnavailable
}

var _ TargetDiscoveryClient = (*httpAPIClient)(nil)
