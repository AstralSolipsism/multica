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

func TestParseEffortEffectChecksEnvelope(t *testing.T) {
	t.Parallel()
	good := EffortEffect{Step: 2, Level: "high", Source: "x"}
	raw, err := json.Marshal(map[string]any{"effort": 1, "step": 2, "level": "high", "source": "x"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseEffortEffect(string(raw))
	if err != nil || got.Step != good.Step || got.Level != good.Level || got.Source != good.Source {
		t.Fatalf("parseEffortEffect(%s) = %+v, %v; want %+v", raw, got, err, good)
	}
	for _, bad := range []string{
		``,
		`not json`,
		`{"effort":2,"step":1,"level":"low"}`,
		`{"effort":1,"step":0,"level":"low"}`,
		`{"effort":1,"level":"low"}`,
		`{"effort":1,"step":1,"level":"low","pad":"` + strings.Repeat("x", effortEffectMaxBytes) + `"}`,
	} {
		if _, err := parseEffortEffect(bad); err == nil {
			t.Errorf("parseEffortEffect(%.40q) accepted a malformed record", bad)
		}
	}
}

// TestClaudeExecuteRoutesEffortLogs drives the real stream reader: the mod's
// ui_log effect records reach OnEffortEffect and never the task's messages,
// and system frames report the per-turn effort state.
func TestClaudeExecuteRoutesEffortLogs(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}

	uiLog := func(plugin, text string) string {
		line, err := json.Marshal(map[string]string{"type": "system", "subtype": "ui_log", "plugin": plugin, "text": text, "session_id": "sess-effort"})
		if err != nil {
			t.Fatal(err)
		}
		return string(line)
	}
	const record2 = `{"effort":1,"step":2,"level":"high","confidence":0.8,"probabilities":{"high":0.8},"latency_ms":3,"source":"zen"}`
	const record3 = `{"effort":1,"step":3,"level":"high","fallback":"timeout"}`
	lines := []string{
		`{"type":"system","subtype":"init","session_id":"sess-effort","per_turn_effort_active":true}`,
		uiLog("labrastro-effort", record2),
		`{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"m","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"step one"}]}}`,
		`{"type":"assistant","message":{"id":"msg_2","role":"assistant","model":"m","content":[{"type":"text","text":"step two first"}]}}`,
		`{"type":"assistant","message":{"id":"msg_2","role":"assistant","model":"m","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}`,
		uiLog("labrastro-effort", record3),
		`{"type":"assistant","message":{"id":"msg_3","role":"assistant","model":"m","content":[{"type":"text","text":"step three"}]}}`,
		`{"type":"system","subtype":"per_turn_effort_changed","per_turn_effort_active":false,"session_id":"sess-effort"}`,
		uiLog("someone-else", "another plugin's line"),
		`{"type":"result","subtype":"success","is_error":false,"session_id":"sess-effort","result":"done"}`,
	}
	script := "#!/bin/sh\nIFS= read -r _\n"
	for _, line := range lines {
		script += "printf '%s\\n' '" + strings.ReplaceAll(line, "'", `'\''`) + "'\n"
	}

	fakePath := filepath.Join(t.TempDir(), "claude")
	writeTestExecutable(t, fakePath, []byte(script))
	backend, err := New("claude", Config{ExecutablePath: fakePath, Env: map[string]string{"IS_SANDBOX": "1"}, Logger: slog.Default()})
	if err != nil {
		t.Fatalf("new claude backend: %v", err)
	}

	var mu sync.Mutex
	var effects []EffortEffect
	var perTurn []bool
	opts := ExecOptions{
		Timeout: 5 * time.Second,
		OnEffortEffect: func(effect EffortEffect) {
			mu.Lock()
			defer mu.Unlock()
			effects = append(effects, effect)
		},
		OnPerTurnEffort: func(active bool) {
			mu.Lock()
			defer mu.Unlock()
			perTurn = append(perTurn, active)
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := backend.Execute(ctx, "prompt", opts)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	var messages []Message
	for msg := range session.Messages {
		messages = append(messages, msg)
	}
	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(effects) != 2 {
		t.Fatalf("effects = %+v, want 2", effects)
	}
	if effects[0].Level != "high" || effects[0].Step != 2 || effects[0].Source != "zen" {
		t.Fatalf("first effect: %+v", effects[0])
	}
	if effects[1].Fallback != "timeout" || effects[1].Level != "high" {
		t.Fatalf("second effect: %+v", effects[1])
	}
	// init reports true; per_turn_effort_changed reports false.
	if len(perTurn) != 2 || !perTurn[0] || perTurn[1] {
		t.Fatalf("per-turn reports = %v, want [true false]", perTurn)
	}
	// The mod's lines never become task messages; the other plugin's ui_log
	// keeps its existing treatment (a status message, not dropped here).
	for _, msg := range messages {
		for _, field := range []string{msg.Content, msg.Output} {
			if strings.Contains(field, "effort\":1") || strings.Contains(field, "zen") {
				t.Fatalf("an effect record reached the task messages: %+v", msg)
			}
		}
	}
}

// TestClaudeExecuteEffortAndYouShouldKnowCoexist interleaves both mods'
// ui_log lines in one stream: each reaches its own callback and neither
// reaches the task's messages.
func TestClaudeExecuteEffortAndYouShouldKnowCoexist(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}

	uiLog := func(plugin, text string) string {
		line, err := json.Marshal(map[string]string{"type": "system", "subtype": "ui_log", "plugin": plugin, "text": text, "session_id": "sess-two"})
		if err != nil {
			t.Fatal(err)
		}
		return string(line)
	}
	const batch = `{"ysk":1,"kind":"light","tips":[{"tag":"you_should_know","line":"A tip","title":"T","explanation":"E"}],"overturned":[],"step":2}`
	const record = `{"effort":1,"step":2,"level":"high"}`
	lines := []string{
		`{"type":"system","subtype":"init","session_id":"sess-two","per_turn_effort_active":true}`,
		uiLog("labrastro-ysk", batch),
		uiLog("labrastro-effort", record),
		`{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"m","content":[{"type":"text","text":"work"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"session_id":"sess-two","result":"done"}`,
	}
	script := "#!/bin/sh\nIFS= read -r _\n"
	for _, line := range lines {
		script += "printf '%s\\n' '" + strings.ReplaceAll(line, "'", `'\''`) + "'\n"
	}

	fakePath := filepath.Join(t.TempDir(), "claude")
	writeTestExecutable(t, fakePath, []byte(script))
	backend, err := New("claude", Config{ExecutablePath: fakePath, Env: map[string]string{"IS_SANDBOX": "1"}, Logger: slog.Default()})
	if err != nil {
		t.Fatalf("new claude backend: %v", err)
	}
	var mu sync.Mutex
	var batches []json.RawMessage
	var effects []EffortEffect
	opts := ExecOptions{
		Timeout: 5 * time.Second,
		OnYouShouldKnow: func(batch json.RawMessage) {
			mu.Lock()
			defer mu.Unlock()
			batches = append(batches, batch)
		},
		OnEffortEffect: func(effect EffortEffect) {
			mu.Lock()
			defer mu.Unlock()
			effects = append(effects, effect)
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := backend.Execute(ctx, "prompt", opts)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	for msg := range session.Messages {
		for _, field := range []string{msg.Content, msg.Output} {
			if strings.Contains(field, "ysk\":1") || strings.Contains(field, "effort\":1") {
				t.Fatalf("a mod line reached the task messages: %+v", msg)
			}
		}
	}
	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(batches) != 1 || len(effects) != 1 {
		t.Fatalf("batches=%d effects=%d, want 1 and 1", len(batches), len(effects))
	}
	if effects[0].Level != "high" {
		t.Fatalf("effect: %+v", effects[0])
	}
}
