package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSupportsClaudeYouShouldKnow(t *testing.T) {
	t.Parallel()
	for version, want := range map[string]bool{
		"2.1.287":               true,
		"2.1.287 (Claude Code)": true,
		"v2.1.292":              true,
		"2.2.0":                 true,
		"3.0.0":                 true,
		"2.1.286":               false,
		"2.1.267 (Claude Code)": false,
		"1.9.999":               false,
		"":                      false,
		"unknown":               false,
	} {
		if got := SupportsClaudeYouShouldKnow(version); got != want {
			t.Errorf("SupportsClaudeYouShouldKnow(%q) = %v, want %v", version, got, want)
		}
	}
}

func TestYouShouldKnowBatchChecksTheEnvelopeOnly(t *testing.T) {
	t.Parallel()
	for _, text := range []string{
		`{"ysk":1,"kind":"light","tips":[],"overturned":[{"tip_id":"t","reason":"r"}],"step":2}`,
		`{"ysk":1,"kind":"heads_up","tips":[{"tag":"heads_up","line":"l","title":"t","explanation":"e"}],"overturned":[],"step":8}`,
	} {
		batch, err := youShouldKnowBatch(text)
		if err != nil {
			t.Fatalf("youShouldKnowBatch(%s): %v", text, err)
		}
		if string(batch) != text {
			t.Fatalf("batch changed: got %s, want %s", batch, text)
		}
	}
	for _, text := range []string{
		``,
		`not json`,
		`["ysk",1]`,
		`null`,
		`{"ysk":2,"kind":"light"}`,
		`{"kind":"light"}`,
		`{"ysk":1,"kind":"later"}`,
		`{"ysk":1,"kind":"light","pad":"` + strings.Repeat("x", youShouldKnowMaxBatchBytes) + `"}`,
	} {
		if _, err := youShouldKnowBatch(text); err == nil {
			t.Errorf("youShouldKnowBatch(%.40q) accepted a malformed batch", text)
		}
	}
}

// TestClaudeExecuteRoutesYouShouldKnowLogs drives the real stream reader: the
// mod's ui_log lines reach OnYouShouldKnow and never the task's messages,
// while other plugins' ui_log lines keep their existing treatment.
func TestClaudeExecuteRoutesYouShouldKnowLogs(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}

	const batch = `{"ysk":1,"kind":"light","tips":[{"tag":"you_should_know","line":"The agent adds SMS login","title":"SMS","explanation":"Users sign in with a code."}],"overturned":[],"step":2}`
	uiLog := func(plugin, text string) string {
		line, err := json.Marshal(map[string]string{"type": "system", "subtype": "ui_log", "plugin": plugin, "text": text, "session_id": "sess-ysk"})
		if err != nil {
			t.Fatal(err)
		}
		return string(line)
	}
	lines := []string{
		`{"type":"system","subtype":"init","session_id":"sess-ysk"}`,
		uiLog("labrastro-ysk", batch),
		uiLog("labrastro-ysk", `{"ysk":9}`),
		uiLog("labrastro-ysk", "not json"),
		uiLog("someone-else", "a line from another plugin"),
		`{"type":"assistant","message":{"id":"msg-1","role":"assistant","content":[{"type":"text","text":"done"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"session_id":"sess-ysk","result":"done"}`,
	}
	script := "#!/bin/sh\nIFS= read -r _\n"
	for _, line := range lines {
		script += "printf '%s\\n' '" + strings.ReplaceAll(line, "'", `'\''`) + "'\n"
	}

	for _, withCallback := range []bool{true, false} {
		fakePath := filepath.Join(t.TempDir(), "claude")
		writeTestExecutable(t, fakePath, []byte(script))
		backend, err := New("claude", Config{ExecutablePath: fakePath, Env: map[string]string{"IS_SANDBOX": "1"}, Logger: slog.Default()})
		if err != nil {
			t.Fatalf("new claude backend: %v", err)
		}

		var mu sync.Mutex
		var batches []string
		opts := ExecOptions{Timeout: 5 * time.Second}
		if withCallback {
			opts.OnYouShouldKnow = func(b json.RawMessage) {
				mu.Lock()
				defer mu.Unlock()
				batches = append(batches, string(b))
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		session, err := backend.Execute(ctx, "prompt", opts)
		if err != nil {
			cancel()
			t.Fatalf("execute: %v", err)
		}
		var messages []Message
		for msg := range session.Messages {
			messages = append(messages, msg)
		}
		result := <-session.Result
		cancel()

		if result.Status != "completed" || result.SessionID != "sess-ysk" {
			t.Fatalf("result = %+v, want a completed run of sess-ysk", result)
		}
		statuses := 0
		for _, msg := range messages {
			if msg.Type == MessageStatus {
				statuses++
			}
			for _, field := range []string{msg.Content, msg.Output} {
				if strings.Contains(field, "SMS") || strings.Contains(field, "ysk") {
					t.Fatalf("a tips line reached the task messages: %+v", msg)
				}
			}
		}
		// init and the other plugin's ui_log; none for the three mod lines.
		if statuses != 2 {
			t.Fatalf("got %d status messages, want 2: %+v", statuses, messages)
		}
		mu.Lock()
		got := batches
		mu.Unlock()
		if withCallback && (len(got) != 1 || got[0] != batch) {
			t.Fatalf("OnYouShouldKnow got %q, want exactly the well-formed batch", got)
		}
		if !withCallback && len(got) != 0 {
			t.Fatalf("batches recorded without a callback: %q", got)
		}
	}
}
