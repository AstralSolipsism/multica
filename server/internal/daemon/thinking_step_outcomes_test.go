package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/internal/daemon/jevsample"
	"github.com/multica-ai/multica/server/pkg/agent"
)

type stepSampleFixture struct {
	d     *Daemon
	run   *stepEffortRun
	dir   string
	close func()
}

func newStepSampleFixture(t *testing.T) *stepSampleFixture {
	t.Helper()
	d, run := newStepEffortTestDaemon(t)
	dir := t.TempDir()
	c := jevsample.New(dir, "step-test", "", 0, quietTaskLog())
	run.Samples = c
	run.Clients = &fakeStepDecider{decision: jev.Decision{
		Level: "high", Confidence: 0.9, Source: "fake", LatencyMS: 12,
		Probabilities: map[string]float64{"high": 0.9, "low": 0.1},
	}}
	d.setStepEffortEnabled(run.TaskID, true)
	var once sync.Once
	close := func() { once.Do(c.Close) }
	t.Cleanup(close)
	return &stepSampleFixture{d: d, run: run, dir: dir, close: close}
}

func (f *stepSampleFixture) request(t *testing.T, step int, material string) thinkingDecisionResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	f.d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(fmt.Sprintf(`{"step":%d%s}`, step, material)))
	if rec.Code != http.StatusOK {
		t.Fatalf("step %d: %d %s", step, rec.Code, rec.Body.String())
	}
	return decodeDecision(t, rec)
}

func (f *stepSampleFixture) effect(step int, tool string) {
	f.run.observeEffect(agent.EffortEffect{Step: step, Level: "high"})
	msg := agent.Message{Type: agent.MessageText}
	if tool != "" {
		msg.Type, msg.Tool = agent.MessageToolUse, tool
	}
	ctx := context.WithValue(context.Background(), thinkingRunKey{}, &thinkingRun{})
	f.d.tagThinkingMessage(ctx, f.run.TaskID, msg)
}

func (f *stepSampleFixture) records(t *testing.T) []map[string]any {
	t.Helper()
	f.d.stepEffort.remove(f.run.TaskID)
	f.close()
	files, err := filepath.Glob(filepath.Join(f.dir, "*.jsonl"))
	if err != nil || len(files) != 1 {
		t.Fatalf("sample files=%v err=%v", files, err)
	}
	return sampleRecords(t, files[0])
}

// Pairing assertions also reject duplicate outcomes and outcomes for fallback
// steps. Only signal fields may appear in an outcome, never raw tool material.
func pairedStepSamples(t *testing.T, records []map[string]any) (map[int]map[string]any, map[int]map[string]any) {
	t.Helper()
	decisions, outcomes := map[int]map[string]any{}, map[int]map[string]any{}
	ids := map[string]int{}
	for _, record := range records {
		if record["scope"] != "step" || record["v"] != float64(1) {
			t.Fatalf("invalid step record: %v", record)
		}
		if record["type"] == "decision" {
			step := int(record["step"].(float64))
			if decisions[step] != nil {
				t.Fatalf("duplicate decision for %d", step)
			}
			decisions[step] = record
			ids[record["id"].(string)] = step
			continue
		}
		step, ok := ids[record["decision_id"].(string)]
		if !ok || outcomes[step] != nil {
			t.Fatalf("unpaired or duplicate outcome: %v", record)
		}
		outcomes[step] = record
		for key := range record {
			switch key {
			case "v", "type", "ts", "scope", "decision_id", "tools", "action_kind", "outcome_ok", "error_sig", "prev_action_kind", "prev_outcome_ok", "next_outcome_ok", "repeated_error_next":
			default:
				t.Errorf("unexpected outcome field %s", key)
			}
		}
	}
	if len(decisions) != len(outcomes) {
		t.Fatalf("decisions=%d outcomes=%d", len(decisions), len(outcomes))
	}
	return decisions, outcomes
}

func assertStepFields(t *testing.T, record map[string]any, want map[string]any) {
	t.Helper()
	for key, value := range want {
		got, present := record[key]
		if !present || !reflect.DeepEqual(got, value) {
			t.Errorf("%s=%#v (present=%v), want %#v; record=%v", key, got, present, value, record)
		}
	}
}

