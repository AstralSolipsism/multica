//go:build !windows

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Every agy stream in this file is synthetic: invented conversation IDs, step
// indices, text and usage, written by a fake agy executable and read by the
// real backend. None of it is a captured agy stream, and no test runs a real
// agy or reads production data.

const (
	agyFixtureConversation = "fixture-conversation"
	agyFixtureAnswer       = "Current answer.\n"
	agyFixtureRecoveryLog  = "agy reported an error after this turn's answer completed"
	// The wording of the stale error in OL-1074's resumed turns.
	agyIdleTimeoutError = "API error (attempt 4): request failed: stream idle timeout (5m0s): context deadline exceeded"
)

// A resumed conversation can replay an earlier turn, including its answer, a
// tool and the error that turn ended with, before this turn's boundary.
var agyFixtureHistory = []string{
	`{"step_index":90,"state":"DONE","step_type":"agent_response","text_delta":"Historical answer.\n","usage":{"input_tokens":9000,"output_tokens":900}}`,
	`{"step_index":91,"state":"DONE","step_type":"tool","tool_name":"read_file","usage":{"input_tokens":2000}}`,
	`{"step_index":95,"state":"DONE","step_type":"error_message"}`,
}

const (
	agyFixtureBoundary     = `{"step_index":100,"state":"DONE","step_type":"user_input"}`
	agyFixtureToolActive   = `{"step_index":102,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"go test ./..."}}}`
	agyFixtureToolDone     = `{"step_index":102,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"output":"ok"},"usage":{"input_tokens":30,"output_tokens":3}}`
	agyFixtureAnswerActive = `{"step_index":104,"state":"ACTIVE","step_type":"agent_response","text_delta":"Current "}`
	agyFixtureAnswerDone   = `{"step_index":104,"state":"DONE","step_type":"agent_response","text_delta":"answer.\n","usage":{"input_tokens":20,"output_tokens":5,"cache_read_tokens":7}}`
	agyFixtureCheckpoint   = `{"step_index":105,"state":"DONE","step_type":"checkpoint"}`
)

// agyFixtureTurnUsage is the completed tool and answer of agyFixtureTurn.
var agyFixtureTurnUsage = TokenUsage{InputTokens: 50, OutputTokens: 8, CacheReadTokens: 7}

// agyFixtureTurn is this turn's boundary, a tool and the answer, then extra.
func agyFixtureTurn(extra ...string) []string {
	return append([]string{agyFixtureBoundary, agyFixtureToolActive, agyFixtureToolDone, agyFixtureAnswerActive, agyFixtureAnswerDone}, extra...)
}

func agyFixtureSteps(groups ...[]string) []string {
	var steps []string
	for _, group := range groups {
		steps = append(steps, group...)
	}
	return steps
}

type agyRun struct {
	init         string   // raw init line replacing the default one
	noInit       bool     // emit no init event at all
	steps        []string // step_update payloads in arrival order
	beforeResult []string // raw stdout lines between the steps and the result
	afterResult  []string
	status       string  // result.status; ERROR when empty
	err          string  // result.error
	response     *string // result.response; agyFixtureAnswer when nil
	log          string  // one line agy writes to --log-file
	exit         int
	kill         bool
	fresh        bool
}

type agyRunOutput struct {
	result    Result
	streamed  string
	tools     []Message
	recovered []map[string]any // recovery warnings, decoded from JSON logs
}

func agyString(value string) *string { return &value }

