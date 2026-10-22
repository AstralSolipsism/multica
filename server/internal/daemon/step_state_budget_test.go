package daemon

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

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
		state := BuildStepThinkingState(StepThinkingInput{
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
		var fields map[string]any
		if err := json.Unmarshal([]byte(state), &fields); err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
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
		if size+60 > 2500 && !strings.Contains(result, "bytes elided") {
			t.Fatalf("size %d: result missing the elision marker", size)
		}
		if size+60 <= 2500 && strings.Contains(result, "bytes elided") {
			t.Fatalf("size %d: small result should ship whole", size)
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
	state := BuildStepThinkingState(StepThinkingInput{
		Step: 3, Goal: goal, AssistantText: "已读入 scheduler.go，下一步分析锁顺序。",
		ToolName: "Read", ToolInputSummary: "scheduler.go",
		ToolResult: body.String(),
	})
	if len(state) > 4096 {
		t.Fatalf("state %d bytes exceeds budget", len(state))
	}
	var fields map[string]any
	if err := json.Unmarshal([]byte(state), &fields); err != nil {
		t.Fatal(err)
	}
	if got, _ := fields["goal"].(string); got != thinkingPrefix(goal, 500) {
		t.Fatalf("goal truncated: %d of %d runes", len([]rune(got)), len([]rune(goal)))
	}
	result, _ := fields["result"].(string)
	if !strings.Contains(result, "dispatch") || !strings.Contains(result, "bytes elided") {
		t.Fatalf("result lost its head or marker: %.200s", result)
	}
}
