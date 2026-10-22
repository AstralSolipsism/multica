package daemon

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// buildStepStateAsync runs BuildStepThinkingState with a timeout, so a
// non-terminating fit loop fails the test instead of hanging the daemon.
func buildStepStateAsync(t *testing.T, input StepThinkingInput) string {
	t.Helper()
	done := make(chan string, 1)
	go func() { done <- BuildStepThinkingState(input) }()
	select {
	case state := <-done:
		return state
	case <-time.After(5 * time.Second):
		t.Fatal("BuildStepThinkingState did not terminate within 5s")
		return ""
	}
}

func decodeStepState(t *testing.T, state string) map[string]any {
	t.Helper()
	var fields map[string]any
	if err := json.Unmarshal([]byte(state), &fields); err != nil {
		t.Fatalf("invalid state: %v", err)
	}
	return fields
}

// TestStepStateBudgetCoversResultSizes locks OL-1083's step-state budget:
// whatever the tool result's size, the state stays within 4096 bytes, the
// short fields and assistant/goal ship complete (at their field caps), and
// an oversized result keeps its head and tail (errors sit at the end).
func TestStepStateBudgetCoversResultSizes(t *testing.T) {
	t.Parallel()
	mk := func(size int) string {
		var b strings.Builder
		for b.Len() < size {
			b.WriteString("progress line with some padding done\n")
		}
		return "HEAD_CANARY\n" + b.String()[:size] + "\nExit code 1\nFAIL: TAIL_CANARY assertion failed"
	}
	goal := strings.Repeat("目", 400)
	assistant := strings.Repeat("助", 400)
	for _, size := range []int{1024, 3 * 1024, 50 * 1024} {
		state := buildStepStateAsync(t, StepThinkingInput{
			Step: 4, Goal: goal, AssistantText: assistant,
			ToolName: "Bash", ToolInputSummary: "go test ./...", ToolIsError: true, ExitCode: 1,
			ErrorFeatures: "FAIL_ feature", RepeatedErrors: 2, ToolResult: mk(size),
		})
		if len(state) > 4096 {
			t.Fatalf("size %d: state %d bytes exceeds budget", size, len(state))
		}
		if !utf8.ValidString(state) || !json.Valid([]byte(state)) {
			t.Fatalf("size %d: invalid state", size)
		}
		fields := decodeStepState(t, state)
		for key, want := range map[string]any{
			"step": float64(4), "tool": "Bash", "is_error": true, "exit_code": float64(1),
			"error_features": "FAIL_ feature", "repeated_errors": float64(2),
			"tool_input_summary": "go test ./...",
		} {
			if fields[key] != want {
				t.Fatalf("size %d: %s = %v, want %v", size, key, fields[key], want)
			}
		}
		// Acceptance #4: assistant and goal complete, never squeezed out.
		if got, _ := fields["assistant"].(string); got != assistant {
			t.Fatalf("size %d: assistant truncated to %d runes", size, len([]rune(got)))
		}
		if got, _ := fields["goal"].(string); got != goal {
			t.Fatalf("size %d: goal truncated to %d runes", size, len([]rune(got)))
		}
		result, _ := fields["result"].(string)
		if !strings.Contains(result, "HEAD_CANARY") || !strings.Contains(result, "TAIL_CANARY") {
			t.Fatalf("size %d: result lost head or tail: %.200s", size, result)
		}
		// The tail (after the elision marker) keeps its full allocation:
		// min(1000, budget-200) bytes of result body. With 400-rune Chinese
		// goal and assistant the budget is ~1400 escaped bytes, so the tail
		// is ~1000 within rune-boundary rounding.
		if i := strings.LastIndex(result, "\n[... "); i >= 0 {
			markerEnd := strings.Index(result[i:], "]\n") + i + 2
			tail := len(result) - markerEnd
			if tail < 900 {
				t.Fatalf("size %d: tail only %d bytes, want ~1000: %.120s", size, tail, result[markerEnd:])
			}
		}
	}
}

// TestStepStateBudgetKeepsChineseGoal locks the reviewer's scenario: a
// realistic Chinese goal (issue title+description near the 500-char cap)
// plus a 50 KB tool result still ships the goal complete — Chinese escapes
// to 3 bytes per rune in JSON, the worst case for the budget.
func TestStepStateBudgetKeepsChineseGoal(t *testing.T) {
	t.Parallel()
	goal := "修复任务调度器偶发卡住的问题\n" + strings.Repeat("高并发下任务偶发被领取两次，需要分析共享状态和锁顺序。", 24) // ~491 chars
	var body strings.Builder
	for body.Len() < 50*1024 {
		body.WriteString("func (s *Scheduler) dispatch(worker int) {\n\ts.mu.Lock()\n\tdefer s.mu.Unlock()\n}\n")
	}
	state := buildStepStateAsync(t, StepThinkingInput{
		Step: 3, Goal: goal, AssistantText: "已读入 scheduler.go，下一步分析锁顺序。",
		ToolName: "Read", ToolInputSummary: "scheduler.go",
		ToolResult: body.String(),
	})
	if len(state) > 4096 {
		t.Fatalf("state %d bytes exceeds budget", len(state))
	}
	fields := decodeStepState(t, state)
	if got, _ := fields["goal"].(string); got != thinkingPrefix(goal, 500) {
		t.Fatalf("goal truncated: %d of %d runes", len([]rune(got)), len([]rune(goal)))
	}
	result, _ := fields["result"].(string)
	if !strings.Contains(result, "dispatch") || !strings.Contains(result, "bytes elided") {
		t.Fatalf("result lost its head or marker: %.200s", result)
	}
}