func runAgyFixture(t *testing.T, run agyRun) agyRunOutput {
	t.Helper()
	status := run.status
	if status == "" {
		status = "ERROR"
	}
	response := agyFixtureAnswer
	if run.response != nil {
		response = *run.response
	}
	var stream strings.Builder
	switch {
	case run.noInit:
	case run.init != "":
		stream.WriteString(run.init + "\n")
	default:
		fmt.Fprintf(&stream, "{\"event\":\"init\",\"conversation_id\":%q,\"init\":{\"model\":\"fixture-model\"}}\n", agyFixtureConversation)
	}
	for _, step := range run.steps {
		fmt.Fprintf(&stream, "{\"event\":\"step_update\",\"step_update\":%s}\n", step)
	}
	for _, line := range run.beforeResult {
		stream.WriteString(line + "\n")
	}
	result, err := json.Marshal(map[string]any{"event": "result", "result": map[string]any{
		"conversation_id": agyFixtureConversation, "status": status, "error": run.err, "response": response,
		// Conversation-wide usage that must never replace this turn's steps.
		"usage": map[string]int{"input_tokens": 99999, "output_tokens": 9999},
	}})
	if err != nil {
		t.Fatal(err)
	}
	stream.Write(append(result, '\n'))
	for _, line := range run.afterResult {
		stream.WriteString(line + "\n")
	}

	script := "#!/bin/sh\n"
	if run.log != "" {
		script += "while [ $# -gt 0 ]; do\n  case \"$1\" in\n    --log-file) printf '%s\\n' '" + run.log + "' > \"$2\"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\n"
	}
	script += "cat <<'JSONL'\n" + stream.String() + "JSONL\n"
	if run.kill {
		script += "kill -KILL $$\n"
	}
	script += fmt.Sprintf("exit %d\n", run.exit)
	fakePath := filepath.Join(t.TempDir(), "agy")
	writeTestExecutable(t, fakePath, []byte(script))

	logs := &syncBuffer{}
	backend, err := New("antigravity", Config{
		ExecutablePath: fakePath,
		Logger:         slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelWarn})),
	})
	if err != nil {
		t.Fatal(err)
	}
	opts := ExecOptions{ResumeSessionID: agyFixtureConversation}
	if run.fresh {
		opts.ResumeSessionID = ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := backend.Execute(ctx, "synthetic prompt", opts)
	if err != nil {
		t.Fatal(err)
	}
	var out agyRunOutput
	var streamed strings.Builder
	for msg := range session.Messages {
		switch msg.Type {
		case MessageText:
			streamed.WriteString(msg.Content)
		case MessageToolUse, MessageToolResult:
			out.tools = append(out.tools, msg)
		}
	}
	out.result = <-session.Result
	out.streamed = streamed.String()
	for _, line := range strings.Split(logs.String(), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log line %q: %v", line, err)
		}
		if record["msg"] == agyFixtureRecoveryLog {
			out.recovered = append(out.recovered, record)
		}
	}
	return out
}

// OL-1074: a resumed turn answered completely, yet agy's result repeats an
// error recorded earlier in the conversation. Whatever that error says, this
// turn's steps decide, and the warning keeps the original text.
func TestAntigravityTurnEvidenceOverridesStaleError(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, err string
		exit      int
	}{
		{name: "OL-910 interruption", err: "The stream was interrupted. Please continue the task you were working on.", exit: 1},
		{name: "legacy network sentence", err: antigravityNetworkIssueError, exit: 1},
		{name: "stream idle timeout", err: agyIdleTimeoutError, exit: 3},
		{name: "quota", err: "RESOURCE_EXHAUSTED (code 429): Individual quota reached for this model.", exit: 1},
		{name: "unknown wording", err: "synthetic failure the adapter has never seen", exit: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			out := runAgyFixture(t, agyRun{
				steps: agyFixtureSteps(agyFixtureHistory, agyFixtureTurn(agyFixtureCheckpoint)),
				err:   tc.err,
				exit:  tc.exit,
			})
			result := out.result
			if result.Status != "completed" || result.Error != "" || result.Output != agyFixtureAnswer || result.SessionID != agyFixtureConversation {
				t.Fatalf("result = %+v", result)
			}
			if out.streamed != agyFixtureAnswer {
				t.Errorf("streamed %q, want only this turn's answer", out.streamed)
			}
			if len(result.Usage) != 1 || result.Usage["fixture-model"] != agyFixtureTurnUsage {
				t.Errorf("usage = %+v, want this turn's steps %+v", result.Usage, agyFixtureTurnUsage)
			}
			if len(out.tools) != 2 || out.tools[0].CallID != "agy-step-102" || out.tools[1].CallID != "agy-step-102" {
				t.Errorf("tools = %+v, want only this turn's tool lifecycle", out.tools)
			}
			if len(out.recovered) != 1 || out.recovered[0]["level"] != "WARN" || out.recovered[0]["err"] != tc.err || out.recovered[0]["evidence"] != "current turn" {
				t.Errorf("recovery log = %+v, want one warning with the original error", out.recovered)
			}
		})
	}
}

