package daemon

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func decodeStepState(t *testing.T, state string) map[string]any {
	t.Helper()
	var fields map[string]any
	if err := json.Unmarshal([]byte(state), &fields); err != nil {
		t.Fatalf("invalid state: %v", err)
	}
	return fields
}

// TestStepStateCapsFieldsIndependently locks OL-1083's step state: every
// field is capped on its own (goal/assistant 500 runes, summary 300,
// features 200, result 2500 bytes head+tail) — no dynamic budget, no field
// squeezed out by another, no emptied results. The reviewer's hang inputs
// and escape-dense/HTML results are ordinary cases under this rule.
func TestStepStateCapsFieldsIndependently(t *testing.T) {
	t.Parallel()
	cjk := func(n int) string { return strings.Repeat("词", n) }
	mk := func(size int) string {
		var b strings.Builder
		for b.Len() < size {
			b.WriteString("progress line with some padding done\n")
		}
		return "HEAD_CANARY\n" + b.String()[:size] + "\nExit code 1\nFAIL: TAIL_CANARY assertion failed"
	}
	goal := strings.Repeat("目", 500)
	assistant := strings.Repeat("助", 500)
	var html strings.Builder
	for html.Len() < 50*1024 {
		html.WriteString("<div class=\"row\">&amp;&lt;</div>\n")
	}
	var goSrc strings.Builder
	for goSrc.Len() < 50*1024 {
		goSrc.WriteString("func (s *S) dispatch(w int) {\n\ts.mu.Lock()\n\tdefer s.mu.Unlock()\n\tch := <-s.done && s.cond.Wait()\n\tgo f(&&wg)\n}\n")
	}
	cases := []struct {
		name  string
		input StepThinkingInput
	}{
		{"1KB result", StepThinkingInput{Step: 4, Goal: goal, AssistantText: assistant, ToolName: "Bash", ToolInputSummary: cjk(300), ToolIsError: true, ExitCode: 1, ErrorFeatures: cjk(200), RepeatedErrors: 2, ToolResult: mk(1024)}},
		{"3KB result", StepThinkingInput{Step: 4, Goal: goal, AssistantText: assistant, ToolName: "Bash", ToolInputSummary: "go test ./...", ToolIsError: true, ExitCode: 1, ErrorFeatures: "FAIL_ feature", RepeatedErrors: 2, ToolResult: mk(3 * 1024)}},
		{"50KB result", StepThinkingInput{Step: 4, Goal: goal, AssistantText: assistant, ToolName: "Bash", ToolInputSummary: "go test ./...", ToolIsError: true, ExitCode: 1, ErrorFeatures: "FAIL_ feature", RepeatedErrors: 2, ToolResult: mk(50 * 1024)}},
		{"HTML result", StepThinkingInput{Step: 2, Goal: cjk(500), AssistantText: cjk(500), ToolName: "Read", ToolInputSummary: cjk(100), ToolResult: html.String()}},
		{"Go source result", StepThinkingInput{Step: 3, Goal: "修复任务调度器偶发卡住的问题\n" + strings.Repeat("高并发下任务偶发被领取两次，需要分析共享状态和锁顺序。", 24), AssistantText: "已读入 scheduler.go，下一步分析锁顺序。", ToolName: "Read", ToolInputSummary: "scheduler.go", ToolResult: goSrc.String()}},
		{"short result, hang input", StepThinkingInput{Step: 2, Goal: cjk(500), AssistantText: cjk(500), ToolName: "Bash", ToolInputSummary: cjk(300), ToolResult: strings.Repeat("y", 200)}},
		{"features at cap", StepThinkingInput{Step: 2, Goal: cjk(500), AssistantText: cjk(500), ToolName: "Bash", ToolInputSummary: "go test ./...", ToolIsError: true, ErrorFeatures: cjk(100), ToolResult: strings.Repeat("x", 2048)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state := BuildStepThinkingState(tc.input)
			// No whole-state cap (OL-1083): the size is bounded by the
			// per-field caps — worst case ~8.5 KB with every Chinese field
			// at its cap plus a 2500-byte HTML result. Only sanity-bound it.
			if len(state) > 12*1024 {
				t.Fatalf("state %d bytes beyond any field-cap bound", len(state))
			}
			if !utf8.ValidString(state) || !json.Valid([]byte(state)) {
				t.Fatal("invalid state")
			}
			fields := decodeStepState(t, state)
			// Acceptance #4: goal, assistant and error features complete at
			// their field caps, never trimmed away by another field.
			if got, _ := fields["goal"].(string); got != thinkingPrefix(tc.input.Goal, 500) {
				t.Fatalf("goal trimmed: %d of %d runes", len([]rune(got)), len([]rune(tc.input.Goal)))
			}
			if got, _ := fields["assistant"].(string); got != thinkingPrefix(tc.input.AssistantText, 500) {
				t.Fatalf("assistant trimmed: %d of %d runes", len([]rune(got)), len([]rune(tc.input.AssistantText)))
			}
			if got, _ := fields["error_features"].(string); got != thinkingPrefix(tc.input.ErrorFeatures, 200) {
				t.Fatal("error_features trimmed")
			}
			// A non-empty result never ships empty (the #18 regression).
			result, _ := fields["result"].(string)
			if tc.input.ToolResult != "" && result == "" {
				t.Fatal("result emptied")
			}
			// A clipped result keeps the input's head, a ~1000-byte tail and
			// the elision marker.
			if len(tc.input.ToolResult) > stepResultLimit {
				head, tail := splitExcerpt(result)
				if head < 0 {
					t.Fatal("clipped result missing the elision marker")
				}
				if tc.input.ToolResult[:head] != result[:head] {
					t.Fatalf("result head %d bytes is not the input's head", head)
				}
				if tail < stepResultTail-4 {
					t.Fatalf("tail only %d bytes, want ~%d", tail, stepResultTail)
				}
			}
		})
	}
}

// TestStepResultExcerptShape pins the single clip: results within the limit
// ship whole; over it, head = limit-1000 and tail = 1000 bytes, cuts on
// rune boundaries.
func TestStepResultExcerptShape(t *testing.T) {
	t.Parallel()
	var body strings.Builder
	for body.Len() < 4096 {
		body.WriteString("0123456789abcdefghijklmnopqrstuvwxyz")
	}
	within := body.String()[:stepResultLimit]
	if got := stepResultExcerpt(within); got != within {
		t.Fatal("result within the limit must ship whole")
	}
	head, tail := splitExcerpt(stepResultExcerpt(body.String()))
	if head != stepResultLimit-stepResultTail || tail != stepResultTail {
		t.Fatalf("head=%d tail=%d, want %d/%d", head, tail, stepResultLimit-stepResultTail, stepResultTail)
	}
	// CJK: cuts land on 3-byte boundaries with the same split.
	cjk := strings.Repeat("汉", 4096)
	head, tail = splitExcerpt(stepResultExcerpt(cjk))
	if head%3 != 0 || tail%3 != 0 {
		t.Fatalf("cjk cuts not on rune boundaries: head=%d tail=%d", head, tail)
	}
	if tail < stepResultTail-4 || head < stepResultLimit-stepResultTail-4 {
		t.Fatalf("cjk split drifted: head=%d tail=%d", head, tail)
	}
}

func splitExcerpt(excerpt string) (head, tail int) {
	i := strings.Index(excerpt, "\n[... ")
	if i < 0 {
		return -1, -1
	}
	markerEnd := strings.Index(excerpt[i:], "]\n") + i + 2
	return i, len(excerpt) - markerEnd
}