func TestStepOutcomesSixStepRun(t *testing.T) {
	f := newStepSampleFixture(t)
	materials := []string{
		"",
		`,"tools":[{"name":"Read","input_summary":"private-input","result_text":"private-output"}]`,
		`,"tools":[{"name":"Edit"}]`,
		`,"tools":[{"name":"Bash","is_error":true}],"error_text":"Exit code 1\nfile.go:12:3: undefined: sampleSentinel"`,
		`,"tools":[{"name":"Edit"}]`,
		`,"tools":[{"name":"Bash","is_error":true}],"error_text":"Exit code 2\nfile.go:42:9: undefined: sampleSentinel"`,
	}
	tools := []string{"Read", "Edit", "Bash", "Edit", "Bash", ""}
	for i, material := range materials {
		if resp := f.request(t, i+1, material); resp.Level != "high" {
			t.Fatalf("step %d: %+v", i+1, resp)
		}
		f.effect(i+1, tools[i])
	}
	// Subagent tool calls after the final main-thread text must not taint it.
	f.run.tagStep(agent.Message{Type: agent.MessageToolUse, ParentToolUseID: "task", Tool: "Bash"}, false)
	records := f.records(t)
	decisions, outcomes := pairedStepSamples(t, records)
	if len(decisions) != 6 {
		t.Fatalf("decisions=%d", len(decisions))
	}
	sum := sha256.Sum256([]byte(NormalizedErrorFeature("file.go:12:3: undefined: sampleSentinel")))
	sig := hex.EncodeToString(sum[:8])
	kinds := []string{"read_only", "edit_or_exec", "edit_or_exec", "edit_or_exec", "edit_or_exec", "final_text"}
	oks := []bool{true, true, false, true, false, true}
	for step := 1; step <= 6; step++ {
		assertStepFields(t, decisions[step], map[string]any{
			"task_id": "task-effort", "step": float64(step), "choice": "high", "source": "fake",
			"provider": "claude", "model": "claude-sonnet-5-5", "confidence": 0.9, "latency_ms": float64(12),
			"probabilities": map[string]any{"high": 0.9, "low": 0.1},
		})
		var state map[string]any
		if err := json.Unmarshal([]byte(decisions[step]["state"].(string)), &state); err != nil {
			t.Fatal(err)
		}
		if state["step"] != float64(step) || decisions[step]["questions"] == nil {
			t.Fatalf("bad decision state/questions: %v", decisions[step])
		}
		wantTools := []any{}
		if tools[step-1] != "" {
			wantTools = append(wantTools, tools[step-1])
		}
		want := map[string]any{"tools": wantTools, "action_kind": kinds[step-1], "outcome_ok": oks[step-1], "error_sig": "",
			"prev_action_kind": nil, "prev_outcome_ok": nil, "next_outcome_ok": nil, "repeated_error_next": nil}
		if !oks[step-1] {
			want["error_sig"] = sig
		}
		if step > 1 {
			want["prev_action_kind"], want["prev_outcome_ok"] = kinds[step-2], oks[step-2]
		}
		if step < 6 {
			want["next_outcome_ok"], want["repeated_error_next"] = oks[step], step == 4
		}
		assertStepFields(t, outcomes[step], want)
	}
	// Outcomes 1..4 were emitted as soon as requests 3..6 supplied their
	// lookahead, before those requests' decisions, rather than all at exit.
	for i, record := range records {
		if record["type"] == "decision" && record["step"].(float64) >= 3 {
			step := int(record["step"].(float64))
			if records[i-1]["decision_id"] != decisions[step-2]["id"] {
				t.Fatalf("step %d outcome was not emitted promptly", step-2)
			}
		}
	}
}