func TestAntigravityTurnEvidenceCompletes(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		run  agyRun
	}{
		{name: "error recovered before the answer", run: agyRun{steps: []string{agyFixtureBoundary, agyFixtureToolActive, agyFixtureToolDone, `{"step_index":103,"state":"DONE","step_type":"error_message"}`, agyFixtureAnswerActive, agyFixtureAnswerDone}}},
		{name: "earlier tool never finished", run: agyRun{steps: []string{agyFixtureBoundary, agyFixtureToolActive, agyFixtureAnswerActive, agyFixtureAnswerDone}}},
		{name: "narration without an error", run: agyRun{steps: []string{agyFixtureBoundary, `{"step_index":101,"state":"DONE","step_type":"agent_response","text_delta":"Working.\n"}`, agyFixtureAnswerActive, agyFixtureAnswerDone}}},
		{name: "single done snapshot", run: agyRun{steps: []string{agyFixtureBoundary, `{"step_index":104,"state":"DONE","step_type":"agent_response","text_delta":"Current answer.\n"}`}}},
		{name: "result adds one terminal newline", run: agyRun{steps: []string{agyFixtureBoundary, `{"step_index":104,"state":"DONE","step_type":"agent_response","text_delta":"Current answer."}`}}},
		{name: "answer has one terminal newline more", run: agyRun{steps: agyFixtureTurn(), response: agyString("Current answer.")}},
		{name: "fresh conversation", run: agyRun{steps: agyFixtureTurn(), fresh: true}},
		// The model is optional, and so is the init event itself.
		{name: "empty init payload", run: agyRun{init: `{"event":"init","conversation_id":"fixture-conversation","init":{}}`, steps: agyFixtureTurn()}},
		{name: "no init event", run: agyRun{noInit: true, steps: agyFixtureTurn()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tc.run.err = agyIdleTimeoutError
			out := runAgyFixture(t, tc.run)
			want := agyFixtureAnswer
			if tc.run.response != nil {
				want = *tc.run.response
			}
			if out.result.Status != "completed" || out.result.Error != "" || out.result.Output != want {
				t.Fatalf("result = %+v", out.result)
			}
			if len(out.recovered) != 1 || out.recovered[0]["err"] != agyIdleTimeoutError {
				t.Errorf("recovery log = %+v", out.recovered)
			}
		})
	}
}

