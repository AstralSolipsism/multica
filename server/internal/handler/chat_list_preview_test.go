package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestChatListPreviewTruncation pins the list-preview contract: the session
// LIST caps last_message.content at 200 runes on a rune boundary, while the
// /messages endpoint keeps returning the full text.
func TestChatListPreviewTruncation(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "ChatPreviewAgent", []byte("[]"))
	sessionID := createHandlerTestChatSession(t, agentID)
	ctx := context.Background()

	long := strings.Repeat("a", 50) + " 中文消息测试 " + strings.Repeat("b", 400)
	if _, err := testPool.Exec(ctx,
		`INSERT INTO chat_message (chat_session_id, role, content) VALUES ($1, 'assistant', $2)`,
		sessionID, long); err != nil {
		t.Fatalf("insert assistant message: %v", err)
	}

	listSessions := func() *ChatLastMessage {
		t.Helper()
		req := withChatTestWorkspaceCtx(t, newRequest("GET", "/api/chat/sessions?status=all", nil))
		w := httptest.NewRecorder()
		testHandler.ListChatSessions(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("ListChatSessions: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp []ChatSessionResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode list: %v", err)
		}
		for _, s := range resp {
			if s.ID == sessionID && s.LastMessage != nil {
				return s.LastMessage
			}
		}
		t.Fatalf("session %s (or its last_message) not found", sessionID)
		return nil
	}

	preview := listSessions()
	if got := utf8.RuneCountInString(preview.Content); got != chatListPreviewLimit {
		t.Fatalf("preview = %d runes, want %d", got, chatListPreviewLimit)
	}
	if !utf8.ValidString(preview.Content) {
		t.Fatal("preview is not valid UTF-8 (rune boundary was split)")
	}
	if want := string([]rune(long)[:chatListPreviewLimit-1]) + "…"; preview.Content != want {
		t.Fatalf("preview = %q, want %q", preview.Content, want)
	}
	if preview.Role != "assistant" {
		t.Fatalf("role = %q, want assistant", preview.Role)
	}

	// /messages must keep the full text.
	req := withURLParam(withChatTestWorkspaceCtx(t, newRequest("GET", "/api/chat/sessions/"+sessionID+"/messages", nil)), "sessionId", sessionID)
	w := httptest.NewRecorder()
	testHandler.ListChatMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListChatMessages: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var messages []ChatMessageResponse
	if err := json.Unmarshal(w.Body.Bytes(), &messages); err != nil {
		t.Fatalf("decode messages: %v", err)
	}
	found := false
	for _, m := range messages {
		if m.Content == long {
			found = true
		}
	}
	if !found {
		t.Fatal("/messages no longer returns the full last-message content")
	}
}

// TestChatListPreviewKeepsFencedContentReadable guards the front-end contract:
// the list row collapses fenced blocks whole, so a preview cut inside a fence
// that opened near the start would render as an empty line. The preview must
// strip the fence markers instead, keeping the code text visible.
func TestChatListPreviewKeepsFencedContentReadable(t *testing.T) {
	// Truncation must have happened for this fixture to make sense.
	fenced := "```html\n<html><body>decision card</body></html>\n" + strings.Repeat("x", 300)
	got := chatListPreview(fenced)
	if got == fenced {
		t.Fatal("fixture was not truncated; make it longer than the limit")
	}
	if strings.Contains(got, "```") {
		t.Fatalf("fence marker survived: %q", got)
	}
	if !strings.Contains(got, "html") || !strings.Contains(got, "decision card") {
		t.Fatalf("fenced content lost from preview: %q", got)
	}

	// Mirrors the front-end toPreview collapse; must not degrade to empty.
	toPreview := func(content string) string {
		replaced := regexpReplaceFences(content)
		for _, c := range []string{"#", "*", "`", ">", "~"} {
			replaced = strings.ReplaceAll(replaced, c, "")
		}
		return strings.Join(strings.Fields(replaced), " ")
	}
	if toPreview(got) == "" {
		t.Fatalf("preview collapses to empty line on the client: %q", got)
	}
}

// TestChatListPreviewShortContentUnchanged: under the limit nothing is cut.
func TestChatListPreviewShortContentUnchanged(t *testing.T) {
	for _, s := range []string{"", "short", strings.Repeat("汉", 200)} {
		if got := chatListPreview(s); got != s {
			t.Fatalf("chatListPreview(%q) = %q, want unchanged", s, got)
		}
	}
	if got := chatListPreview(strings.Repeat("汉", 201)); utf8.RuneCountInString(got) != chatListPreviewLimit {
		t.Fatalf("multibyte truncation = %d runes, want %d", utf8.RuneCountInString(got), chatListPreviewLimit)
	}
}

// regexpReplaceFences mirrors the client's /```[\s\S]*?```/g whole-block strip
// non-greedily: everything from an opening fence to the nearest closing fence
// (or the end when unclosed) is replaced with a space.
func regexpReplaceFences(s string) string {
	for {
		start := strings.Index(s, "```")
		if start < 0 {
			return s
		}
		rest := s[start+3:]
		end := strings.Index(rest, "```")
		if end < 0 {
			return s[:start] + " " + rest
		}
		s = s[:start] + " " + rest[end+3:]
	}
}