// TestStepStateTerminatesOnReviewerInputs is the regression for the
// review-round-2 infinite loop: each of these inputs used to hang the
// shrink loop because the fixed fields alone neared the 4096-byte budget
// and the excerpt could not shrink further. All must return promptly, and
// whenever at least 200 bytes remain beyond the fixed fields, goal and
// assistant stay complete.
func TestStepStateTerminatesOnReviewerInputs(t *testing.T) {
	t.Parallel()
	cjk := func(n int) string { return strings.Repeat("词", n) }
	var escapeDense strings.Builder
	for escapeDense.Len() < 2048 {
		escapeDense.WriteString("ch := <-s.done && s.cond.Wait()\n\tif err != nil {\n\t\tgo f(&&wg)\n\t}\n")
	}
	cases := []struct {
		name      string
		goal      string
		assistant string
		summary   string
		features  string
		result    string
	}{
		{"goal500 assistant500 cmd100", cjk(500), cjk(500), cjk(100), "", strings.Repeat("x", 2048)},
		{"goal500 assistant400 cmd200", cjk(500), cjk(400), cjk(200), "", strings.Repeat("x", 2048)},
		{"goal500 assistant300 cmd300", cjk(500), cjk(300), cjk(300), "", strings.Repeat("x", 2048)},
		{"goal500 assistant500 features100", cjk(500), cjk(500), "go test ./...", cjk(100), strings.Repeat("x", 2048)},
		{"goal500 assistant500 cmd300 short result", cjk(500), cjk(500), cjk(300), "", strings.Repeat("y", 200)},
		{"escape-dense result", cjk(500), cjk(450), "go test -race ./...", "", escapeDense.String()},
		{"escape-dense result wide", "fix the scheduler deadlock", "Read the scheduler; analyze lock ordering next.", cjk(300), "", escapeDense.String() + escapeDense.String()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state := buildStepStateAsync(t, StepThinkingInput{
				Step: 2, Goal: tc.goal, AssistantText: tc.assistant,
				ToolName: "Bash", ToolInputSummary: tc.summary, ToolIsError: tc.features != "",
				ErrorFeatures: tc.features, ToolResult: tc.result,
			})
			if len(state) > 4096 {
				t.Fatalf("state %d bytes exceeds budget", len(state))
			}
			if !utf8.ValidString(state) || !json.Valid([]byte(state)) {
				t.Fatal("invalid state")
			}
			fields := decodeStepState(t, state)
			// assistant is always complete in these inputs: the fixed
			// fields never exceed the budget on their own here.
			if got, _ := fields["assistant"].(string); got != thinkingPrefix(tc.assistant, 500) {
				t.Fatalf("assistant truncated: %d of %d runes", len([]rune(got)), len([]rune(tc.assistant)))
			}
		})
	}
}

// TestStepStatePathologicalFixedOverflow pins the extreme case: the fixed
// fields alone (Chinese goal, assistant and summary all at their caps plus
// features) exceed 4096 even with an empty result. The result ships empty,
// boundedThinkingState trims from the goal backwards, and assistant stays
// complete. The call must still terminate.
func TestStepStatePathologicalFixedOverflow(t *testing.T) {
	t.Parallel()
	cjk := func(n int) string { return strings.Repeat("字", n) }
	state := buildStepStateAsync(t, StepThinkingInput{
		Step: 2, Goal: cjk(500), AssistantText: cjk(500),
		ToolName: "Bash", ToolInputSummary: cjk(300), ToolIsError: true,
		ErrorFeatures: cjk(200), RepeatedErrors: 3, ToolResult: strings.Repeat("z", 4096),
	})
	if len(state) > 4096 {
		t.Fatalf("state %d bytes exceeds budget", len(state))
	}
	if !utf8.ValidString(state) || !json.Valid([]byte(state)) {
		t.Fatal("invalid state")
	}
	fields := decodeStepState(t, state)
	if got, _ := fields["assistant"].(string); got != cjk(500) {
		t.Fatalf("assistant truncated in the pathological case: %d runes", len([]rune(got)))
	}
	if result, _ := fields["result"].(string); result != "" {
		t.Fatalf("result should be empty when fixed fields overflow, got %d bytes", len(result))
	}
	if features, _ := fields["error_features"].(string); features == "" {
		t.Fatal("error_features lost exactly when the result is empty")
	}
}