// Missing or contradicting evidence keeps agy's structured failure, whether its
// wording is new or one the legacy row knows.
func TestAntigravityTurnEvidenceKeepsFailures(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name       string
		run        agyRun
		wantStatus string // failed when empty
	}{
		{name: "partial answer", run: agyRun{steps: []string{agyFixtureBoundary, agyFixtureAnswerActive}}},
		{name: "answer differs from result", run: agyRun{steps: agyFixtureTurn(), response: agyString("Current answer, continued.\n")}},
		{name: "two terminal newlines", run: agyRun{steps: agyFixtureTurn(), response: agyString("Current answer.\n\n")}},
		{name: "terminal whitespace", run: agyRun{steps: agyFixtureTurn(), response: agyString("Current answer. \n")}},
		{name: "newer active answer after done", run: agyRun{steps: agyFixtureTurn(`{"step_index":106,"state":"ACTIVE","step_type":"agent_response","text_delta":"More"}`)}},
		{name: "historical done only", run: agyRun{steps: agyFixtureSteps(agyFixtureHistory, []string{agyFixtureBoundary})}},
		{name: "error step after answer", run: agyRun{steps: agyFixtureTurn(`{"step_index":105,"state":"DONE","step_type":"error_message"}`)}},
		{name: "tool step after answer", run: agyRun{steps: agyFixtureTurn(`{"step_index":105,"state":"DONE","step_type":"tool"}`)}},
		{name: "unknown step after answer", run: agyRun{steps: agyFixtureTurn(`{"step_index":105,"state":"DONE","step_type":"system_message"}`)}},
		{name: "active checkpoint after answer", run: agyRun{steps: agyFixtureTurn(`{"step_index":105,"state":"ACTIVE","step_type":"checkpoint"}`)}},
		{name: "answer text before the last error", run: agyRun{steps: []string{agyFixtureBoundary, `{"step_index":101,"state":"DONE","step_type":"agent_response","text_delta":"Working.\n"}`, `{"step_index":103,"state":"DONE","step_type":"error_message"}`, agyFixtureAnswerActive, agyFixtureAnswerDone}}},
		{name: "resumed without boundary", run: agyRun{steps: []string{agyFixtureAnswerActive, agyFixtureAnswerDone}}},
		{name: "boundary after the answer", run: agyRun{steps: []string{agyFixtureAnswerActive, agyFixtureAnswerDone, agyFixtureBoundary}}},
		{name: "boundary not completed", run: agyRun{steps: []string{`{"step_index":100,"state":"ACTIVE","step_type":"user_input"}`, agyFixtureAnswerActive, agyFixtureAnswerDone}}},
		{name: "second boundary", run: agyRun{steps: agyFixtureTurn(`{"step_index":106,"state":"DONE","step_type":"user_input"}`, `{"step_index":107,"state":"DONE","step_type":"agent_response","text_delta":"Current answer.\n"}`)}},
		{name: "malformed line", run: agyRun{steps: agyFixtureTurn(), beforeResult: []string{"{bad-json"}}},
		{name: "index reused by another step type", run: agyRun{steps: agyFixtureTurn(`{"step_index":104,"state":"DONE","step_type":"error_message"}`)}},
		{name: "done answer regresses to active", run: agyRun{steps: agyFixtureTurn(agyFixtureAnswerActive)}},
		{name: "conflicting done delta", run: agyRun{steps: agyFixtureTurn(`{"step_index":104,"state":"DONE","step_type":"agent_response","text_delta":"other"}`)}},
		{name: "unknown step state", run: agyRun{steps: agyFixtureTurn(`{"step_index":105,"state":"PENDING","step_type":"checkpoint"}`)}},
		{name: "missing step index", run: agyRun{steps: agyFixtureTurn(`{"state":"DONE","step_type":"checkpoint"}`)}},
		{name: "conversation changes", run: agyRun{steps: agyFixtureTurn(`{"conversation_id":"other-conversation","step_index":105,"state":"DONE","step_type":"checkpoint"}`)}},
		{name: "null step payload", run: agyRun{steps: agyFixtureTurn(), beforeResult: []string{`{"event":"step_update"}`}}},
		{name: "null init payload", run: agyRun{init: `{"event":"init","conversation_id":"fixture-conversation","init":null}`, steps: agyFixtureTurn()}},
		{name: "missing init payload", run: agyRun{init: `{"event":"init","conversation_id":"fixture-conversation"}`, steps: agyFixtureTurn()}},
		{name: "unknown event", run: agyRun{steps: agyFixtureTurn(), beforeResult: []string{`{"event":"unknown"}`}}},
		{name: "event after result", run: agyRun{steps: agyFixtureTurn(), afterResult: []string{`{"event":"step_update","step_update":{"step_index":105,"state":"DONE","step_type":"checkpoint"}}`}}},
		{name: "other exit code", run: agyRun{steps: agyFixtureTurn(), exit: 2}},
		{name: "signal", run: agyRun{steps: agyFixtureTurn(), kill: true}},
		{name: "print timeout in log", run: agyRun{steps: agyFixtureTurn(), log: "Print mode: timed out after 100 polls"}},
		{name: "provider error in log", run: agyRun{steps: agyFixtureTurn(), log: "agent executor error: synthetic provider failure"}},
		{name: "cancelled result", run: agyRun{steps: agyFixtureTurn(), status: "CANCELLED"}, wantStatus: "cancelled"},
		{name: "timed out result", run: agyRun{steps: agyFixtureTurn(), status: "TIMEOUT"}, wantStatus: "timeout"},
		{name: "interrupted result", run: agyRun{steps: agyFixtureTurn(), status: "INTERRUPTED"}},
	} {
		for _, providerError := range []struct{ name, text string }{
			{name: "idle timeout", text: agyIdleTimeoutError},
			{name: "legacy network sentence", text: antigravityNetworkIssueError},
		} {
			t.Run(tc.name+"/"+providerError.name, func(t *testing.T) {
				t.Parallel()
				run := tc.run
				run.err = providerError.text
				out := runAgyFixture(t, run)
				wantStatus, wantOutput := tc.wantStatus, agyFixtureAnswer
				if wantStatus == "" {
					wantStatus = "failed"
				}
				if run.response != nil {
					wantOutput = *run.response
				}
				// The structured error keeps precedence over exit, log and stream
				// diagnostics, so the failure stays actionable.
				if out.result.Status != wantStatus || !strings.HasPrefix(out.result.Error, providerError.text) || out.result.Output != wantOutput {
					t.Fatalf("result = %+v, want %s with error %q", out.result, wantStatus, providerError.text)
				}
				if len(out.recovered) != 0 {
					t.Errorf("unexpected recovery: %+v", out.recovered)
				}
			})
		}
	}
}

