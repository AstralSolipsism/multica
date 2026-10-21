package daemon

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// TestStepStateOmitsFileContent locks the §4 boundary: a tool whose result is
// file content (Read) never sends its body out — the state keeps only the
// omission marker, even with a secret inside the file.
func TestStepStateOmitsFileContent(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)
	req := thinkingDecisionRequest{
		Step: 2,
		Tools: []struct {
			Name          string `json:"name"`
			IsError       bool   `json:"is_error"`
			IsFileContent bool   `json:"is_file_content"`
			InputSummary  string `json:"input_summary"`
			ResultText    string `json:"result_text"`
		}{
			{Name: "Read", IsFileContent: true, InputSummary: "config.go", ResultText: "dsn := \"postgres://app@db.internal:5432/orders\""},
		},
	}
	jevReq, _ := run.buildStepRequest(req)
	state, _ := jevReq.State.(string)
	if strings.Contains(state, "postgres://") || strings.Contains(state, "db.internal") {
		t.Fatalf("file content leaked into state: %s", state)
	}
	if !strings.Contains(state, "[file content omitted]") {
		t.Fatalf("state missing the omission marker: %s", state)
	}
	if !strings.Contains(state, `"tool":"Read"`) {
		t.Fatalf("state missing the tool name: %s", state)
	}
}

// TestStepStateParsesBashExitCode locks the Bash failure shape: "Exit code N"
// feeds exit_code and is skipped by the error feature, so different failures
// keep different features instead of all collapsing to "exit code".
func TestStepStateParsesBashExitCode(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)
	bashError := func(body string) struct {
		Name          string `json:"name"`
		IsError       bool   `json:"is_error"`
		IsFileContent bool   `json:"is_file_content"`
		InputSummary  string `json:"input_summary"`
		ResultText    string `json:"result_text"`
	} {
		return struct {
			Name          string `json:"name"`
			IsError       bool   `json:"is_error"`
			IsFileContent bool   `json:"is_file_content"`
			InputSummary  string `json:"input_summary"`
			ResultText    string `json:"result_text"`
		}{Name: "Bash", IsError: true, InputSummary: "go build ./...", ResultText: "Exit code 1\n" + body}
	}

	_, input := run.buildStepRequest(thinkingDecisionRequest{Step: 2, ErrorText: "Exit code 1\nscheduler.go:4:2: fmt imported and not used", Tools: []struct {
		Name          string `json:"name"`
		IsError       bool   `json:"is_error"`
		IsFileContent bool   `json:"is_file_content"`
		InputSummary  string `json:"input_summary"`
		ResultText    string `json:"result_text"`
	}{bashError("scheduler.go:4:2: fmt imported and not used")}})
	if input.ExitCode != 1 {
		t.Fatalf("exit code: %d", input.ExitCode)
	}
	if !strings.Contains(input.ErrorFeatures, "fmt imported and not used") {
		t.Fatalf("feature lost the compile error: %q", input.ErrorFeatures)
	}

	// Three unrelated Bash failures must produce three different features,
	// not a single growing repeat count.
	features := map[string]int{}
	for _, body := range []string{
		"scheduler.go:4:2: fmt imported and not used",
		"--- FAIL: TestX | assertion failed",
		"bash: nonexistent-command: command not found",
	} {
		req := thinkingDecisionRequest{Step: 3, ErrorText: "Exit code 1\n" + body, Tools: []struct {
			Name          string `json:"name"`
			IsError       bool   `json:"is_error"`
			IsFileContent bool   `json:"is_file_content"`
			InputSummary  string `json:"input_summary"`
			ResultText    string `json:"result_text"`
		}{bashError(body)}}
		_, input := run.buildStepRequest(req)
		if input.ErrorFeatures == "" || strings.HasPrefix(input.ErrorFeatures, "exit code") {
			t.Fatalf("feature collapsed to the exit-code line: %q", input.ErrorFeatures)
		}
		features[input.ErrorFeatures]++
	}
	if len(features) != 3 {
		t.Fatalf("unrelated failures share features: %v", features)
	}
}

func TestParseExitCode(t *testing.T) {
	t.Parallel()
	for text, want := range map[string]int{
		"Exit code 127\nbash: x: command not found": 127,
		"Exit code 2":                    2,
		"scheduler.go:4:2: fmt imported": -1,
		"":                               -1,
		"Exit code not-a-number":         -1,
	} {
		if got := ParseExitCode(text); got != want {
			t.Errorf("ParseExitCode(%q) = %d, want %d", text, got, want)
		}
	}
}

