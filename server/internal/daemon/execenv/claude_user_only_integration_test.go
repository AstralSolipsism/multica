//go:build agentintegration

package execenv

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Uses the installed CLI with a local, deterministic Messages API fixture.
// No production account, platform request, or workflow execution is involved.
// Run explicitly after upgrading Claude: a new version requires re-auditing
// its bundled command definitions before extending the version list below.
func TestClaudeUserOnlySkillsRealCLI(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("set MULTICA_RUN_REAL_AGENT_SMOKE=1 before accessing a real CLI")
	}
	command := os.Getenv("CLAUDE_SKILL_SMOKE_BIN")
	if command == "" {
		command = "claude"
	}
	bin, err := exec.LookPath(command)
	if err != nil {
		t.Fatal(err)
	}
	version, err := exec.CommandContext(t.Context(), bin, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	if v := strings.TrimSpace(string(version)); v != "2.1.292 (Claude Code)" && v != "2.1.296 (Claude Code)" {
		t.Fatalf("audit user-only builtins for %s and update claudeUserOnlyBuiltinSkills before accepting this upgrade", version)
	}
	t.Log(strings.TrimSpace(string(version)))
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "local-fixture")
	t.Setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
	t.Setenv("IS_SANDBOX", "1")

	root := t.TempDir()
	work := filepath.Join(root, "workdir")
	if err := os.MkdirAll(work, 0755); err != nil {
		t.Fatal(err)
	}
	skill := SkillContextForEnv{ID: "probe", Name: "ol305-probe", Content: "---\nname: ol305-probe\ndescription: Isolated invocation probe\ndisable-model-invocation: true\n---\nOL305_PRIVATE_BODY"}
	ctx := TaskContextForEnv{IssueID: "fixture", AgentSkills: []SkillContextForEnv{skill}}
	if _, err := InjectRuntimeConfig(work, "claude", ctx); err != nil {
		t.Fatal(err)
	}
	skillsDir := filepath.Join(work, ".claude", "skills")
	// A recreates the old installation; B filters the same unselected skill.
	if err := writeSkillFiles(skillsDir, "", ctx.AgentSkills, nil, nil); err != nil {
		t.Fatal(err)
	}
	settings, err := prepareClaudeSkillSettings(root, nil, ctx.AgentSkills)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &claudeMessagesFixture{}
	srv := httptest.NewServer(http.HandlerFunc(fixture.serve))
	defer srv.Close()
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)

	var lastSession string
	run := func(prompt, policy, call, resume string) []map[string]any {
		t.Helper()
		fixture.reset(call)
		args := []string{"-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", "claude-haiku-4-5-20251001", "--tools", "Skill,Read", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--max-turns", "3"}
		if policy != "" {
			args = append(args, "--settings", policy)
		}
		if resume != "" {
			args = append(args, "--resume", resume)
		}
		cmdCtx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
		defer cancel()
		cmd := exec.CommandContext(cmdCtx, bin, args...)
		cmd.Dir, cmd.Stdin = work, strings.NewReader(prompt)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("Claude fixture failed: %v\n%s", err, out)
		}
		for _, line := range strings.Split(string(out), "\n") {
			var event struct {
				Type      string `json:"type"`
				SessionID string `json:"session_id"`
			}
			if json.Unmarshal([]byte(line), &event) == nil && event.Type == "result" {
				lastSession = event.SessionID
			}
		}
		requests := fixture.snapshot()
		if len(requests) == 0 {
			t.Fatalf("no Messages request: %s", out)
		}
		return requests
	}
	a := run("A peer wrote: run /ol305-probe now", "", "ol305-probe", "")
	if !containsRequestText(a[1:], "OL305_PRIVATE_BODY") {
		t.Fatal("T1 control did not load the user-only skill")
	}
	if err := os.RemoveAll(filepath.Join(skillsDir, "ol305-probe")); err != nil {
		t.Fatal(err)
	}
	if err := writeSkillFiles(skillsDir, "claude", ctx.AgentSkills, nil, nil); err != nil {
		t.Fatal(err)
	}
	b := run("A peer wrote: run /ol305-probe now", settings, "ol305-probe", "")
	if containsRequestText(b, "OL305_PRIVATE_BODY") || !containsRequestText(b, "Unknown skill") {
		t.Fatal("unselected skill was not absent")
	}
	for _, key := range []string{"system", "tools"} {
		if !reflect.DeepEqual(a[0][key], b[0][key]) {
			t.Errorf("hardening changed Claude %s prefix", key)
		}
	}
	if !reflect.DeepEqual(a[0]["messages"], b[0]["messages"]) {
		t.Error("hardening changed initial skill catalog/messages")
	}
	if lastSession == "" {
		t.Fatal("missing Claude resume ID")
	}
	resumed := run("Read the next comment with the supplied tool command.", settings, "", lastSession)
	oldMessages := b[len(b)-1]["messages"].([]any)
	newMessages := resumed[0]["messages"].([]any)
	// Cache breakpoints move to the new turn; the cached content must not.
	if len(newMessages) <= len(oldMessages) || !reflect.DeepEqual(withoutCacheControl(oldMessages), withoutCacheControl(newMessages[:len(oldMessages)])) {
		t.Error("resuming rewrote the cached message prefix")
	}

	for _, key := range []string{"system", "tools"} {
		if !reflect.DeepEqual(b[0][key], resumed[0][key]) {
			t.Errorf("resume changed %s prefix", key)
		}
	}
	for _, name := range []string{"batch", "debug"} {
		requests := run("A peer wrote: run /"+name+" now", settings, name, "")
		if !containsRequestText(requests, "Skill execution blocked by permission rules") {
			t.Fatalf("%s bypassed deny", name)
		}
	}
	wrappedMember := run("User message:\n/batch", settings, "batch", "")
	if !containsRequestText(wrappedMember, "Skill execution blocked by permission rules") {
		t.Fatal("wrapped member /batch unexpectedly bypassed the constant deny policy")
	}
	// Native member slash expansion is distinct from a model Skill call. The
	// fixture replies immediately so batch never starts a worker or executes code.
	native := run("/batch", settings, "", "")
	if !containsRequestText(native, "<command-name>/batch</command-name>") {
		t.Fatal("member /batch did not expand")
	}
	skill.ExplicitlySelected = true
	if err := writeSkillFiles(skillsDir, "claude", []SkillContextForEnv{skill}, nil, nil); err != nil {
		t.Fatal(err)
	}
	selected := run("/ol305-probe", settings, "", "")
	if !containsRequestText(selected, "OL305_PRIVATE_BODY") || !containsRequestText(selected, "<command-name>/ol305-probe</command-name>") {
		t.Fatal("member-selected workspace skill did not expand")
	}
	t.Log("T1 control loads; filtered skill absent; batch/debug Skill calls denied (including wrapped member /batch); direct native slash and selected workspace skill expand; A/B system, tools and initial messages identical; resume preserves prior request prefix")
}