// Local cancellation and the daemon's deadline win even after a complete
// answer and a replaceable result.
func TestAntigravityTurnEvidenceHonorsContext(t *testing.T) {
	t.Parallel()
	for _, deadline := range []bool{false, true} {
		t.Run(fmt.Sprintf("deadline=%v", deadline), func(t *testing.T) {
			t.Parallel()
			fakePath := filepath.Join(t.TempDir(), "agy")
			writeTestExecutable(t, fakePath, []byte(`#!/bin/sh
cat <<'JSONL'
{"event":"step_update","step_update":{"step_index":100,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"step_index":104,"state":"DONE","step_type":"agent_response","text_delta":"Current answer."}}
{"event":"result","result":{"status":"ERROR","response":"Current answer.","error":"`+agyIdleTimeoutError+`"}}
JSONL
sleep 60
`))
			backend, err := New("antigravity", Config{ExecutablePath: fakePath, Logger: quietAntigravityLogger()})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			opts, want := ExecOptions{}, "aborted"
			if deadline {
				opts.Timeout, want = 200*time.Millisecond, "timeout"
			}
			session, err := backend.Execute(ctx, "synthetic prompt", opts)
			if err != nil {
				t.Fatal(err)
			}
			for msg := range session.Messages {
				if !deadline && msg.Type == MessageText {
					cancel()
				}
			}
			if result := <-session.Result; result.Status != want {
				t.Fatalf("status = %s, want %s (error %q)", result.Status, want, result.Error)
			}
		})
	}
}

