package agent

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testSkillInvocation(t *testing.T) *SkillInvocation {
	t.Helper()
	return &SkillInvocation{
		Prompt:         "Platform context\nUser message:\n/compact keep this text\nAttachments: file-id",
		PlatformPrompt: "Platform context\nAttachments: file-id",
		UserMessage:    "/compact keep this text",
		Skills: []ExplicitSkill{
			{Name: "first-multica", Directory: filepath.Join(t.TempDir(), "first-multica"), Body: "FIRST REQUIREMENT"},
			{Name: "second", Directory: filepath.Join(t.TempDir(), "second"), Body: "SECOND REQUIREMENT"},
		},
	}
}

func TestExplicitSkillsProviderInputs(t *testing.T) {
	s := testSkillInvocation(t)
	blocks := s.claudeTextBlocks(map[string]bool{"first-multica": true})
	wire, err := buildClaudeInput(blocks...)
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Message struct{ Content []struct{ Type, Text string } }
	}
	if err := json.Unmarshal(wire, &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Message.Content) != 2 || input.Message.Content[1].Text != "/first-multica /compact keep this text" {
		t.Fatalf("Claude command must start last block: %s", wire)
	}
	if !strings.Contains(blocks[0], "Attachments: file-id") || !strings.Contains(blocks[0], "SECOND REQUIREMENT") || strings.Contains(blocks[0], "FIRST REQUIREMENT") {
		t.Fatalf("Claude platform block=%q", blocks[0])
	}
	agy := s.antigravityPrompt(true)
	if !strings.HasPrefix(agy, "/first-multica\nPlatform context") || !strings.Contains(agy, "SECOND REQUIREMENT") || strings.Contains(agy, "FIRST REQUIREMENT") {
		t.Fatalf("agy prompt=%q", agy)
	}
	catalog, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"skills": []any{
		map[string]any{"name": s.Skills[0].Name, "path": filepath.Join(s.Skills[0].Directory, "SKILL.md"), "enabled": true},
		map[string]any{"name": s.Skills[1].Name, "path": filepath.Join(s.Skills[1].Directory, "SKILL.md"), "enabled": true},
	}}}})
	codex := s.codexPrompt(catalog)
	if !strings.Contains(codex, "$first-multica\n") || !strings.Contains(codex, "$second\n") || strings.Contains(codex, "REQUIREMENT") || !strings.Contains(codex, s.UserMessage) {
		t.Fatalf("Codex prompt=%q", codex)
	}
}

func TestExplicitSkillsMissingCapabilitiesFallBack(t *testing.T) {
	s := testSkillInvocation(t)
	for _, catalog := range []string{`{}`, `{"data":[]}`, `{"data":[{"skills":[{"name":"first-multica","path":"/some-other/SKILL.md","enabled":true}]}]}`, `not json`} {
		if got := s.codexPrompt(json.RawMessage(catalog)); got != s.FallbackPrompt() {
			t.Fatalf("unsupported Codex: %q", got)
		}
	}
	for _, commands := range []map[string]bool{nil, {}, {"second": true}} {
		blocks := s.claudeTextBlocks(commands)
		if len(blocks) != 1 || blocks[0] != s.FallbackPrompt() {
			t.Fatalf("unsupported Claude: %v", blocks)
		}
	}
	if s.antigravityPrompt(false) != s.FallbackPrompt() {
		t.Fatal("unsupported agy lost fallback")
	}
	for _, want := range []string{s.UserMessage, "FIRST REQUIREMENT", "SECOND REQUIREMENT", s.Skills[0].Directory, "user explicitly selected"} {
		if !strings.Contains(s.FallbackPrompt(), want) {
			t.Errorf("fallback lost %q", want)
		}
	}
}

func TestCodexExplicitSkillDisabledOrMalformedEntryFallsBack(t *testing.T) {
	s := testSkillInvocation(t)
	for _, enabled := range []any{false, nil, "true"} {
		catalog, _ := json.Marshal(map[string]any{"data": []any{map[string]any{"skills": []any{map[string]any{"name": s.Skills[0].Name, "path": filepath.Join(s.Skills[0].Directory, "SKILL.md"), "enabled": enabled}}}}})
		if got := s.codexPrompt(catalog); got != s.FallbackPrompt() {
			t.Fatalf("disabled/malformed skill invoked: %q", got)
		}
	}
}

func TestAntigravityExplicitSkillCapabilityProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	for _, tc := range []struct {
		name, script   string
		disabled, want bool
	}{
		{"supported", "echo --disable-slash-commands", false, true},
		{"old CLI", "echo usage", false, false},
		{"failed help", "exit 2", false, false},
		{"explicitly disabled", "echo --disable-slash-commands", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fake-agy")
			writeTestExecutable(t, path, []byte("#!/bin/sh\n"+tc.script+"\n"))
			opts := ExecOptions{}
			if tc.disabled {
				opts.CustomArgs = []string{"--disable-slash-commands"}
			}
			if got := supportsAntigravitySlashSkills(t.Context(), Config{Logger: slog.Default()}, path, opts); got != tc.want {
				t.Fatalf("capability=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestClaudeExplicitSkillsExecute(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	for _, supported := range []bool{true, false} {
		t.Run(map[bool]string{true: "native", false: "fallback"}[supported], func(t *testing.T) {
			s := testSkillInvocation(t)
			dir := t.TempDir()
			capture := filepath.Join(dir, "input.json")
			path := filepath.Join(dir, "fake-claude")
			response := `{"subtype":"error","request_id":"multica-supplement-initialize","error":"unsupported"}`
			if supported {
				response = `{"subtype":"success","request_id":"multica-supplement-initialize","response":{"commands":[{"name":"first-multica"}]}}`
			}
			script := "#!/bin/sh\nread init\nprintf '%s\\n' '{\"type\":\"control_response\",\"response\":" + response + "}'\nIFS= read -r input\nprintf '%s\\n' \"$input\" > \"$CAPTURE\"\nprintf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}'\ncat >/dev/null\n"
			writeTestExecutable(t, path, []byte(script))
			backend := &claudeBackend{cfg: Config{ExecutablePath: path, Logger: slog.Default(), Env: map[string]string{"CAPTURE": capture, "IS_SANDBOX": "1"}}}
			session, err := backend.Execute(t.Context(), s.FallbackPrompt(), ExecOptions{SkillInvocation: s, Timeout: 10 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			if result := <-session.Result; result.Status != "completed" {
				t.Fatalf("result=%+v", result)
			}
			wire, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			var input struct {
				Message struct{ Content []struct{ Text string } }
			}
			if err := json.Unmarshal(wire, &input); err != nil {
				t.Fatal(err)
			}
			if supported {
				if len(input.Message.Content) != 2 || !strings.HasPrefix(input.Message.Content[1].Text, "/first-multica ") {
					t.Fatalf("native input=%s", wire)
				}
			} else if len(input.Message.Content) != 1 || input.Message.Content[0].Text != s.FallbackPrompt() {
				t.Fatalf("fallback input=%s", wire)
			}
		})
	}
}

func TestCodexExplicitSkillsExecuteCapabilityFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	for _, supported := range []bool{true, false} {
		t.Run(fmt.Sprintf("supported=%t", supported), func(t *testing.T) {
			s := testSkillInvocation(t)
			response := `{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}`
			if supported {
				catalog, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 3, "result": map[string]any{"data": []any{map[string]any{"skills": []any{map[string]any{"name": s.Skills[0].Name, "path": filepath.Join(s.Skills[0].Directory, "SKILL.md"), "enabled": true}}}}}})
				if err != nil {
					t.Fatal(err)
				}
				response = string(catalog)
			}
			path := writeFakeCodexAppServer(t, `read line
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read line
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"skill-thread"}}}'
read line
echo '`+response+`'
IFS= read -r line
printf '%s\n' "$line" > "$CAPTURE"
echo '{"jsonrpc":"2.0","id":4,"result":{"turn":{"id":"skill-turn"}}}'
echo '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"skill-thread","turn":{"id":"skill-turn"}}}'
echo '{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"skill-thread","item":{"type":"agentMessage","id":"response","text":"Done"}}}'
echo '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"skill-thread","turn":{"id":"skill-turn","status":"completed"}}}'
`)
			capture := filepath.Join(t.TempDir(), "input.json")
			backend, err := New("codex", Config{ExecutablePath: path, Logger: slog.Default(), Env: map[string]string{"CAPTURE": capture}})
			if err != nil {
				t.Fatal(err)
			}
			session, err := backend.Execute(t.Context(), s.FallbackPrompt(), ExecOptions{SkillInvocation: s, Cwd: t.TempDir(), Timeout: 10 * time.Second, ResumeExpected: true, ResumeContinuityNotice: "History unavailable.\n"})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			if result := <-session.Result; result.Status != "completed" {
				t.Fatalf("result=%+v", result)
			}
			wire, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			var request struct {
				Method string
				Params struct{ Input []struct{ Text string } }
			}
			if err := json.Unmarshal(wire, &request); err != nil {
				t.Fatal(err)
			}
			if request.Method != "turn/start" || len(request.Params.Input) != 1 {
				t.Fatalf("wrong input: %s", wire)
			}
			got := request.Params.Input[0].Text
			for _, want := range []string{s.UserMessage, "History unavailable.", "SECOND REQUIREMENT"} {
				if !strings.Contains(got, want) {
					t.Fatalf("lost %q: %s", want, got)
				}
			}
			if supported {
				if !strings.Contains(got, "$first-multica") || strings.Contains(got, "FIRST REQUIREMENT") {
					t.Fatalf("missing native input: %s", got)
				}
			} else if !strings.Contains(got, "FIRST REQUIREMENT") || strings.Contains(got, "$first-multica") {
				t.Fatalf("missing fallback: %s", got)
			}
		})
	}
}

func TestInjectedSkillsReachACPWithRuntimeBrief(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	for _, provider := range []string{"kimi", "hermes"} {
		t.Run(provider, func(t *testing.T) {
			s := testSkillInvocation(t)
			dir := t.TempDir()
			path, capture := filepath.Join(dir, "fake-acp"), filepath.Join(dir, "prompt.json")
			writeTestExecutable(t, path, []byte(`#!/bin/sh
read line
echo '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}'
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"skills-acp"}}'
IFS= read -r line
printf '%s\n' "$line" > "$CAPTURE"
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"skills-acp","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done"}}}}'
echo '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
`))
			backend, err := New(provider, Config{ExecutablePath: path, Logger: slog.Default(), Env: map[string]string{"CAPTURE": capture}})
			if err != nil {
				t.Fatal(err)
			}
			session, err := backend.Execute(t.Context(), s.FallbackPrompt(), ExecOptions{SkillInvocation: s, Cwd: dir, SystemPrompt: "RUNTIME BRIEF", Timeout: 8 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			if result := <-session.Result; result.Status != "completed" {
				t.Fatalf("result=%+v", result)
			}
			wire, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			var request struct {
				Method string
				Params struct{ Prompt []struct{ Type, Text string } }
			}
			if err := json.Unmarshal(wire, &request); err != nil {
				t.Fatal(err)
			}
			if request.Method != "session/prompt" || len(request.Params.Prompt) != 1 || request.Params.Prompt[0].Type != "text" {
				t.Fatalf("wrong ACP input: %s", wire)
			}
			want := s.FallbackPrompt()
			if provider == "kimi" {
				want = "RUNTIME BRIEF\n\n---\n\n" + want
			}
			if request.Params.Prompt[0].Text != want {
				t.Fatalf("lost injected body/brief: %s", wire)
			}
		})
	}
}

func TestAntigravityExplicitSkillsExecuteFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	for _, supported := range []bool{true, false} {
		t.Run(fmt.Sprintf("supported=%t", supported), func(t *testing.T) {
			s := testSkillInvocation(t)
			dir := t.TempDir()
			path, capture := filepath.Join(dir, "fake-agy"), filepath.Join(dir, "prompt.txt")
			help := "usage"
			if supported {
				help = "--disable-slash-commands"
			}
			writeTestExecutable(t, path, []byte("#!/bin/sh\nif [ \"$1\" = '--help' ]; then echo '"+help+"'; exit 0; fi\nprintf '%s' \"$2\" > \"$CAPTURE\"\necho Done\n"))
			backend, err := New("antigravity", Config{ExecutablePath: path, Logger: slog.Default(), Env: map[string]string{"CAPTURE": capture}})
			if err != nil {
				t.Fatal(err)
			}
			session, err := backend.Execute(t.Context(), s.FallbackPrompt(), ExecOptions{SkillInvocation: s, Cwd: dir, Timeout: 8 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			if result := <-session.Result; result.Status != "completed" {
				t.Fatalf("result=%+v", result)
			}
			prompt, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			if string(prompt) != s.antigravityPrompt(supported) {
				t.Fatalf("wrong agy input: %s", prompt)
			}
		})
	}
}
