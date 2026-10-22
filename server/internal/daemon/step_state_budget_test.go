package daemon

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestStepStateBudgetCoversResultSizes locks OL-1083's step-state budget:
// whatever the tool result's size, the state stays within 4096 bytes with
// step/tool/error features/repeats/input summary/assistant complete, and an
// oversized result keeps its head and tail (errors sit at the end).
func TestStepStateBudgetCoversResultSizes(t *testing.T) {
	t.Parallel()
	mk := func(size int) string {
		var b strings.Builder
		for b.Len() < size {
			b.WriteString("progress line with some padding done\n")
		}
		return "HEAD_CANARY\n" + b.String()[:size] + "\nExit code 1\nFAIL: TAIL_CANARY assertion failed"
	}
	for _, size := range []int{1024, 3 * 1024, 50 * 1024} {
		state := BuildStepThinkingState(StepThinkingInput{
			Step: 4, Goal: strings.Repeat("目", 400), AssistantText: strings.Repeat("助", 400),
			ToolName: "Bash", ToolInputSummary: "go test ./...", ToolIsError: true, ExitCode: 1,
			ErrorFeatures: "FAIL_ feature", RepeatedErrors: 2, ToolResult: mk(size),
		})
		if len(state) > 4096 {
			t.Fatalf("size %d: state %d bytes exceeds budget", size, len(state))
		}
		if !utf8.ValidString(state) || json.Valid([]byte(state)) != true {
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
		if assistant, _ := fields["assistant"].(string); assistant == "" {
			t.Fatalf("size %d: assistant lost", size)
		}
		// The tail keeps ~1000 bytes: the error lines at the end survive.
		if len(result) > 2000 && len(result)-strings.LastIndex(result, "bytes elided") < 900 {
			t.Fatalf("size %d: tail under 900 bytes: %d", size, len(result)-strings.LastIndex(result, "bytes elided"))
		}
	}
}