// A resumed stream without a boundary holds its steps until the result. If the
// run is cancelled or times out first, the steps already read still reach the
// output, usage and tool events. The plain marker line is never held, so its
// arrival shows that the scanner has read every step before it.
func TestAntigravityHeldStepsSurviveCancellation(t *testing.T) {
	t.Parallel()
	const marker = "synthetic scanner marker"
	for _, deadline := range []bool{false, true} {
		t.Run(fmt.Sprintf("deadline=%v", deadline), func(t *testing.T) {
			t.Parallel()
			var stream strings.Builder
			fmt.Fprintf(&stream, "{\"event\":\"init\",\"conversation_id\":%q,\"init\":{\"model\":\"fixture-model\"}}\n", agyFixtureConversation)
			for _, step := range []string{agyFixtureToolActive, agyFixtureToolDone, agyFixtureAnswerActive, agyFixtureAnswerDone} {
				fmt.Fprintf(&stream, "{\"event\":\"step_update\",\"step_update\":%s}\n", step)
			}
			fakePath := filepath.Join(t.TempDir(), "agy")
			writeTestExecutable(t, fakePath, []byte("#!/bin/sh\ncat <<'JSONL'\n"+stream.String()+marker+"\nJSONL\nsleep 60\n"))
			backend, err := New("antigravity", Config{ExecutablePath: fakePath, Logger: quietAntigravityLogger()})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			opts, want := ExecOptions{ResumeSessionID: agyFixtureConversation}, "aborted"
			if deadline {
				opts.Timeout, want = 2*time.Second, "timeout"
			}
			session, err := backend.Execute(ctx, "synthetic prompt", opts)
			if err != nil {
				t.Fatal(err)
			}
			markerRead := false
			var tools []Message
			for msg := range session.Messages {
				switch msg.Type {
				case MessageText:
					if strings.Contains(msg.Content, marker) {
						markerRead = true
						if !deadline {
							cancel()
						}
					}
				case MessageToolUse, MessageToolResult:
					tools = append(tools, msg)
				}
			}
			result := <-session.Result
			if !markerRead {
				t.Fatalf("the run ended before the scanner reached the marker: %+v", result)
			}
			if result.Status != want || !strings.HasSuffix(result.Output, agyFixtureAnswer) {
				t.Fatalf("result = %+v, want %s keeping the held answer", result, want)
			}
			if len(result.Usage) != 1 || result.Usage["fixture-model"] != agyFixtureTurnUsage {
				t.Errorf("usage = %+v, want %+v", result.Usage, agyFixtureTurnUsage)
			}
			if len(tools) != 2 || tools[0].Type != MessageToolUse || tools[1].Type != MessageToolResult || tools[1].CallID != "agy-step-102" {
				t.Errorf("tools = %+v, want the held tool lifecycle", tools)
			}
		})
	}
}

// agy releases without user_input steps keep upstream's (#8983) transport
// spellings, for a fresh stream only and with the same settled answer.
func TestAntigravityLegacyFreshStream(t *testing.T) {
	t.Parallel()
	const eof = `API error (attempt 3): request failed: Post "https://synthetic.invalid/v1": EOF`
	answer := []string{agyFixtureToolActive, agyFixtureToolDone, agyFixtureAnswerActive, agyFixtureAnswerDone}
	for _, tc := range []struct {
		name string
		run  agyRun
		want string
	}{
		{name: "network sentence", run: agyRun{fresh: true, steps: answer, err: antigravityNetworkIssueError, exit: 1}, want: "completed"},
		{name: "transport error", run: agyRun{fresh: true, steps: answer, err: eof, exit: 1}, want: "completed"},
		{name: "other wording", run: agyRun{fresh: true, steps: answer, err: agyIdleTimeoutError}, want: "failed"},
		{name: "quota", run: agyRun{fresh: true, steps: answer, err: "RESOURCE_EXHAUSTED: synthetic quota"}, want: "failed"},
		{name: "tool after answer", run: agyRun{fresh: true, steps: append(answer, `{"step_index":105,"state":"DONE","step_type":"tool"}`), err: eof}, want: "failed"},
		{name: "answer differs from result", run: agyRun{fresh: true, steps: answer, err: eof, response: agyString("Other answer.\n")}, want: "failed"},
		{name: "answer text before an error", run: agyRun{fresh: true, steps: []string{`{"step_index":101,"state":"DONE","step_type":"agent_response","text_delta":"Working.\n"}`, `{"step_index":103,"state":"DONE","step_type":"error_message"}`, agyFixtureAnswerActive, agyFixtureAnswerDone}, err: eof}, want: "failed"},
		{name: "signal", run: agyRun{fresh: true, steps: answer, err: eof, kill: true}, want: "failed"},
		{name: "resumed", run: agyRun{steps: answer, err: eof, exit: 1}, want: "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			out := runAgyFixture(t, tc.run)
			if out.result.Status != tc.want {
				t.Fatalf("result = %+v, want %s", out.result, tc.want)
			}
			if tc.want == "completed" {
				if out.result.Error != "" || len(out.recovered) != 1 || out.recovered[0]["evidence"] != "legacy transport error" || out.recovered[0]["err"] != tc.run.err {
					t.Errorf("result error %q, recovery log %+v", out.result.Error, out.recovered)
				}
			} else if !strings.HasPrefix(out.result.Error, tc.run.err) || len(out.recovered) != 0 {
				t.Errorf("result error %q, recovery log %+v", out.result.Error, out.recovered)
			}
		})
	}
}

