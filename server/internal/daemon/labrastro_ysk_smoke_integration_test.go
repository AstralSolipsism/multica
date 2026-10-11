//go:build agentintegration

package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/daemon/ysk"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// TestYouShouldKnowRealClaudeSmoke runs the tips mod end to end: the daemon's
// installer, the real Claude Code CLI with the daemon's launch flags, and the
// stream hook. It needs an authenticated Claude Code >= 2.1.287 and spends a
// little quota. MULTICA_YSK_SMOKE_MODEL and MULTICA_YSK_SMOKE_EFFORT pick the
// model and effort (the CLI's defaults otherwise).
func TestYouShouldKnowRealClaudeSmoke(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("set MULTICA_RUN_REAL_AGENT_SMOKE=1 to allow real agent CLI and account access")
	}
	t.Log("REAL AGENT SMOKE TEST: this test may access an authenticated account and consume quota")
	claudePath, err := exec.LookPath("claude")
	if err != nil {
		t.Skip("claude is not installed")
	}
	versionOut, err := exec.Command(claudePath, "--version").Output()
	if err != nil {
		t.Fatalf("claude --version: %v", err)
	}
	version := strings.TrimSpace(string(versionOut))
	if !agent.SupportsClaudeYouShouldKnow(version) {
		t.Skipf("claude %s predates the tips mod", version)
	}

	root := t.TempDir()
	workDir := filepath.Join(root, "workdir")
	configRoot := filepath.Join(root, "multica-config")
	for _, dir := range []string{workDir, configRoot} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"issue.md": "# OL-4242 登录改用短信验证码\n\n" +
			"背景：现在用户用密码登录，客服每周要处理大约 200 起忘记密码的工单。\n\n" +
			"要求：\n1. 登录页改为手机号加短信验证码；\n2. 验证码 5 分钟内有效，同一个手机号 60 秒内只能发一次；\n3. 老的密码登录先保留一个月，之后下线。\n\n" +
			"注意：短信供应商按条收费，每条 0.05 元。\n",
		"auth.py": "def login_with_password(user, password):\n    return user.check_password(password)\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(workDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runContext := `{"version":1,"issue_identifier":"OL-4242","anchor_comment_id":null,` +
		`"latest_human_comment":"请先把短信登录做出来，密码登录先别删。",` +
		`"existing_tips":[{"id":"11111111-1111-4111-8111-111111111111","tag":"you_should_know","line":"登录方式暂时不变，仍然只用密码"}],` +
		`"known_topics":["短信验证码是什么"],"light_tip_count":3,"check_every_steps":2,` +
		`"limits":{"line":40,"title":12,"explanation":200}}`
	vars, err := ysk.Install(configRoot, json.RawMessage(runContext), "")
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	env := map[string]string{"IS_SANDBOX": "1", "MULTICA_AGENT_NAME": "工程师"}
	for key, value := range vars {
		env[key] = value
	}

	backend, err := agent.New("claude", agent.Config{ExecutablePath: claudePath, Env: env, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var batches []json.RawMessage
	prompt := "You are working on issue OL-4242, described in issue.md in the current directory. Do these steps in order, one tool call per step:\n" +
		"1. Read issue.md with the Read tool.\n" +
		"2. Read auth.py with the Read tool.\n" +
		"3. Add a function send_sms_code(phone) to auth.py that enforces the 60-second limit with an in-memory dict and returns True when a code may be sent. Leave login_with_password as it is.\n" +
		"4. Run `python3 -c 'import auth; print(auth.send_sms_code(\"13800000000\"), auth.send_sms_code(\"13800000000\"))'` with Bash.\n" +
		"5. Run `printenv MULTICA_YSK_CONTEXT_FILE CLAUDE_CODE_PLUGIN_DIRS; echo exit=$?` with Bash.\n" +
		"6. Run `sleep 40 && echo waited` with Bash.\n" +
		"7. Reply with a two-sentence summary."
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	session, err := backend.Execute(ctx, prompt, agent.ExecOptions{
		Cwd:           workDir,
		Model:         os.Getenv("MULTICA_YSK_SMOKE_MODEL"),
		ThinkingLevel: os.Getenv("MULTICA_YSK_SMOKE_EFFORT"),
		Timeout:       14 * time.Minute,
		McpConfig:     json.RawMessage(`{"mcpServers":{}}`),
		OnYouShouldKnow: func(batch json.RawMessage) {
			mu.Lock()
			defer mu.Unlock()
			batches = append(batches, append(json.RawMessage(nil), batch...))
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var transcript strings.Builder
	for msg := range session.Messages {
		transcript.WriteString(msg.Content)
		transcript.WriteString(msg.Output)
		transcript.WriteString("\n")
	}
	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("run %s: %s", result.Status, result.Error)
	}
	if strings.Contains(transcript.String(), "ysk/context.json") || strings.Contains(transcript.String(), "ysk/plugin") {
		t.Errorf("the agent's shell still saw the mod's variables:\n%s", transcript.String())
	}

	mu.Lock()
	got := append([]json.RawMessage(nil), batches...)
	mu.Unlock()
	type tip struct {
		Tag, Line, Title, Explanation string
	}
	var lines []string
	lightBatches := 0
	for _, raw := range got {
		t.Logf("batch: %s", raw)
		var batch struct {
			YSK        int    `json:"ysk"`
			Kind       string `json:"kind"`
			Step       int    `json:"step"`
			Tips       []tip  `json:"tips"`
			Overturned []struct {
				TipID  string `json:"tip_id"`
				Reason string `json:"reason"`
			} `json:"overturned"`
		}
		if err := json.Unmarshal(raw, &batch); err != nil || batch.YSK != 1 {
			t.Fatalf("batch %s does not follow contract D: %v", raw, err)
		}
		if batch.Kind == "light" {
			lightBatches++
		}
		for _, tip := range batch.Tips {
			wantTag := map[string]string{"light": "you_should_know", "heads_up": "heads_up"}[batch.Kind]
			if tip.Tag != wantTag || utf8.RuneCountInString(tip.Line) > 40 || utf8.RuneCountInString(tip.Title) > 12 || utf8.RuneCountInString(tip.Explanation) > 200 {
				t.Errorf("tip outside contract D: %+v in %s batch", tip, batch.Kind)
			}
			lines = append(lines, tip.Line)
		}
	}
	if lightBatches != 1 {
		t.Fatalf("got %d light batches, want 1", lightBatches)
	}

	// Nothing the mod produced may reach the agent's own record.
	for _, line := range lines {
		if strings.Contains(transcript.String(), line) {
			t.Errorf("tip %q reached the task messages", line)
		}
	}
	home, _ := os.UserHomeDir()
	matches, _ := filepath.Glob(filepath.Join(home, ".claude", "projects", "*", result.SessionID+".jsonl"))
	if len(matches) != 1 {
		t.Fatalf("session transcript for %s: %v", result.SessionID, matches)
	}
	record, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range append([]string{"Side request from Labrastro"}, lines...) {
		if strings.Contains(string(record), needle) {
			t.Errorf("session transcript %s contains %q", matches[0], needle)
		}
	}
}
