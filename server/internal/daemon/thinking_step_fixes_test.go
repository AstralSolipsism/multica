package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// stepToolMaterial mirrors thinkingDecisionRequest.Tools in tests.
type stepToolMaterial = struct {
	Name         string `json:"name"`
	IsError      bool   `json:"is_error"`
	InputSummary string `json:"input_summary"`
	ResultText   string `json:"result_text"`
}

// TestStepStateShipsReadResultUnredacted locks the OL-1083 boundary: a Read
// result is tool material like any other — the body reaches the state, with
// any secret it contains, exactly as the coding model already sees it.
func TestStepStateShipsReadResultUnredacted(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)
	req := thinkingDecisionRequest{
		Step: 2,
		Tools: []stepToolMaterial{
			{Name: "Read", InputSummary: "config.go", ResultText: "dsn := \"postgres://app@db.internal:5432/orders\""},
		},
	}
	jevReq, _ := run.buildStepRequest(req)
	state, _ := jevReq.State.(string)
	if !strings.Contains(state, "postgres://app@db.internal:5432/orders") {
		t.Fatalf("file content missing from state: %s", state)
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
	bashError := func(body string) stepToolMaterial {
		return stepToolMaterial{Name: "Bash", IsError: true, InputSummary: "go build ./...", ResultText: "Exit code 1\n" + body}
	}

	_, input := run.buildStepRequest(thinkingDecisionRequest{Step: 2, ErrorText: "Exit code 1\nscheduler.go:4:2: fmt imported and not used", Tools: []stepToolMaterial{bashError("scheduler.go:4:2: fmt imported and not used")}})
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
		req := thinkingDecisionRequest{Step: 3, ErrorText: "Exit code 1\n" + body, Tools: []stepToolMaterial{bashError(body)}}
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

// TestTagThinkingMessageWiring drives the exact function executeAndDrain
// calls for every message (#20's remaining half): the run-level tag always
// applies, the step effect replaces it on the step's first message, and
// after revocation no tag lands at all. Steps are separated by tool_results
// — the shape that froze request-id dedup in round 2.
func TestTagThinkingMessageWiring(t *testing.T) {
	t.Parallel()
	d := &Daemon{logger: slog.Default()}
	run := &stepEffortRun{TaskID: "task-wiring", EnabledPath: filepath.Join(t.TempDir(), "enabled")}
	d.stepEffort.add(run)
	thinking := &thinkingRun{Record: &ThinkingDecisionRecord{Mode: "adapt", Decision: jev.Decision{Level: "medium"}}}
	ctx := context.WithValue(context.Background(), thinkingRunKey{}, thinking)
	tag := func(msg agent.Message) agent.Message {
		return d.tagThinkingMessage(ctx, "task-wiring", msg)
	}

	// Step 1: run-level tag on the first message; the tool_result between
	// steps must not open a new one.
	if msg := tag(agent.Message{Type: agent.MessageText, Content: "one", ModelRequestID: "m1"}); msg.Metadata == nil {
		t.Fatal("step 1 first message lost its tag")
	}
	if msg := tag(agent.Message{Type: agent.MessageToolResult, CallID: "t1"}); msg.Metadata != nil && msg.Metadata["thinking"] != nil {
		t.Fatalf("tool result carries a tag: %+v", msg.Metadata)
	}

	// Step 2: the effect record replaces the run-level tag on the step's
	// first message (kill for the "skip tag()" mutation).
	run.observeEffect(agent.EffortEffect{Step: 2, Level: "high"})
	if msg := tag(agent.Message{Type: agent.MessageText, Content: "two", ModelRequestID: "m2"}); msg.Metadata == nil {
		t.Fatal("step 2 first message carries no tag — tag() was skipped?")
	} else if meta := msg.Metadata["thinking"].(map[string]any); meta["step"] != 2 || meta["level"] != "high" {
		t.Fatalf("step 2 tag: %+v", meta)
	}
	if msg := tag(agent.Message{Type: agent.MessageToolResult, CallID: "t2"}); msg.Metadata != nil && msg.Metadata["thinking"] != nil {
		t.Fatalf("step 2 tool result carries a tag: %+v", msg.Metadata)
	}

	// Step 3 falls back (fallback record still tags — kill for the "remove
	// tagStep" mutation).
	run.observeEffect(agent.EffortEffect{Step: 3, Level: "high", Fallback: "timeout"})
	if msg := tag(agent.Message{Type: agent.MessageText, Content: "three", ModelRequestID: "m3"}); msg.Metadata == nil {
		t.Fatal("step 3 carries no tag — tagStep was removed?")
	} else if meta := msg.Metadata["thinking"].(map[string]any); meta["fallback"] != "timeout" {
		t.Fatalf("step 3 tag: %+v", meta)
	}
	tag(agent.Message{Type: agent.MessageToolResult, CallID: "t3"})

	// Revoked: no further effect records; no message carries any tag.
	for _, msg := range []agent.Message{
		{Type: agent.MessageText, Content: "four", ModelRequestID: "m4"},
		{Type: agent.MessageThinking, Content: "hmm", ModelRequestID: "m4"},
	} {
		if tagged := tag(msg); tagged.Metadata != nil && tagged.Metadata["thinking"] != nil {
			t.Fatalf("post-revocation message carries a tag: %+v", tagged.Metadata)
		}
	}
}

// TestStepStateShipsErrorMaterialUnredacted locks the OL-1083 boundary: tool
// error material crosses to the decision engine unredacted, and a tail error
// survives the state builder's head+tail excerpt.
func TestStepStateShipsErrorMaterialUnredacted(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)

	// A credential in the error text ships verbatim; the feature keeps it
	// recognizable too (the engine sees what the coding model sees) —
	// NormalizedErrorFeature no longer redacts before normalizing.
	const conn = "postgres://app:secret@db.internal:5432/orders"
	jevReq, input := run.buildStepRequest(thinkingDecisionRequest{
		Step:      2,
		ErrorText: "dial " + conn + ": connection refused",
		Tools:     []stepToolMaterial{{Name: "Bash", IsError: true, InputSummary: "psql", ResultText: "Exit code 1\ndial " + conn + ": connection refused"}},
	})
	if !strings.Contains(input.ErrorFeatures, "connection refused") {
		t.Fatalf("error feature lost the failure: %q", input.ErrorFeatures)
	}
	if !strings.Contains(input.ErrorFeatures, "app_secret@") {
		t.Fatalf("error feature redacted the credential: %q", input.ErrorFeatures)
	}
	state, _ := jevReq.State.(string)
	if !strings.Contains(state, conn) {
		t.Fatalf("state missing the raw error material: %s", state)
	}

	// A long tool result whose error sits at the tail keeps head and tail
	// in the result excerpt.
	var head strings.Builder
	for head.Len() < 640 {
		head.WriteString("progress: step done\n")
	}
	tailError := "FAIL: TestScheduler verification TAIL_CANARY missing"
	_, input = run.buildStepRequest(thinkingDecisionRequest{
		Step:  3,
		Tools: []stepToolMaterial{{Name: "Bash", IsError: true, InputSummary: "go test", ResultText: "Exit code 1\n" + head.String() + tailError}},
	})
	if input.ToolResult == "" || !strings.Contains(input.ToolResult, tailError) {
		t.Fatalf("input lost the tail error before the state builder")
	}
	state2 := BuildStepThinkingState(input)
	if !strings.Contains(state2, "progress: step done") || !strings.Contains(state2, "TAIL_CANARY") {
		t.Fatalf("state lost the result head or tail: %.300s", state2[len(state2)-300:])
	}
}

