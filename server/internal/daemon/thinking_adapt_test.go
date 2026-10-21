package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestDaemonAdvertisesThinkingAdapt(t *testing.T) {
	for _, capabilities := range []string{daemonClientCapabilities(), daemonHTTPClientCapabilities()} {
		if !strings.Contains(","+capabilities+",", ","+protocol.DaemonCapabilityThinkingAdaptV1+",") {
			t.Fatal("missing adaptive-thinking capability")
		}
	}
}

type countingThinkingClient struct {
	calls    int
	request  jev.Request
	decision jev.Decision
	err      error
}

func (c *countingThinkingClient) Decide(_ context.Context, request jev.Request) (jev.Decision, error) {
	c.calls++
	c.request = request
	return c.decision, c.err
}

func adaptTestCatalog() agent.Catalog {
	return agent.Catalog{Models: []agent.Model{
		{ID: "test/model", Default: true, Thinking: &agent.ModelThinking{SupportedLevels: []agent.ThinkingLevel{
			{Value: "auto"}, {Value: "off"}, {Value: "low", Label: "Low"}, {Value: "high", Label: "High"}, {Value: "max"},
		}}},
		{ID: "other/model", Thinking: &agent.ModelThinking{SupportedLevels: []agent.ThinkingLevel{{Value: "minimal"}, {Value: "ultra"}}}},
	}}
}

func TestThinkingSelectionModes(t *testing.T) {
	for _, mode := range []string{"", "high", agent.ThinkingLevelAdapt} {
		t.Run(mode, func(t *testing.T) {
			reads := stubModelDiscovery(t, map[string]agent.Catalog{"claude": adaptTestCatalog()})
			client := &countingThinkingClient{decision: jev.Decision{Level: "high", Confidence: .9, Source: "fake"}}
			run := &thinkingRun{Client: client, Task: Task{ID: "private-task", ThreadName: "Investigate a race"}}
			sel := resolveTaskModelSelection(context.Background(), "claude", agent.Command{}, taskModelSelection{Model: "test/model", ThinkingLevel: mode}, quietTaskLog(), run)
			if mode != agent.ThinkingLevelAdapt {
				if client.calls != 0 || !reflect.DeepEqual(client.request, jev.Request{}) || sel.ThinkingLevel != mode {
					t.Fatalf("non-adaptive path called Jev or changed selection: %+v %+v", client, sel)
				}
				if mode == "" && (reads() != 0 || run.Record != nil) {
					t.Fatal("follow-config constructed thinking state")
				}
				if mode != "" && (run.Record.Mode != "fixed" || !reflect.DeepEqual(run.Record.Request, jev.Request{})) {
					t.Fatal("fixed mode constructed criteria")
				}
				return
			}
			if client.calls != 1 || reads() != 1 || sel.ThinkingLevel != "high" {
				t.Fatalf("adaptive selection: %+v, calls %d, reads %d", sel, client.calls, reads())
			}
			var values []string
			for _, option := range client.request.Options {
				values = append(values, option.Value)
			}
			if !reflect.DeepEqual(values, []string{"low", "high", "max"}) {
				t.Fatalf("wrong model candidates: %v", values)
			}
			if run.Record.Trace != (ThinkingDecisionTrace{TaskID: "private-task", Scope: "run", Provider: "claude", Model: "test/model"}) {
				t.Fatal("missing local trace")
			}
			if strings.Contains(client.request.State.(string), "private-task") {
				t.Fatal("task ID leaked into state")
			}
		})
	}
}

