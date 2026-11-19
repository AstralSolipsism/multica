package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAntigravityRecordedWakeups(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, status, output string
		exit, tools          int
		usage                TokenUsage
	}{
		{"native", "completed", "OL1462_FINAL\n", 0, 1, TokenUsage{InputTokens: 13597, OutputTokens: 99, CacheReadTokens: 14162}},
		{"schedule", "completed", "OL1462_FINAL\n", 0, 2, TokenUsage{InputTokens: 15901, OutputTokens: 168, CacheReadTokens: 21682}},
		{"timeout", "failed", "OL1462_WAITING\n", 3, 1, TokenUsage{InputTokens: 11551, OutputTokens: 510, CacheReadTokens: 6907}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			data, err := os.ReadFile(filepath.Join("testdata", "antigravity-wakeup", tc.name+".jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			result, messages := runAntigravityWakeupFixture(t, string(data), tc.exit)
			if result.Status != tc.status || result.Output != tc.output {
				t.Fatalf("result = %+v, want %s / %q", result, tc.status, tc.output)
			}
			if len(result.Usage) != 1 {
				t.Fatalf("usage = %+v, want one model", result.Usage)
			}
			for _, usage := range result.Usage {
				if usage != tc.usage {
					t.Fatalf("usage = %+v, want %+v", usage, tc.usage)
				}
			}
			var transcript strings.Builder
			active := map[string]bool{}
			uses := 0
			for _, msg := range messages {
				switch msg.Type {
				case MessageText:
					transcript.WriteString(msg.Content)
				case MessageToolUse:
					if active[msg.CallID] {
						t.Fatalf("duplicate tool use: %+v", msg)
					}
					active[msg.CallID] = true
					uses++
				case MessageToolResult:
					if !active[msg.CallID] {
						t.Fatalf("unpaired tool result: %+v", msg)
					}
					delete(active, msg.CallID)
				}
			}
			if uses != tc.tools || len(active) != 0 {
				t.Fatalf("tool uses = %d, outstanding = %v", uses, active)
			}
			wantTranscript := "OL1462_WAITING\n"
			if tc.exit == 0 {
				wantTranscript += "OL1462_FINAL\n"
			} else if !strings.Contains(result.Error, "print timeout") {
				t.Fatalf("timeout diagnostic lost: %+v", result)
			}
			if transcript.String() != wantTranscript {
				t.Fatalf("live transcript = %q, want %q", transcript.String(), wantTranscript)
			}
		})
	}
}