// TestStepStateKeepsTailErrorOfLongOutput locks the long-output boundary: a
// 5000+ char failing Bash output keeps both its head and its closing error
// in the state's result excerpt.
func TestStepStateKeepsTailErrorOfLongOutput(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)
	var b strings.Builder
	for i := 0; i < 220; i++ {
		b.WriteString("progress line " + strings.Repeat("x", 20) + " done\n")
	}
	b.WriteString("FAIL: TAIL_CANARY missing")
	result := b.String()
	if len(result) <= 5000 {
		t.Fatalf("fixture too short: %d", len(result))
	}
	_, input := run.buildStepRequest(thinkingDecisionRequest{
		Step:      2,
		Tools:     []stepToolMaterial{{Name: "Bash", IsError: true, InputSummary: "go test ./...", ResultText: "Exit code 1\n" + result}},
		ErrorText: "Exit code 1\n" + result,
	})
	state := BuildStepThinkingState(input)
	if !strings.Contains(state, "progress line ") {
		t.Fatalf("result head lost from state: %s", state[:200])
	}
	if !strings.Contains(state, "TAIL_CANARY") {
		t.Fatalf("tail error lost from state: %s", state)
	}
	if !strings.Contains(state, "bytes elided") {
		t.Fatalf("state missing the elision marker: %s", state[:200])
	}
}

// TestStepStateShipsPrivateKeyWhole locks OL-1083: a multi-line PEM private
// key (>2000 chars) arriving in tool output ships to the decision engine as
// material the coding model already sees — head and tail in the excerpt.
func TestStepStateShipsPrivateKeyWhole(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)
	pem := []string{"-----BEGIN PRIVATE KEY-----"}
	for i := 0; i < 40; i++ {
		pem = append(pem, "MIIE"+strings.Repeat("A", 60))
	}
	pem = append(pem, "-----END PRIVATE KEY-----")
	key := strings.Join(pem, "\n")
	if len(key) <= 2000 {
		t.Fatalf("fixture too short: %d", len(key))
	}
	_, input := run.buildStepRequest(thinkingDecisionRequest{
		Step:      2,
		Tools:     []stepToolMaterial{{Name: "Bash", IsError: true, InputSummary: "cat id_rsa", ResultText: key}},
		ErrorText: key,
	})
	state := BuildStepThinkingState(input)
	if !strings.Contains(state, "BEGIN PRIVATE KEY") {
		t.Fatalf("state missing the key head: %s", state[:200])
	}
	if !strings.Contains(state, "END PRIVATE KEY") {
		t.Fatalf("state missing the key tail: %s", state)
	}
}

// TestStepStateReadFailureFeedsErrors locks the tool boundary: a Read
// FAILURE is an error message like any other — it feeds error_text and
// error_features.
func TestStepStateReadFailureFeedsErrors(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)
	_, input := run.buildStepRequest(thinkingDecisionRequest{
		Step:      2,
		Tools:     []stepToolMaterial{{Name: "Read", IsError: true, InputSummary: "a.go", ResultText: "File does not exist."}},
		ErrorText: "File does not exist.",
	})
	state := BuildStepThinkingState(input)
	if !strings.Contains(state, "File does not exist.") {
		t.Fatalf("Read failure error missing from state: %s", state)
	}
	if !strings.Contains(input.ErrorFeatures, "file does not exist") {
		t.Fatalf("Read failure missing from error features: %q", input.ErrorFeatures)
	}
}
