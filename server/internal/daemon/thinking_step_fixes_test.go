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

// TestStepTagAfterRevocation locks §7's revocation rule: once a step tag has
// landed, a step without an effect record carries no tag at all (the level
// in effect stays the last tagged one; a run-level tag would misreport it).
func TestStepTagAfterRevocation(t *testing.T) {
	t.Parallel()
	run := &thinkingRun{Record: &ThinkingDecisionRecord{Mode: "adapt", Decision: jev.Decision{Level: "medium"}}}
	step := &stepEffortRun{}

	tag := func(msg agent.Message) agent.Message {
		if step.sawEffect() {
			// Skip the run-level tag entirely once step tags are active.
		} else {
			msg = run.tag(msg)
		}
		return step.tagStep(msg, run.lastTagFirstOfRequest())
	}

	// Step 1: no effect yet; the run-level tag applies.
	first := tag(agent.Message{Type: agent.MessageText, Content: "one", ModelRequestID: "m1"})
	if meta := first.Metadata["thinking"].(map[string]any); meta["step"] != nil {
		t.Fatalf("step 1 should carry the run-level tag: %+v", meta)
	}
	// Step 2: an effect arrives and tags the step.
	step.observeEffect(agent.EffortEffect{Step: 2, Level: "high"})
	second := tag(agent.Message{Type: agent.MessageText, Content: "two", ModelRequestID: "m2"})
	if meta := second.Metadata["thinking"].(map[string]any); meta["step"] != 2 || meta["level"] != "high" {
		t.Fatalf("step 2 tag: %+v", meta)
	}
	// Step 3: revoked (no effect record). No tag at all — not the run-level
	// medium, which would misreport the level in effect and invent a change.
	third := tag(agent.Message{Type: agent.MessageText, Content: "three", ModelRequestID: "m3"})
	if third.Metadata != nil {
		if _, has := third.Metadata["thinking"]; has {
			t.Fatalf("revoked step carries a tag: %+v", third.Metadata)
		}
	}
	// Thinking messages after revocation carry none either.
	fourth := tag(agent.Message{Type: agent.MessageThinking, Content: "hmm", ModelRequestID: "m4"})
	if fourth.Metadata != nil {
		if _, has := fourth.Metadata["thinking"]; has {
			t.Fatalf("revoked thinking carries a tag: %+v", fourth.Metadata)
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