func TestAntigravityWakeupOutputBoundaries(t *testing.T) {
	t.Parallel()
	step := func(index int, kind, state, text string) string {
		return fmt.Sprintf("{\"event\":\"step_update\",\"step_update\":{\"step_index\":%d,\"step_type\":%q,\"state\":%q,\"text_delta\":%q}}\n", index, kind, state, text)
	}
	start := step(0, "user_input", "DONE", "")
	waiting := step(1, "agent_response", "DONE", "Waiting.\n")
	wake := step(2, "system_message", "DONE", "")
	answer := step(3, "agent_response", "ACTIVE", "Final.") + step(3, "agent_response", "DONE", "\n")
	const canonical = "Waiting.\nFinal.\n"
	for _, tc := range []struct {
		name, steps, response, want, status, wantStatus string
		exit                                            int
	}{
		{name: "no wakeup preserves canonical", steps: start + waiting + answer, response: canonical, want: canonical},
		{name: "single wakeup", steps: start + waiting + wake + answer, response: canonical, want: "Final.\n"},
		{name: "multiple wakeups", steps: start + waiting + wake + step(3, "agent_response", "DONE", "Waiting again.\n") + step(4, "system_message", "DONE", "") + step(5, "agent_response", "DONE", "Final.\n"), response: "Waiting.\nWaiting again.\nFinal.\n", want: "Final.\n"},
		{name: "whole answered segment with tools", steps: start + waiting + wake + step(3, "agent_response", "DONE", "Inspecting.\n") + step(4, "tool", "DONE", "") + step(5, "agent_response", "DONE", "Checking.\n") + step(6, "tool", "DONE", "") + step(7, "agent_response", "DONE", "Final.\n"), response: "Waiting.\nInspecting.\nChecking.\nFinal.\n", want: "Inspecting.\nChecking.\nFinal.\n"},
		{name: "trailing empty wakeup keeps last answered segment", steps: start + waiting + wake + answer + step(4, "system_message", "DONE", ""), response: canonical, want: "Final.\n"},
		{name: "only trailing wakeup falls back", steps: start + waiting + answer + step(4, "system_message", "DONE", ""), response: canonical, want: canonical},
		{name: "repeated earlier wakeup snapshot", steps: start + waiting + wake + answer + wake, response: canonical, want: "Final.\n"},
		{name: "history before current user boundary", steps: step(1, "agent_response", "DONE", "Old answer.\n") + step(10, "user_input", "DONE", "") + step(11, "agent_response", "DONE", "Waiting.\n") + step(12, "system_message", "DONE", "") + step(13, "agent_response", "DONE", "Final.\n"), response: canonical, want: "Final.\n"},
		{name: "canonical differs from deltas", steps: start + waiting + wake + answer, response: "Canonical answer from agy.", want: "Canonical answer from agy."},
		{name: "missing final deltas", steps: start + waiting + wake + step(3, "agent_response", "DONE", ""), response: canonical, want: canonical},
		{name: "missing earlier deltas", steps: start + wake + answer, response: canonical, want: canonical},
		{name: "active response falls back", steps: start + waiting + wake + step(3, "agent_response", "ACTIVE", "Final.\n"), response: canonical, want: canonical},
		{name: "empty response falls back", steps: start + waiting + wake + step(3, "agent_response", "DONE", " \n"), response: "Waiting.\n \n", want: "Waiting.\n \n"},
		{name: "trailing tool falls back", steps: start + waiting + wake + answer + step(4, "tool", "DONE", ""), response: canonical, want: canonical},
		{name: "no user boundary falls back", steps: waiting + wake + answer, response: canonical, want: canonical},
		{name: "invalid second user boundary falls back", steps: start + waiting + wake + answer + step(4, "user_input", "DONE", ""), response: canonical, want: canonical},
		{name: "recovered error preserves canonical", steps: start + waiting + wake + answer, response: canonical, want: canonical, status: "ERROR", wantStatus: "completed"},
		{name: "failed error preserves canonical", steps: start + waiting + wake + answer, response: canonical, want: canonical, status: "ERROR", wantStatus: "failed", exit: 3},
		{name: "cancelled preserves canonical", steps: start + waiting + wake + answer, response: canonical, want: canonical, status: "CANCELLED", wantStatus: "cancelled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if tc.status == "" {
				tc.status = "SUCCESS"
			}
			if tc.wantStatus == "" {
				tc.wantStatus = "completed"
			}
			stream := tc.steps + fmt.Sprintf("{\"event\":\"result\",\"result\":{\"status\":%q,\"response\":%q,\"error\":\"provider diagnostic\"}}\n", tc.status, tc.response)
			result, _ := runAntigravityWakeupFixture(t, stream, tc.exit)
			if result.Output != tc.want || result.Status != tc.wantStatus {
				t.Fatalf("result = %+v, want %s / %q", result, tc.wantStatus, tc.want)
			}
		})
	}
}

func runAntigravityWakeupFixture(t *testing.T, stream string, exit int) (Result, []Message) {
	t.Helper()
	fakePath := filepath.Join(t.TempDir(), "agy")
	writeTestExecutable(t, fakePath, []byte("#!/bin/sh\ncat <<'JSONL'\n"+stream+fmt.Sprintf("JSONL\nexit %d\n", exit)))
	backend, err := New("antigravity", Config{ExecutablePath: fakePath, Logger: quietAntigravityLogger()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session, err := backend.Execute(ctx, "fixture prompt", ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var messages []Message
	for msg := range session.Messages {
		messages = append(messages, msg)
	}
	return <-session.Result, messages
}