// TestStepStateGoalIsPlainText locks §4: the goal field is the run's title
// and description as plain text, not the run state's JSON encoding.
func TestStepStateGoalIsPlainText(t *testing.T) {
	t.Parallel()
	task := Task{
		ThreadName:            "修复调度器竞态",
		IssueDescription:      strings.Repeat("高并发下任务偶发被领取两次。", 60), // ~660 chars
		TriggerCommentContent: strings.Repeat("上次没修好。", 100),
	}
	goal := StepThinkingGoal(task)
	if strings.Contains(goal, "{") || strings.Contains(goal, `"kind"`) {
		t.Fatalf("goal is JSON-encoded: %.120s", goal)
	}
	if !strings.HasPrefix(goal, "修复调度器竞态\n") {
		t.Fatalf("goal does not start with the title: %.60s", goal)
	}
	if !strings.Contains(goal, "高并发下任务偶发被领取两次") {
		t.Fatalf("goal lost the description: %.120s", goal)
	}
	// The state builder clips the goal to 500 chars; the description's tail
	// is dropped, but the title and the description's head survive.
	state := BuildStepThinkingState(StepThinkingInput{Step: 2, Goal: goal})
	if !strings.Contains(state, "修复调度器竞态") {
		t.Fatalf("state lost the goal's title: %.120s", state)
	}
}

// TestStepTagFlowWithToolResultsBetweenSteps reproduces the production
// message flow through the real run-level tag() pairing (as executeAndDrain
// feeds it): tool_results between steps, so lastTagFirstOfRequest keeps
// updating. A step tag must land on every decided step (#18) and stop
// landing after revocation (#5), and the wiring itself is what the test
// exercises (the previous TestStepTagAfterRevocation drove its own tagging).
func TestStepTagFlowWithToolResultsBetweenSteps(t *testing.T) {
	t.Parallel()
	run := &thinkingRun{Record: &ThinkingDecisionRecord{Mode: "adapt", Decision: jev.Decision{Level: "medium"}}}
	step := &stepEffortRun{}
	tag := func(msg agent.Message) agent.Message {
		msg = run.tag(msg)
		return step.tagStep(msg, run.lastTagFirstOfRequest())
	}

	// Step 1: assistant text + tool_use, then the tool result (a user
	// message; not a new model request).
	if msg := tag(agent.Message{Type: agent.MessageText, Content: "one", ModelRequestID: "m1"}); msg.Metadata == nil {
		t.Fatal("step 1 lost its run-level tag")
	}
	if msg := tag(agent.Message{Type: agent.MessageToolUse, ModelRequestID: "m1"}); msg.Metadata != nil && msg.Metadata["thinking"] != nil {
		t.Fatalf("step 1 tool_use carries a tag: %+v", msg.Metadata)
	}
	if msg := tag(agent.Message{Type: agent.MessageToolResult, CallID: "t1"}); msg.Metadata != nil && msg.Metadata["thinking"] != nil {
		t.Fatalf("a tool result carries a tag: %+v", msg.Metadata)
	}

	// Step 2 decided high: the effect record arrives before the step's
	// first assistant event, and the step tag must land (the frozen-dedup
	// bug left every post-step-1 message untagged).
	step.observeEffect(agent.EffortEffect{Step: 2, Level: "high"})
	if msg := tag(agent.Message{Type: agent.MessageText, Content: "two", ModelRequestID: "m2"}); msg.Metadata == nil {
		t.Fatal("step 2 carried no tag at all (dedup froze?)")
	} else if meta := msg.Metadata["thinking"].(map[string]any); meta["step"] != 2 || meta["level"] != "high" {
		t.Fatalf("step 2 tag: %+v", meta)
	}
	if msg := tag(agent.Message{Type: agent.MessageToolUse, ModelRequestID: "m2"}); msg.Metadata != nil && msg.Metadata["thinking"] != nil {
		t.Fatalf("step 2 later event carries a tag: %+v", msg.Metadata)
	}
	tag(agent.Message{Type: agent.MessageToolResult, CallID: "t2"})

	// Step 3 falls back (a fresh effect record with fallback set).
	step.observeEffect(agent.EffortEffect{Step: 3, Level: "high", Fallback: "timeout"})
	if msg := tag(agent.Message{Type: agent.MessageText, Content: "three", ModelRequestID: "m3"}); msg.Metadata == nil {
		t.Fatal("step 3 carried no tag")
	} else if meta := msg.Metadata["thinking"].(map[string]any); meta["fallback"] != "timeout" || meta["level"] != "high" {
		t.Fatalf("step 3 fallback tag: %+v", meta)
	}
	tag(agent.Message{Type: agent.MessageToolResult, CallID: "t3"})

	// Revocation: no further effect records. No message carries any tag —
	// not the run-level medium, which no longer reflects the level in
	// effect.
	for _, msg := range []agent.Message{
		{Type: agent.MessageText, Content: "four", ModelRequestID: "m4"},
		{Type: agent.MessageThinking, Content: "hmm", ModelRequestID: "m4"},
		{Type: agent.MessageToolUse, ModelRequestID: "m4"},
	} {
		if tagged := tag(msg); tagged.Metadata != nil && tagged.Metadata["thinking"] != nil {
			t.Fatalf("post-revocation message carries a tag: %+v", tagged.Metadata)
		}
	}
}