func TestThinkingSelectionNoCandidates(t *testing.T) {
	for _, tc := range []struct {
		name, provider, model string
		catalog               agent.Catalog
	}{
		{"unverified", "claude", "test/model", agent.Catalog{Fallback: true, Models: adaptTestCatalog().Models}},
		{"empty", "claude", "test/model", agent.Catalog{}},
		{"one valid candidate", "claude", "test/model", agent.Catalog{Models: []agent.Model{{ID: "test/model", Thinking: &agent.ModelThinking{
			SupportedLevels: []agent.ThinkingLevel{{Value: "auto"}, {Value: "off"}, {Value: "high"}},
		}}}}},
		{"missing model", "claude", "missing", adaptTestCatalog()},
		{"codex default unknown", "codex", "", adaptTestCatalog()},
		{"omp default unknown", "omp", "", adaptTestCatalog()},
		{"old CLI", "claude", "test/model", agent.Catalog{Models: adaptTestCatalog().Models, CLIThinkingLevels: []string{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads := stubModelDiscovery(t, map[string]agent.Catalog{tc.provider: tc.catalog})
			client := &countingThinkingClient{}
			run := &thinkingRun{Client: client}
			sel := resolveTaskModelSelection(context.Background(), tc.provider, agent.Command{}, taskModelSelection{Model: tc.model, ThinkingLevel: agent.ThinkingLevelAdapt}, quietTaskLog(), run)
			if sel.ThinkingLevel != "" || client.calls != 0 || run.Record.Fallback != "no_candidates" {
				t.Fatalf("selection=%+v calls=%d record=%+v", sel, client.calls, run.Record)
			}
			if tc.model == "" && reads() != 0 {
				t.Fatal("unknown default should not discover a catalog")
			}
		})
	}
}

func TestThinkingInvalidChoiceAndFallbacks(t *testing.T) {
	for _, reason := range []string{"timeout", "error", "invalid", "breaker", "disabled", "outside", "reserved"} {
		t.Run(reason, func(t *testing.T) {
			stubModelDiscovery(t, map[string]agent.Catalog{"claude": adaptTestCatalog()})
			client := &countingThinkingClient{decision: jev.Decision{Level: "high"}, err: &jev.FallbackError{Reason: jev.FallbackReason(reason)}}
			want := reason
			if reason == "outside" || reason == "reserved" {
				client.err = nil
				client.decision.Level = "ultra"
				if reason == "reserved" {
					client.decision.Level = agent.ThinkingLevelAdapt
				}
				want = "invalid"
			}
			run := &thinkingRun{Client: client}
			sel := resolveTaskModelSelection(context.Background(), "claude", agent.Command{}, taskModelSelection{Model: "test/model", ThinkingLevel: agent.ThinkingLevelAdapt}, quietTaskLog(), run)
			if sel.ThinkingLevel != "" || run.Record.Fallback != want || run.Record.Decision.Level != "" {
				t.Fatalf("injected fallback: %+v %+v", sel, run.Record)
			}
			metadata := run.Record.metadata()
			if level, exists := metadata["level"]; !exists || level != "" {
				t.Fatalf("missing empty level: %v", metadata)
			}
		})
	}
}

func TestThinkingStatePrivacyAndBounds(t *testing.T) {
	secret := "sk-" + strings.Repeat("a", 40)
	task := Task{ID: "private-task-id", ThreadName: "title", IssueDescription: strings.Repeat("界", 1600) + secret, TriggerCommentContent: "Previous fix failed " + secret,
		WorkspaceContext: "PRIVATE WORKSPACE", AuthToken: "PRIVATE AUTH", Agent: &AgentData{Instructions: "PRIVATE INSTRUCTIONS", CustomEnv: map[string]string{"PRIVATE ENV": secret}}}
	state := BuildRunThinkingState(task, "claude", "test/model")
	for _, bad := range []string{secret, "PRIVATE", "private-task-id"} {
		if strings.Contains(state, bad) {
			t.Fatalf("leaked %s", bad)
		}
	}
	if len(state) > 4096 || !utf8.ValidString(state) || !json.Valid([]byte(state)) {
		t.Fatalf("invalid bounded state (%d bytes)", len(state))
	}
	if !strings.Contains(state, "Previous fix failed") || !strings.Contains(state, "REDACTED") {
		t.Fatal("lost short trigger evidence")
	}
	for _, tc := range []struct {
		task          Task
		kind, content string
	}{
		{Task{ChatSessionID: "chat", ChatMessage: "chat goal"}, "chat", "chat goal"},
		{Task{AutopilotRunID: "auto", AutopilotTitle: "scheduled", AutopilotDescription: "auto goal"}, "automation", "auto goal"},
	} {
		state := BuildRunThinkingState(tc.task, "pi", "model")
		if !strings.Contains(state, tc.kind) || !strings.Contains(state, tc.content) {
			t.Fatal(state)
		}
	}
	step := BuildStepThinkingState(StepThinkingInput{Goal: strings.Repeat("界", 1000), AssistantText: strings.Repeat("字", 1000), ToolResult: secret + "\n" + strings.Repeat("X", 1000) + "\nDATA RACE", Step: 3, RepeatedErrors: 2})
	if len(step) > 4096 || !json.Valid([]byte(step)) || strings.Contains(step, secret) || !strings.Contains(step, "DATA RACE") {
		t.Fatal("step state lost tail, bound or redaction")
	}
	if state := BuildStepThinkingState(StepThinkingInput{FileContent: true, ToolResult: "whole file body"}); strings.Contains(state, "whole file body") {
		t.Fatal("file contents left daemon")
	}
	if got := thinkingPrefix("prefix "+secret, 20); strings.Contains(got, "sk-") {
		t.Fatal("redaction ran after truncation")
	}
}

func TestThinkingStateOrderAndTailTruncation(t *testing.T) {
	trigger := strings.Repeat("错", 1000)
	run := BuildRunThinkingState(Task{ThreadName: "title", TriggerCommentContent: trigger, IssueDescription: strings.Repeat("文", 1500)}, "claude", "model")
	wantPrefix := `{"kind":"task","provider":"claude","model":"model","title":"title","trigger_comment":"` + trigger + `","description":"`
	if !strings.HasPrefix(run, wantPrefix) {
		t.Fatal("run state reordered fields or truncated trigger before description")
	}
	step := BuildStepThinkingState(StepThinkingInput{
		Step: 9, ToolName: "exec_command", ToolIsError: true, ExitCode: 1, ErrorFeatures: "DATA RACE scheduler.go", RepeatedErrors: 2,
		ToolInputSummary: "go test -race ./...", ToolResult: strings.Repeat("首", 400) + strings.Repeat("尾", 400),
		AssistantText: strings.Repeat("助", 500), Goal: strings.Repeat("目", 500),
	})
	wantPrefix = `{"step":9,"tool":"exec_command","is_error":true,"exit_code":1,"error_features":"DATA RACE scheduler.go","repeated_errors":2,"tool_input_summary":"go test -race ./...","result_head":"` + strings.Repeat("首", 400) + `","result_tail":"` + strings.Repeat("尾", 400) + `","assistant":"`
	if !strings.HasPrefix(step, wantPrefix) {
		t.Fatal("step state reordered fields or truncated error evidence before trailing text")
	}
	for _, state := range []string{run, step} {
		var fields map[string]any
		if len(state) > 4096 || !utf8.ValidString(state) || json.Unmarshal([]byte(state), &fields) != nil {
			t.Fatalf("invalid bounded state (%d bytes)", len(state))
		}
		if fields["step"] != nil && fields["goal"] != "" {
			t.Fatal("long goal should be removed before assistant text is shortened")
		}
	}
	// Escaping can expand one character to six JSON bytes; the bound is on
	// encoded UTF-8 bytes, not the original character count.
	escaped := BuildRunThinkingState(Task{TriggerCommentContent: strings.Repeat("<", 1000), IssueDescription: strings.Repeat("界", 1500)}, "claude", "model")
	if len(escaped) > 4096 || !json.Valid([]byte(escaped)) {
		t.Fatal("escaped state exceeded byte bound")
	}
}

func TestThinkingMetadataBoundaries(t *testing.T) {
	decision := jev.Decision{Level: "high", Confidence: .9, Probabilities: map[string]float64{"high": .9}, LatencyMS: 123, Source: "fake"}
	for _, tc := range []struct {
		name   string
		record *ThinkingDecisionRecord
		want   map[string]any
	}{
		{"adapt", &ThinkingDecisionRecord{Mode: "adapt", Decision: decision}, map[string]any{
			"mode": "adapt", "level": "high", "confidence": .9, "probabilities": map[string]float64{"high": .9}, "latency_ms": int64(123), "source": "fake",
		}},
		{"fallback", &ThinkingDecisionRecord{Mode: "adapt", Fallback: "timeout", Decision: jev.Decision{LatencyMS: 123}}, map[string]any{
			"mode": "adapt", "level": "", "fallback": "timeout", "latency_ms": int64(123),
		}},
		{"no_candidates", &ThinkingDecisionRecord{Mode: "adapt", Fallback: "no_candidates"}, map[string]any{
			"mode": "adapt", "level": "", "fallback": "no_candidates",
		}},
		{"fixed", &ThinkingDecisionRecord{Mode: "fixed", Decision: decision}, map[string]any{"mode": "fixed", "level": "high"}},
		{"follow", nil, nil},
	} {
		for _, stream := range []string{"request IDs", "no request IDs"} {
			t.Run(tc.name+"/"+stream, func(t *testing.T) {
				run := &thinkingRun{Record: tc.record}
				existing := map[string]any{"other": "retained"}
				messages := []agent.Message{
					{Type: agent.MessageStatus}, {Type: agent.MessageText},
					{Type: agent.MessageText, Content: "first", ModelRequestID: "one", Metadata: existing},
					{Type: agent.MessageText, Content: "same request split", ModelRequestID: "one"},
					{Type: agent.MessageToolUse, Tool: "read", ModelRequestID: "child", ParentToolUseID: "parent"},
					{Type: agent.MessageText, Content: "next request", ModelRequestID: "two"},
					{Type: agent.MessageThinking, Content: "thinking", ModelRequestID: "two"},
					{Type: agent.MessageThinking, Content: "more thinking", ModelRequestID: "two"},
					{Type: agent.MessageToolResult, Output: "done"},
				}
				wantTagged := map[int]bool{2: true, 5: true, 6: true, 7: true}
				if stream == "no request IDs" {
					// Codex has neither request IDs nor thinking messages. Only its
					// first visible message carries the run-level decision.
					messages = []agent.Message{
						{Type: agent.MessageStatus}, {Type: agent.MessageText},
						{Type: agent.MessageText, Content: "first", Metadata: existing},
						{Type: agent.MessageText, Content: "working"},
						{Type: agent.MessageToolUse, Tool: "read"},
						{Type: agent.MessageToolResult, Output: "done"},
						{Type: agent.MessageText, Content: "finished"},
					}
					wantTagged = map[int]bool{2: true}
				}
				for i, message := range messages {
					got := run.tag(message)
					_, tagged := got.Metadata["thinking"]
					want := tc.want != nil && wantTagged[i]
					if tagged != want {
						t.Fatalf("message %d tagged=%v want=%v", i, tagged, want)
					}
					if want && !reflect.DeepEqual(got.Metadata["thinking"], tc.want) {
						t.Fatalf("message %d thinking=%+v want=%+v", i, got.Metadata["thinking"], tc.want)
					}
					if i == 2 && got.Metadata["other"] != "retained" {
						t.Fatal("metadata overwritten")
					}
				}
				if _, mutated := existing["thinking"]; mutated {
					t.Fatal("mutated backend-owned metadata")
				}
			})
		}
	}
}

// This crosses the actual daemon, Jev HTTP client, CLI launch, transcript batch
// transport and terminal result conversion. Every failure still finishes work.
func TestRunTaskAdaptiveThinkingFailOpenAndRetry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake CLI")
	}
	for _, scenario := range []string{"success", "retry", "timeout", "5xx", "invalid", "breaker", "disabled", "fixed", "follow"} {
		t.Run(scenario, func(t *testing.T) {
			stubModelDiscovery(t, map[string]agent.Catalog{"claude": adaptTestCatalog()})
			var calls atomic.Int32
			jevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				switch scenario {
				case "timeout":
					select {
					case <-r.Context().Done():
					case <-time.After(1700 * time.Millisecond):
					}
					return
				case "5xx", "breaker":
					w.WriteHeader(503)
					return
				case "invalid":
					fmt.Fprint(w, `{"answers":{"effort":{"choice":"ultra"}}}`)
					return
				}
				fmt.Fprint(w, `{"answers":{"effort":{"choice":"high","confidence":0.9,"probabilities":{"high":0.9,"low":0.1}}}}`)
			}))
			defer jevServer.Close()
			client := jev.New(jev.Options{Disabled: scenario == "disabled", Sources: []jev.Source{{Name: "fake", BaseURL: jevServer.URL, Model: "test"}}})
			if scenario == "breaker" {
				for range 3 {
					_, _ = client.Decide(context.Background(), ThinkingRequest("probe", adaptTestCatalog().Models[0].Thinking.SupportedLevels))
				}
				calls.Store(0)
			}
			var mu sync.Mutex
			var messages []TaskMessageData
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/messages") {
					var batch struct {
						Messages []TaskMessageData `json:"messages"`
					}
					if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
						t.Error(err)
					}
					mu.Lock()
					messages = append(messages, batch.Messages...)
					mu.Unlock()
				}
				fmt.Fprint(w, `{}`)
			}))
			defer srv.Close()
			capture := filepath.Join(t.TempDir(), "argv")
			fake := filepath.Join(t.TempDir(), "claude")
			writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo '2.1.304'; exit 0;; esac
