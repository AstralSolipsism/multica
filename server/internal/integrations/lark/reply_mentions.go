package lark

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"
)

// replyMentionIDs binds notification authority to this task's trigger. A model
// answer, a quoted/forwarded message, and a newer session turn grant no authority.
// The explicit first-line directive uses native Feishu mention selections, not
// display names or model-supplied IDs: /mention @Alice @Bob (then the question).
func (p *Patcher) replyMentionIDs(ctx context.Context, creds InstallationCredentials, binding ChatSessionBinding, botOpenID string) []string {
	var ids []string
	if id := safeMentionOpenID(mentionOpenID(binding)); id != "" {
		ids = append(ids, id)
	}
	if ChatType(binding.ChatType) != ChatTypeGroup || !binding.LastMessageID.Valid ||
		binding.LastMessageID.String == "" || !binding.LastSenderID.Valid || safeMentionOpenID(binding.LastSenderID.String) == "" {
		return ids
	}
	// A failed/slow lookup must lose only additional mentions, never the answer.
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	items, err := p.client.GetMessage(ctx, creds, binding.LastMessageID.String)
	if err != nil || len(items) != 1 {
		return ids
	}
	m := items[0]
	if m.Deleted || m.MessageID != binding.LastMessageID.String || m.ChatID != string(outboundChatID(binding)) ||
		m.SenderType != "user" || m.SenderID != binding.LastSenderID.String || m.ThreadID != binding.LastThreadID.String || m.UpperMessageID != "" {
		return ids
	}
	requested := requestedReplyMentions(m, botOpenID)
	if len(requested) == 0 {
		return ids
	}
	users, err := p.client.BatchGetUsers(ctx, creds, requested)
	if err != nil {
		return ids
	}
	for _, id := range requested {
		if users[id] != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids
}

func requestedReplyMentions(m LarkMessage, botOpenID string) []string {
	var text string
	switch m.MessageType {
	case "text":
		text = extractTextBody(m.Content)
	case "post":
		var post larkPostContent
		if json.Unmarshal([]byte(m.Content), &post) != nil || post.Title != "" || len(post.Content) == 0 {
			return nil
		}
		// A rich-text quote, link or code block cannot masquerade as a directive.
		for _, span := range post.Content[0] {
			if span.Tag != "text" && span.Tag != "at" {
				return nil
			}
		}
		text = flattenPostParagraph(post.Content[0])
	default:
		return nil
	}
	first, _, _ := strings.Cut(text, "\n")
	fields := strings.Fields(first)
	// The bot mention may precede the directive to address a group message.
	if len(fields) > 0 {
		for _, mention := range m.Mentions {
			if mention.ID == botOpenID && botOpenID != "" && fields[0] == mention.Key {
				fields = fields[1:]
				break
			}
		}
	}
	line := strings.Join(fields, " ")
	if strings.HasPrefix(line, "回复时提醒：") {
		fields = strings.Fields(strings.TrimPrefix(line, "回复时提醒："))
	} else if len(fields) > 0 && fields[0] == "/mention" {
		fields = fields[1:]
	} else {
		return nil
	}
	if len(fields) == 0 || len(fields) > larkBatchGetUsersMaxIDs {
		return nil
	}
	var ids []string
	for _, key := range fields {
		if !strings.HasPrefix(key, "@_user_") {
			return nil
		}
		id := ""
		for _, mention := range m.Mentions {
			if mention.Key != key {
				continue
			}
			// Duplicate keys, @all, bots and malformed identities fail closed.
			if id != "" || safeMentionOpenID(mention.ID) == "" || mention.ID == botOpenID {
				return nil
			}
			id = mention.ID
		}
		if id == "" {
			return nil
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids
}

type replyPostNode struct {
	Tag    string `json:"tag"`
	Text   string `json:"text,omitempty"`
	UserID string `json:"user_id,omitempty"`
}

// The body is always a text node; only verified personal IDs become at nodes.
func literalChatReply(body string, mentions []string) any {
	nodes := make([]replyPostNode, 0, len(mentions)*2+1)
	var seen []string
	for _, id := range mentions {
		if safeMentionOpenID(id) == "" || slices.Contains(seen, id) {
			continue
		}
		seen = append(seen, id)
		nodes = append(nodes, replyPostNode{Tag: "at", UserID: id}, replyPostNode{Tag: "text", Text: " "})
	}
	nodes = append(nodes, replyPostNode{Tag: "text", Text: body})
	return map[string]any{"zh_cn": map[string]any{"title": "", "content": [][]replyPostNode{nodes}}}
}
