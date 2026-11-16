package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestZcodeSkillFallbackPassesThroughSendContent locks the zcode leg of the
// explicit-skill contract: the app-server protocol (session/create,
// session/send) has no user-level skill-invocation entry, so the daemon's
// FallbackPrompt — platform text plus the <selected-skill> injections — must
// reach the server verbatim as session/send `content`.
func TestZcodeSkillFallbackPassesThroughSendContent(t *testing.T) {
	dir := t.TempDir()
	sendPath := filepath.Join(dir, "send.txt")
	script := fmt.Sprintf(`#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"session/create"'*)
      printf '{"id":%%s,"result":{"protocol":{"name":"ZCode Protocol","version":1},"session":{"sessionId":"%s"}}}\n' "$id"
      ;;
    *'"method":"session/subscribe"'*)
      printf '{"id":%%s,"result":{"sessionId":"%s","eventSeq":1,"events":[]}}\n' "$id"
      ;;
    *'"method":"session/send"'*)
      printf '%%s\n' "$line" > %s
      printf '{"id":%%s,"result":{"sessionId":"%s","accepted":true,"stateRevision":1}}\n' "$id"
      printf '{"method":"session/event","params":{"type":"turn.completed","seq":2,"sessionId":"%s","payload":{"response":"done","resultType":"success","tokenCount":0,"toolCount":0,"duration":1}}}\n'
      ;;
  esac
done
`, fakeZcodeSessionID, fakeZcodeSessionID, sendPath, fakeZcodeSessionID, fakeZcodeSessionID)
	bin := writeFakeZcodeScript(t, script)

	invocation := &SkillInvocation{
		Prompt:      "Issue context with --parent comment-trigger",
		UserMessage: "please review",
		Skills:      []ExplicitSkill{{Name: "review-code", Directory: filepath.Join(dir, "review-code"), Body: "SKILL BODY"}},
	}
	session, err := newZcodeTestBackend(t, bin).Execute(context.Background(), invocation.FallbackPrompt(), ExecOptions{
		Cwd: dir,
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}
	if res := <-session.Result; res.Status != "completed" {
		t.Fatalf("result: %+v", res)
	}
	raw, err := os.ReadFile(sendPath)
	if err != nil {
		t.Fatalf("session/send not captured: %v", err)
	}
	var request struct {
		Params struct {
			Content string `json:"content"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatalf("send frame: %v (%s)", err, raw)
	}
	for _, want := range []string{"--parent comment-trigger", "The user explicitly selected this skill", "SKILL BODY"} {
		if !strings.Contains(request.Params.Content, want) {
			t.Errorf("session/send content lost %q: %s", want, request.Params.Content)
		}
	}
	if strings.Contains(request.Params.Content, "/skill:") {
		t.Errorf("zcode must never receive a native skill token: %s", request.Params.Content)
	}
}