func TestStepOutcomesFallbackAndReplay(t *testing.T) {
	f := newStepSampleFixture(t)
	f.request(t, 1, "")
	f.effect(1, "Read")
	f.run.Clients = &fakeStepDecider{err: &jev.FallbackError{Reason: jev.ReasonTimeout}}
	if resp := f.request(t, 2, `,"tools":[{"name":"Read"}]`); resp.Fallback != "timeout" {
		t.Fatalf("fallback: %+v", resp)
	}
	if resp := f.request(t, 2, `,"tools":[{"name":"Bash","is_error":true}]`); resp.Fallback != "invalid" {
		t.Fatalf("replay: %+v", resp)
	}
	f.run.Clients = &fakeStepDecider{decision: jev.Decision{Level: "high"}}
	f.request(t, 3, `,"tools":[{"name":"Edit"}]`)
	f.effect(3, "")
	decisions, outcomes := pairedStepSamples(t, f.records(t))
	if len(decisions) != 2 || decisions[2] != nil {
		t.Fatalf("fallback sampled: %v", decisions)
	}
	assertStepFields(t, outcomes[1], map[string]any{"tools": []any{"Read"}, "action_kind": "read_only", "outcome_ok": true, "next_outcome_ok": true})
	assertStepFields(t, outcomes[3], map[string]any{"prev_action_kind": "edit_or_exec", "prev_outcome_ok": true, "action_kind": "final_text"})
}

func TestStepOutcomesErrorWithoutNormalizableFeature(t *testing.T) {
	f := newStepSampleFixture(t)
	// OL-1083 removed whole-field omission: error_text always arrives.
	// An error without a normalizable feature yields an empty sig, and an
	// empty sig never counts as a repeat of a real error.
	materials := []string{"", `,"tools":[{"name":"Bash","is_error":true}],"error_text":"error X"`,
		`,"tools":[{"name":"Bash","is_error":true}],"error_text":""`, `,"tools":[{"name":"Edit"}]`,
		`,"tools":[{"name":"Bash","is_error":true}],"error_text":"error X"`}
	for i, material := range materials {
		f.request(t, i+1, material)
	}
	f.effect(5, "")
	_, outcomes := pairedStepSamples(t, f.records(t))
	assertStepFields(t, outcomes[1], map[string]any{"repeated_error_next": false})
	assertStepFields(t, outcomes[2], map[string]any{"error_sig": "", "outcome_ok": false, "repeated_error_next": false})
	assertStepFields(t, outcomes[3], map[string]any{"error_sig": "", "outcome_ok": true, "repeated_error_next": false})
	assertStepFields(t, outcomes[4], map[string]any{"repeated_error_next": false})
}

func TestStepOutcomesMissingRequestWaitsForFinish(t *testing.T) {
	f := newStepSampleFixture(t)
	f.request(t, 1, "")
	f.effect(1, "Read")
	// The request carrying step 1's material never reached the daemon.
	f.request(t, 3, `,"tools":[{"name":"Edit"}]`)
	if f.run.steps[1].written {
		t.Fatal("incomplete outcome was written before terminal flushing")
	}
	f.effect(3, "")
	_, outcomes := pairedStepSamples(t, f.records(t))
	assertStepFields(t, outcomes[1], map[string]any{"tools": nil, "action_kind": nil, "outcome_ok": nil, "error_sig": nil, "next_outcome_ok": true, "repeated_error_next": nil})
}