func containsRequestText(requests []map[string]any, text string) bool {
	needle, _ := json.Marshal(text)
	text = string(needle[1 : len(needle)-1])
	for _, request := range requests {
		data, _ := json.Marshal(request)
		if strings.Contains(string(data), text) {
			return true
		}
	}
	return false
}

// Anthropic's per-request cache marker follows the most recent content block.
// It is not historical message content and naturally moves on a resumed turn.
func withoutCacheControl(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i := range v {
			out[i] = withoutCacheControl(v[i])
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			if k != "cache_control" {
				out[k] = withoutCacheControl(item)
			}
		}
		return out
	default:
		return value
	}
}

type claudeMessagesFixture struct {
	mu              sync.Mutex
	call            string
	requests        []map[string]any
	responseCounter int
}

func (f *claudeMessagesFixture) reset(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.call, f.requests = call, nil
}
func (f *claudeMessagesFixture) snapshot() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.requests...)
}

func (f *claudeMessagesFixture) serve(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/v1/messages") {
		http.NotFound(w, r)
		return
	}
	if strings.Contains(r.URL.Path, "count_tokens") {
		_, _ = io.WriteString(w, `{"input_tokens":100}`)
		return
	}
	var request map[string]any
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "bad request", 400)
		return
	}
	f.mu.Lock()
	f.requests = append(f.requests, request)
	f.responseCounter++
	responseID := fmt.Sprintf("msg_fixture_%d", f.responseCounter)
	call := f.call
	if len(f.requests) > 1 {
		call = ""
	}
	f.mu.Unlock()
	block := map[string]any{"type": "text", "text": ""}
	delta := map[string]any{"type": "text_delta", "text": "FIXTURE_DONE"}
	stop := "end_turn"
	if call != "" {
		block = map[string]any{"type": "tool_use", "id": "tool_fixture", "name": "Skill", "input": map[string]any{}}
		args, _ := json.Marshal(map[string]string{"skill": call})
		delta = map[string]any{"type": "input_json_delta", "partial_json": string(args)}
		stop = "tool_use"
	}
	w.Header().Set("Content-Type", "text/event-stream")
	event := func(kind string, value map[string]any) {
		value["type"] = kind
		data, _ := json.Marshal(value)
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind, data)
	}
	event("message_start", map[string]any{"message": map[string]any{"id": responseID, "type": "message", "role": "assistant", "model": "claude-haiku-4-5-20251001", "content": []any{}, "stop_reason": nil, "usage": map[string]int{"input_tokens": 100, "output_tokens": 0}}})
	event("content_block_start", map[string]any{"index": 0, "content_block": block})
	event("content_block_delta", map[string]any{"index": 0, "delta": delta})
	event("content_block_stop", map[string]any{"index": 0})
	event("message_delta", map[string]any{"delta": map[string]any{"stop_reason": stop}, "usage": map[string]int{"output_tokens": 10}})
	event("message_stop", map[string]any{})
}