// Replayed history never reaches the transcript, tools or usage, and a
// repeated DONE snapshot replaces its step instead of adding to it.
func TestAntigravityTurnScopesOutput(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name       string
		run        agyRun
		wantStatus string
	}{
		{name: "history after the boundary", run: agyRun{steps: agyFixtureTurn(agyFixtureHistory...), err: agyIdleTimeoutError}, wantStatus: "completed"},
		{name: "repeated done snapshots", run: agyRun{steps: agyFixtureTurn(agyFixtureAnswerDone, agyFixtureToolDone), err: agyIdleTimeoutError}, wantStatus: "completed"},
		// Without a boundary nothing can be attributed to history, so the held
		// steps are released at the result instead of being dropped.
		{name: "resumed success without boundary", run: agyRun{steps: []string{agyFixtureToolActive, agyFixtureToolDone, agyFixtureAnswerActive, agyFixtureAnswerDone}, status: "SUCCESS"}, wantStatus: "completed"},
		{name: "resumed failure without boundary", run: agyRun{steps: []string{agyFixtureToolActive, agyFixtureToolDone, agyFixtureAnswerActive, agyFixtureAnswerDone}, err: agyIdleTimeoutError}, wantStatus: "failed"},
		// This turn's steps arriving before a late boundary are released after
		// it, while history is still dropped; the evidence stays invalid.
		{name: "late boundary", run: agyRun{steps: agyFixtureSteps(agyFixtureHistory, []string{agyFixtureToolActive, agyFixtureToolDone, agyFixtureAnswerActive, agyFixtureAnswerDone, agyFixtureBoundary}), err: agyIdleTimeoutError}, wantStatus: "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			out := runAgyFixture(t, tc.run)
			if out.result.Status != tc.wantStatus || out.result.Output != agyFixtureAnswer {
				t.Fatalf("result = %+v", out.result)
			}
			if out.streamed != agyFixtureAnswer {
				t.Errorf("streamed %q, want %q", out.streamed, agyFixtureAnswer)
			}
			if len(out.tools) != 2 || out.tools[0].Type != MessageToolUse || out.tools[1].Type != MessageToolResult || out.tools[1].CallID != "agy-step-102" {
				t.Errorf("tools = %+v, want one lifecycle for step 102", out.tools)
			}
			if len(out.result.Usage) != 1 || out.result.Usage["fixture-model"] != agyFixtureTurnUsage {
				t.Errorf("usage = %+v, want %+v", out.result.Usage, agyFixtureTurnUsage)
			}
		})
	}
}

// agyExitError returns the error exec reports for a fake process ending the
// way script makes it.
func agyExitError(t *testing.T, script string) error {
	t.Helper()
	path := filepath.Join(t.TempDir(), "exit")
	writeTestExecutable(t, path, []byte("#!/bin/sh\n"+script+"\n"))
	err := exec.Command(path).Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("%q: err = %v, want an exit error", script, err)
	}
	return err
}