func TestStepOutcomesTerminalPaths(t *testing.T) {
	for _, scenario := range []string{"unfinished-tool", "revoked", "revoked-request", "no-effect", "no-tools"} {
		t.Run(scenario, func(t *testing.T) {
			f := newStepSampleFixture(t)
			f.request(t, 1, "")
			f.effect(1, "Read")
			f.request(t, 2, `,"tools":[{"name":"Read"}]`)
			if scenario != "no-effect" {
				tool := "Bash"
				if scenario == "no-tools" {
					tool = ""
				}
				f.effect(2, tool)
			}
			if scenario == "revoked" || scenario == "revoked-request" {
				f.d.perTurnEffortCallback(f.run.TaskID)(false)
			}
			if scenario == "revoked-request" {
				resp := f.request(t, 3, `,"tools":[{"name":"Bash","is_error":true}],"error_text":""`)
				if resp.Enabled == nil || *resp.Enabled {
					t.Fatalf("not revoked: %+v", resp)
				}
			}
			_, outcomes := pairedStepSamples(t, f.records(t))
			if len(outcomes) != 2 {
				t.Fatalf("outcomes=%v", outcomes)
			}
			want := map[string]any{"tools": nil, "action_kind": nil, "outcome_ok": nil, "error_sig": nil,
				"prev_action_kind": "read_only", "prev_outcome_ok": true, "next_outcome_ok": nil, "repeated_error_next": nil}
			if scenario == "no-tools" {
				want["tools"], want["action_kind"], want["outcome_ok"], want["error_sig"] = []any{}, "final_text", true, ""
			}
			if scenario == "revoked-request" {
				want["tools"], want["action_kind"], want["outcome_ok"], want["error_sig"] = []any{"Bash"}, "edit_or_exec", false, ""
			}
			assertStepFields(t, outcomes[2], want)
			assertStepFields(t, outcomes[1], map[string]any{"action_kind": "read_only", "outcome_ok": true, "next_outcome_ok": want["outcome_ok"]})
			// A handler that fetched the run before removal cannot add an
			// unpaired decision after terminal flushing.
			resp := f.run.decide(context.Background(), thinkingDecisionRequest{Step: 4})
			if resp.Enabled == nil || *resp.Enabled {
				t.Fatalf("finished run accepted request: %+v", resp)
			}
		})
	}
}

func TestRunTaskFlushesStepOutcomesOnInterruption(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake CLI")
	}
	for _, scenario := range []string{"cancelled", "timeout"} {
		t.Run(scenario, func(t *testing.T) {
			stubModelDiscovery(t, map[string]agent.Catalog{"claude": adaptTestCatalog()})
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			jevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, `{"answers":{"effort":{"choice":"high","confidence":0.9,"probabilities":{"high":0.9,"low":0.1}}}}`)
			}))
			defer jevServer.Close()
			var d *Daemon
			var once sync.Once
			var decided bool
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/messages") {
					once.Do(func() {
						run, ok := d.stepEffort.get("interrupted-step")
						if !ok {
							t.Error("runTask did not register step effort")
							return
						}
						// Cancel/timeout after a successful decision but before
						// its effect or next request can supply any results.
						decided = run.decide(r.Context(), thinkingDecisionRequest{Step: 1}).Level == "high"
						if scenario == "cancelled" {
							cancel()
						}
					})
				}
				fmt.Fprint(w, `{}`)
			}))
			defer srv.Close()
			fake := filepath.Join(t.TempDir(), "claude")
			writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo '2.1.304'; exit 0;; esac