// TestPerTurnEffortCallbackWritesAndRemovesMarker drives the system-frame
// wiring end to end: an active init writes the enablement marker (the
// endpoint then decides), a changed=false frame removes it (the endpoint
// answers not-enabled).
func TestPerTurnEffortCallbackWritesAndRemovesMarker(t *testing.T) {
	t.Parallel()
	d, run := newStepEffortTestDaemon(t)
	run.Clients = &fakeStepDecider{decision: jev.Decision{Level: "high"}}
	callback := d.perTurnEffortCallback("task-effort")

	// Before init: not enabled, the endpoint refuses without touching Jev.
	rec := httptestRecorder(t, d, `{"step":2}`)
	if resp := decodeDecision(t, rec); resp.Enabled == nil || *resp.Enabled {
		t.Fatalf("expected not-enabled before init: %+v", resp)
	}

	// init reports active: the marker is written and the endpoint decides.
	callback(true)
	if _, err := os.Stat(run.EnabledPath); err != nil {
		t.Fatalf("marker not written: %v", err)
	}
	rec = httptestRecorder(t, d, `{"step":2}`)
	if resp := decodeDecision(t, rec); resp.Level != "high" {
		t.Fatalf("expected a decision with the marker present: %+v", resp)
	}

	// per_turn_effort_changed=false: the marker is removed, the endpoint
	// answers not-enabled (without touching Jev).
	callback(false)
	if _, err := os.Stat(run.EnabledPath); !os.IsNotExist(err) {
		t.Fatalf("marker not removed: %v", err)
	}
	rec = httptestRecorder(t, d, `{"step":3}`)
	if resp := decodeDecision(t, rec); resp.Enabled == nil || *resp.Enabled {
		t.Fatalf("expected not-enabled after revocation: %+v", resp)
	}
}

func httptestRecorder(t *testing.T, d *Daemon, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(body))
	return rec
}

// TestThinkingDecisionRejectsReplayedSteps locks the replay guard: only
// increasing steps decide; a repeated or lower step falls back without
// touching Jev or the run's error tracking.
func TestThinkingDecisionRejectsReplayedSteps(t *testing.T) {
	t.Parallel()
	d, run := newStepEffortTestDaemon(t)
	decider := &countingDecider{inner: &fakeStepDecider{decision: jev.Decision{Level: "high"}}}
	run.Clients = decider
	if err := os.WriteFile(run.EnabledPath, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, step := range []int{2, 3, 4} {
		body, _ := json.Marshal(map[string]any{"step": step})
		rec := httptestRecorder(t, d, string(body))
		if resp := decodeDecision(t, rec); resp.Level != "high" {
			t.Fatalf("step %d: %+v", step, resp)
		}
	}
	if decider.calls != 3 {
		t.Fatalf("decisions: %d, want 3", decider.calls)
	}
	for _, step := range []int{3, 2, 4, 4} {
		body, _ := json.Marshal(map[string]any{"step": step})
		rec := httptestRecorder(t, d, string(body))
		resp := decodeDecision(t, rec)
		if resp.Level != "" || resp.Fallback != string(jev.ReasonInvalid) {
			t.Fatalf("replayed step %d decided: %+v", step, resp)
		}
	}
	if decider.calls != 3 {
		t.Fatalf("replays reached Jev: %d calls", decider.calls)
	}
	// A later fresh step still decides.
	body, _ := json.Marshal(map[string]any{"step": 5})
	if resp := decodeDecision(t, httptestRecorder(t, d, string(body))); resp.Level != "high" {
		t.Fatalf("fresh step after replays: %+v", resp)
	}
}

type countingDecider struct {
	inner *fakeStepDecider
	calls int
}

func (c *countingDecider) Decide(ctx context.Context, req jev.Request) (jev.Decision, error) {
	c.calls++
	return c.inner.Decide(ctx, req)
}