printf '%s\n' "$*" >> "$CAPTURE_FILE"
IFS= read -r _
case "$*" in *--resume*) printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"No conversation found with session ID old"}'; exit 0;; esac
printf '%s\n' '{"type":"assistant","message":{"id":"one","content":[{"type":"text","text":"working"},{"type":"thinking","thinking":"reasoning"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"old","result":"done"}'
`))
			d := &Daemon{client: NewClient(srv.URL), jevClient: client, logger: quietTaskLog(),
				workspaces: map[string]*workspaceState{}, runtimeIndex: map[string]Runtime{"rt": {ID: "rt", Provider: "claude"}}, activeEnvRoots: map[string]int{},
				cfg: Config{WorkspacesRoot: t.TempDir(), AgentTimeout: 5 * time.Second, ServerBaseURL: srv.URL, Agents: map[string]AgentEntry{"claude": {Path: fake}}},
			}
			task := Task{ID: "test-task", WorkspaceID: "test-ws", RuntimeID: "rt", IssueID: "issue", AgentID: "agent", AuthToken: "mat_thinking_test",
				Agent: &AgentData{ID: "agent", Name: "test", Model: "test/model", ThinkingLevel: agent.ThinkingLevelAdapt, CustomEnv: map[string]string{"CAPTURE_FILE": capture}},
			}
			if scenario == "fixed" {
				task.Agent.ThinkingLevel = "high"
			}
			if scenario == "follow" {
				task.Agent.ThinkingLevel = ""
			}
			if scenario == "retry" {
				task.Agent.ThinkingLevel = ""
				first, err := d.runTask(t.Context(), task, "claude", 0, quietTaskLog())
				if err != nil || first.Status != "completed" {
					t.Fatalf("prepare prior session: %+v %v", first, err)
				}
				task.Agent.ThinkingLevel = agent.ThinkingLevelAdapt
				task.ID = "retry-task"
				task.PriorSessionID, task.PriorWorkDir = first.SessionID, first.WorkDir
				if err := os.WriteFile(capture, nil, 0600); err != nil {
					t.Fatal(err)
				}
				mu.Lock()
				messages = nil
				mu.Unlock()
			}
			started := time.Now()
			runState := &thinkingRun{}
			ctx := context.WithValue(t.Context(), thinkingRunKey{}, runState)
			result, err := d.runTask(ctx, task, "claude", 0, quietTaskLog())
			if err != nil || result.Status != "completed" || result.Comment != "done" {
				t.Fatalf("run failed: %+v %v", result, err)
			}
			if scenario == "timeout" && time.Since(started) < jev.DefaultTimeout {
				t.Fatal("did not exercise the 1.5s timeout")
			}
			if scenario != "follow" && runState.Record == nil {
				t.Fatal("decision lost at terminal handling")
			}
			if task.Agent.ThinkingLevel == agent.ThinkingLevelAdapt && runState.Record.Trace.TaskID != task.ID {
				t.Fatal("decision trace lost at terminal handling")
			}
			wantCalls := int32(1)
			if scenario == "disabled" || scenario == "breaker" || scenario == "fixed" || scenario == "follow" {
				wantCalls = 0
			}
			if calls.Load() != wantCalls {
				t.Fatalf("Jev calls=%d want=%d", calls.Load(), wantCalls)
			}
			raw, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			argv := string(raw)
			if scenario == "retry" && (strings.Count(argv, "--effort high") != 2 || result.RetiredSessionID != "old") {
				t.Fatalf("retry did not reuse decision: %s result=%+v", argv, result)
			}
			if strings.Contains(argv, agent.ThinkingLevelAdapt) {
				t.Fatal("reserved mode reached CLI")
			}
			injected := scenario == "success" || scenario == "retry" || scenario == "fixed"
			if strings.Contains(argv, "--effort high") != injected {
				t.Fatalf("incorrect injection: %s", argv)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(messages) == 0 {
				t.Fatal("no transcript")
			}
			for _, message := range messages {
				if message.Seq != 1 && message.Type != "thinking" {
					continue
				}
				thinking, exists := message.Metadata["thinking"].(map[string]any)
				if scenario == "follow" {
					if exists {
						t.Fatal("follow-config tagged")
					}
					continue
				}
				if !exists {
					t.Fatalf("missing thinking metadata: %+v", message)
				}
				if scenario == "fixed" {
					if !reflect.DeepEqual(thinking, map[string]any{"mode": "fixed", "level": "high"}) {
						t.Fatalf("fixed metadata includes adaptive fields: %+v", thinking)
					}
					continue
				}
				if thinking["mode"] != "adapt" {
					t.Fatalf("wrong adaptive mode: %+v", thinking)
				}
				if injected && thinking["source"] != "fake" {
					t.Fatalf("missing decision source: %+v", thinking)
				}
				if injected && thinking["level"] != "high" {
					t.Fatal(thinking)
				}
				if !injected {
					wantFallback := scenario
					if scenario == "5xx" {
						wantFallback = "error"
					}
					if level, exists := thinking["level"]; !exists || level != "" || thinking["fallback"] != wantFallback {
						t.Fatal(thinking)
					}
					for _, field := range []string{"source", "confidence", "probabilities"} {
						if _, exists := thinking[field]; exists {
							t.Fatalf("fallback contains an unavailable decision field %s: %+v", field, thinking)
						}
					}
				}
			}
		})
	}
}

func TestResolveTaskModelSelectionAdaptNeverReachesExecution(t *testing.T) {
	original := listModels
	t.Cleanup(func() { listModels = original })
	for _, discovery := range []string{"verified", "fallback", "error"} {
		for _, provider := range []string{"claude", "codex", "pi", "omp", "opencode", "deveco", "kimi", "dsh", "grok", "codebuddy", "reasonix", "hermes", "dim"} {
			t.Run(discovery+"/"+provider, func(t *testing.T) {
				listModels = func(context.Context, string, agent.Command) (agent.Catalog, error) {
					if discovery == "error" {
						return agent.Catalog{}, errors.New("discovery unavailable")
					}
					return agent.Catalog{
						Fallback: discovery == "fallback",
						Models: []agent.Model{{ID: "test/model", Thinking: &agent.ModelThinking{
							SupportedLevels: []agent.ThinkingLevel{{Value: agent.ThinkingLevelAdapt}, {Value: "high"}},
						}}},
					}, nil
				}
				var logs bytes.Buffer
				log := slog.New(slog.NewTextHandler(&logs, nil))
				for _, model := range []string{"", "test/model"} {
					// This is the selection copied into the shared agent.Config for
					// both CLI flags and ACP session configuration.
					got := resolveTaskModelSelection(context.Background(), provider, agent.Command{},
						taskModelSelection{Model: model, ThinkingLevel: agent.ThinkingLevelAdapt}, log, nil)
					if got.ThinkingLevel != "" {
						t.Fatalf("execution received reserved mode: %+v", got)
					}
				}
				if !strings.Contains(logs.String(), "level=INFO") || !strings.Contains(logs.String(), "following CLI config") {
					t.Fatalf("missing adaptive fallback info log: %s", logs.String())
				}
			})
		}
	}
}

func TestResolveTaskModelSelectionAdaptKeepsServiceTier(t *testing.T) {
	reads := stubModelDiscovery(t, thinkingCatalogs())
	got := resolveTaskModelSelection(context.Background(), "codex", agent.Command{},
		taskModelSelection{Model: "gpt-5.6-sol", ThinkingLevel: agent.ThinkingLevelAdapt, ServiceTier: "priority"}, quietTaskLog(), nil)
	if got.ThinkingLevel != "" || got.ServiceTier != "priority" || got.Model != "gpt-5.6-sol" || reads() != 1 {
		t.Fatalf("adaptive fallback changed model/service tier: %+v, reads %d", got, reads())
	}
}