// Each row of decideAntigravityOutcome, in table order, with the facts that
// select it while every earlier row stays inapplicable.
func TestDecideAntigravityOutcome(t *testing.T) {
	t.Parallel()
	exit1, exit2, exit3 := agyExitError(t, "exit 1"), agyExitError(t, "exit 2"), agyExitError(t, "exit 3")
	killed := agyExitError(t, "kill -KILL $$")
	const stale = "synthetic stale error"
	recoverable := antigravityRunFacts{status: "ERROR", resultError: stale, response: "answer", answer: antigravityTurnAnswer, waitErr: exit1}
	with := func(change func(*antigravityRunFacts)) antigravityRunFacts {
		facts := recoverable
		change(&facts)
		return facts
	}
	for _, tc := range []struct {
		row   int
		name  string
		facts antigravityRunFacts
		want  antigravityOutcome
	}{
		{1, "local deadline", with(func(f *antigravityRunFacts) { f.ctxErr, f.timeout = context.DeadlineExceeded, time.Minute }), antigravityOutcome{status: "timeout", err: "agy timed out after 1m0s"}},
		{2, "local cancellation", with(func(f *antigravityRunFacts) { f.ctxErr = context.Canceled }), antigravityOutcome{status: "aborted", err: "execution cancelled"}},
		{3, "turn answer after exit 1", recoverable, antigravityOutcome{status: "completed", recovered: "current turn"}},
		{3, "turn answer after exit 0", with(func(f *antigravityRunFacts) { f.waitErr = nil }), antigravityOutcome{status: "completed", recovered: "current turn"}},
		{3, "turn answer after exit 3", with(func(f *antigravityRunFacts) { f.waitErr = exit3 }), antigravityOutcome{status: "completed", recovered: "current turn"}},
		{3, "status case and padding", with(func(f *antigravityRunFacts) { f.status = " error " }), antigravityOutcome{status: "completed", recovered: "current turn"}},
		{4, "legacy transport error", with(func(f *antigravityRunFacts) {
			f.answer, f.resultError = antigravityLegacyAnswer, antigravityNetworkIssueError
		}), antigravityOutcome{status: "completed", recovered: "legacy transport error"}},
		{5, "legacy answer with another error", with(func(f *antigravityRunFacts) { f.answer = antigravityLegacyAnswer }), antigravityOutcome{status: "failed", err: stale}},
		{5, "transport error without legacy answer", with(func(f *antigravityRunFacts) {
			f.answer, f.resultError = antigravityNoAnswer, antigravityNetworkIssueError
		}), antigravityOutcome{status: "failed", err: antigravityNetworkIssueError}},
		{5, "no answer", with(func(f *antigravityRunFacts) { f.answer = antigravityNoAnswer }), antigravityOutcome{status: "failed", err: stale}},
		{5, "other exit code", with(func(f *antigravityRunFacts) { f.waitErr = exit2 }), antigravityOutcome{status: "failed", err: stale}},
		{5, "signal", with(func(f *antigravityRunFacts) { f.waitErr = killed }), antigravityOutcome{status: "failed", err: stale}},
		{5, "print timeout", with(func(f *antigravityRunFacts) { f.printTimedOut = true }), antigravityOutcome{status: "failed", err: stale}},
		{5, "provider error in log", with(func(f *antigravityRunFacts) { f.providerError = "synthetic" }), antigravityOutcome{status: "failed", err: stale}},
		{5, "only ERROR is replaceable", with(func(f *antigravityRunFacts) { f.status = "CANCELLED" }), antigravityOutcome{status: "cancelled", err: stale}},
		{5, "status without error text", with(func(f *antigravityRunFacts) { f.answer, f.resultError = antigravityNoAnswer, "" }), antigravityOutcome{status: "failed", err: "agy returned status ERROR"}},
		{6, "exit error after success", antigravityRunFacts{status: "SUCCESS", waitErr: exit2}, antigravityOutcome{status: "failed", err: "agy exited with error: exit status 2"}},
		{7, "print timeout", antigravityRunFacts{printTimedOut: true, timeout: time.Minute}, antigravityOutcome{status: "timeout", err: "agy --print-timeout elapsed after 1m0s waiting for the agent response; a long-running command likely outlived the print timeout"}},
		{8, "provider error in log", antigravityRunFacts{providerError: "synthetic"}, antigravityOutcome{status: "failed", err: "agy provider error: synthetic"}},
		{9, "success", antigravityRunFacts{status: "SUCCESS"}, antigravityOutcome{status: "completed"}},
		{9, "clean exit without a result", antigravityRunFacts{}, antigravityOutcome{status: "completed"}},
	} {
		t.Run(fmt.Sprintf("row %d %s", tc.row, tc.name), func(t *testing.T) {
			t.Parallel()
			if got := decideAntigravityOutcome(tc.facts); got != tc.want {
				t.Fatalf("outcome = %+v, want %+v", got, tc.want)
			}
		})
	}
}