IFS= read -r _
printf '%s\n' '{"type":"system","subtype":"init","per_turn_effort_active":true}'
printf '%s\n' '{"type":"assistant","message":{"id":"ready","content":[{"type":"text","text":"ready"}]}}'
exec sleep 60
`))
			dir := t.TempDir()
			collector := jevsample.New(dir, "interrupted-step", "", 0, quietTaskLog())
			d = &Daemon{client: NewClient(srv.URL), jevClient: jev.New(jev.Options{
				Sources: []jev.Source{{Name: "fake", BaseURL: jevServer.URL, Model: "test"}}}),
				jevSamples: collector, logger: quietTaskLog(),
				agentVersions: map[string]string{"claude": "2.1.304"},
				workspaces:    map[string]*workspaceState{}, activeEnvRoots: map[string]int{},
				cfg: Config{WorkspacesRoot: t.TempDir(), AgentTimeout: time.Second, ServerBaseURL: srv.URL,
					Agents: map[string]AgentEntry{"claude": {Path: fake}}},
			}
			task := Task{ID: "interrupted-step", WorkspaceID: "ws", RuntimeID: "rt", IssueID: "issue", AgentID: "agent", AuthToken: "mat_sample_test",
				Agent: &AgentData{ID: "agent", Name: "test", Model: "test/model", ThinkingLevel: agent.ThinkingLevelAdapt}}
			result, err := d.runTask(ctx, task, "claude", 0, quietTaskLog())
			collector.Close()
			srv.Close() // Join handlers before reading their observations.
			if !decided {
				t.Fatal("interruption did not reach a step decision")
			}
			if err == nil && result.Status == "completed" {
				t.Fatalf("expected interrupted run: %+v", result)
			}
			if _, ok := d.stepEffort.get(task.ID); ok {
				t.Fatal("finished step run was retained")
			}
			files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
			if err != nil || len(files) != 1 {
				t.Fatalf("files=%v err=%v", files, err)
			}
			var stepRecords []map[string]any
			for _, record := range sampleRecords(t, files[0]) {
				if record["scope"] == "step" {
					stepRecords = append(stepRecords, record)
				}
			}
			_, outcomes := pairedStepSamples(t, stepRecords)
			if len(outcomes) != 1 {
				t.Fatalf("interrupted decision lost its outcome: %v", outcomes)
			}
			assertStepFields(t, outcomes[1], map[string]any{"tools": nil, "action_kind": nil, "outcome_ok": nil,
				"error_sig": nil, "prev_outcome_ok": nil, "next_outcome_ok": nil, "repeated_error_next": nil})
		})
	}
}

func TestStepOutcomesToolClassification(t *testing.T) {
	for _, name := range []string{"Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead", "Bash", "Task", "mcp__read", "read", "Unknown", ""} {
		t.Run(name, func(t *testing.T) {
			f := newStepSampleFixture(t)
			f.request(t, 1, "")
			f.request(t, 2, fmt.Sprintf(`,"tools":[{"name":"Read"},{"name":%q,"is_error":true}]`, name))
			_, outcomes := pairedStepSamples(t, f.records(t))
			kind := "edit_or_exec"
			switch name {
			case "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead":
				kind = "read_only"
			}
			assertStepFields(t, outcomes[1], map[string]any{"tools": []any{"Read", name}, "action_kind": kind, "outcome_ok": false})
		})
	}
}

func TestStepOutcomesCollectionDisabled(t *testing.T) {
	d, run := newStepEffortTestDaemon(t)
	root := t.TempDir()
	t.Chdir(root)
	t.Setenv("MULTICA_JEV_COLLECT_DIR", "")
	run.Samples = jevsample.New(os.Getenv("MULTICA_JEV_COLLECT_DIR"), "step-test", "", 0, quietTaskLog())
	run.Clients = &fakeStepDecider{decision: jev.Decision{Level: "high"}}
	d.setStepEffortEnabled(run.TaskID, true)
	f := &stepSampleFixture{d: d, run: run}
	f.request(t, 1, "")
	f.request(t, 2, `,"tools":[{"name":"Read"}]`)
	d.stepEffort.remove(run.TaskID)
	if run.steps != nil {
		t.Fatalf("disabled collection retained history: %v", run.steps)
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Fatalf("disabled collection touched disk: %v, %v", entries, err)
	}
}

type cancellingStepDecider struct{ started chan struct{} }

func (d *cancellingStepDecider) Decide(ctx context.Context, _ jev.Request) (jev.Decision, error) {
	close(d.started)
	<-ctx.Done()
	// Model a response that won the cancellation race: even this late
	// successful decision must be paired before the run disappears.
	return jev.Decision{Level: "high"}, nil
}

func TestStepOutcomesFinishWaitsForInflightDecision(t *testing.T) {
	f := newStepSampleFixture(t)
	decider := &cancellingStepDecider{started: make(chan struct{})}
	f.run.Clients = decider
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	decisionDone := make(chan struct{})
	go func() {
		defer close(decisionDone)
		f.run.decide(ctx, thinkingDecisionRequest{Step: 1})
	}()
	<-decider.started
	removed := make(chan struct{})
	go func() { defer close(removed); f.d.stepEffort.remove(f.run.TaskID) }()
	cancel()
	<-decisionDone
	<-removed
	_, outcomes := pairedStepSamples(t, f.records(t))
	if len(outcomes) != 1 {
		t.Fatalf("late decision lost: %v", outcomes)
	}
	assertStepFields(t, outcomes[1], map[string]any{"tools": nil, "action_kind": nil, "outcome_ok": nil, "error_sig": nil})
}
