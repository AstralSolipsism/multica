package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These are synthetic offline stream-json fixtures, not incident captures.
// error_message only supplies ordering evidence; no undocumented error payload
// or database status is treated as a stream completion signal.
func TestAntigravityBackendCompletionEvidence(t *testing.T) {
	t.Parallel()
	const boundary = `{"step_index":100,"state":"DONE","step_type":"user_input"}`
	const active = `{"step_index":103,"state":"ACTIVE","step_type":"agent_response","text_delta":"Complete "}`
	const done = `{"step_index":103,"state":"DONE","step_type":"agent_response","text_delta":"answer.\n","usage":{"input_tokens":20,"output_tokens":5,"thinking_tokens":2,"cache_read_tokens":7}}`
	const whole = `{"step_index":103,"state":"DONE","step_type":"agent_response","text_delta":"Complete answer.\n","usage":{"input_tokens":20,"output_tokens":5,"cache_read_tokens":7}}`
	const historical = `{"step_index":90,"state":"DONE","step_type":"agent_response","text_delta":"Historical answer.\n","usage":{"input_tokens":9000,"output_tokens":900}}`
	const answer = "Complete answer.\n"
	base := []string{boundary, active, done}
	appendSteps := func(steps ...string) []string { return append(append([]string{}, base...), steps...) }
	for _, tc := range []struct {
		name          string
		steps         []string
		status, err   string
		response      *string
		wantStatus    string
		wantStream    string
		noUsage       bool
		noResult      bool
		fresh         bool
		exit          int
		log, trailing string
		beforeResult  string
		conversation  string
		stderr        string
		kill          bool
		wantError     string
	}{
		{name: "historical interruption current turn complete", steps: base, wantStatus: "completed", wantStream: answer},
		{name: "same turn interruption recovered", steps: []string{boundary, `{"step_index":101,"state":"DONE","step_type":"agent_response"}`, `{"step_index":102,"state":"DONE","step_type":"error_message"}`, active, done}, wantStatus: "completed", wantStream: answer, exit: 3},
		{name: "fresh recovered interruption", steps: []string{boundary, `{"step_index":102,"state":"DONE","step_type":"error_message"}`, whole}, fresh: true, wantStatus: "completed", wantStream: answer},
		{name: "fresh interruption without recovery evidence", steps: base, fresh: true, exit: 3, stderr: `AGY_ERROR: {"message":"synthetic current failure"}`, wantStream: answer},
		{name: "split reply around current interruption", steps: []string{boundary, `{"step_index":101,"state":"ACTIVE","step_type":"agent_response","text_delta":"Part one of the plan: migrate the schema, "}`, `{"step_index":101,"state":"DONE","step_type":"agent_response"}`, `{"step_index":102,"state":"DONE","step_type":"error_message"}`, `{"step_index":103,"state":"DONE","step_type":"agent_response","text_delta":"then backfill the data.\n"}`}, response: completionString("then backfill the data.\n"), wantStream: "Part one of the plan: migrate the schema, then backfill the data.\n", noUsage: true},
		{name: "narration before current interruption", steps: []string{boundary, `{"step_index":101,"state":"DONE","step_type":"agent_response","text_delta":"Working.\n"}`, `{"step_index":102,"state":"DONE","step_type":"error_message"}`, whole}, wantStream: "Working.\n" + answer},
		{name: "legacy network error", steps: base, err: antigravityNetworkIssueError, wantStatus: "completed", wantStream: answer, exit: 1},
		{name: "history replay before boundary", steps: []string{historical, `{"step_index":91,"state":"DONE","step_type":"tool","tool_name":"read_file","usage":{"input_tokens":2000}}`, boundary, active, done}, wantStatus: "completed", wantStream: answer},
		{name: "history replay after boundary", steps: []string{boundary, historical, active, done, historical}, wantStatus: "completed", wantStream: answer},
		{name: "historical error arrives late", steps: appendSteps(`{"step_index":99,"state":"DONE","step_type":"error_message"}`), wantStatus: "completed", wantStream: answer},
		{name: "duplicate done text and usage", steps: appendSteps(done), wantStatus: "completed", wantStream: answer},
		{name: "duplicate boundary", steps: []string{boundary, boundary, active, done}, wantStatus: "completed", wantStream: answer},
		{name: "checkpoint after reply", steps: appendSteps(`{"step_index":104,"state":"DONE","step_type":"checkpoint"}`), wantStatus: "completed", wantStream: answer},
		{name: "lower index done arrives last", steps: appendSteps(`{"step_index":101,"state":"DONE","step_type":"system_message"}`), wantStatus: "completed", wantStream: answer},
		{name: "current narration before final reply", steps: []string{boundary, `{"step_index":101,"state":"DONE","step_type":"agent_response","text_delta":"Working.\n"}`, active, done}, wantStatus: "completed", wantStream: "Working.\n" + answer},
		{name: "partial body", steps: []string{boundary, active}, wantStream: "Complete ", noUsage: true},
		{name: "newer active reply", steps: appendSteps(`{"step_index":105,"state":"ACTIVE","step_type":"agent_response","text_delta":"More"}`), wantStream: answer + "More"},
		{name: "newer active before older done", steps: []string{boundary, active, `{"step_index":105,"state":"ACTIVE","step_type":"agent_response"}`, done}, wantStream: answer},
		{name: "historical done only", steps: []string{boundary, historical}, wantStream: answer, noUsage: true},
		{name: "missing turn boundary", steps: []string{active, done}, wantStream: answer},
		{name: "fresh missing turn boundary", steps: []string{active, done}, fresh: true, wantStream: answer},
		{name: "resumed legacy missing boundary", steps: []string{active, done}, err: antigravityNetworkIssueError, wantStream: answer},
		{name: "current error after done", steps: appendSteps(`{"step_index":104,"state":"DONE","step_type":"error_message"}`), wantStream: answer},
		{name: "legacy current error after done", steps: appendSteps(`{"step_index":104,"state":"DONE","step_type":"error_message"}`), err: antigravityNetworkIssueError, wantStream: answer},
		{name: "unknown provider error", steps: base, err: "quota exhausted", wantStream: answer},
		{name: "similar error is not allowlisted", steps: base, err: antigravityStreamInterruptedError + " Retry now.", wantStream: answer},
		{name: "cancelled result", steps: base, status: "CANCELLED", wantStatus: "cancelled", wantStream: answer},
		{name: "aborted result", steps: base, status: "ABORTED", wantStatus: "aborted", wantStream: answer},
		{name: "timeout result", steps: base, status: "TIMEOUT", wantStatus: "timeout", wantStream: answer},
		{name: "interrupted terminal status", steps: base, status: "INTERRUPTED", wantStream: answer},
		{name: "waiting terminal status", steps: base, status: "WAITING", wantStream: answer},
		{name: "legacy cancelled result", steps: base, status: "CANCELED", err: antigravityNetworkIssueError, wantStatus: "cancelled", wantStream: answer},
		{name: "legacy timeout result", steps: base, status: "TIMED_OUT", err: antigravityNetworkIssueError, wantStatus: "timeout", wantStream: answer},
		{name: "active tool after done", steps: appendSteps(`{"step_index":104,"state":"ACTIVE","step_type":"tool"}`), wantStream: answer},
		{name: "done tool after reply still needs final response", steps: appendSteps(`{"step_index":104,"state":"DONE","step_type":"tool"}`), wantStream: answer},
		{name: "active checkpoint after done", steps: appendSteps(`{"step_index":104,"state":"ACTIVE","step_type":"checkpoint"}`), wantStream: answer},
		{name: "unknown later step", steps: appendSteps(`{"step_index":104,"state":"DONE","step_type":"unknown"}`), wantStream: answer},
		{name: "unsettled earlier work", steps: []string{boundary, `{"step_index":102,"state":"ACTIVE","step_type":"tool"}`, active, done}, wantStream: answer},
		{name: "missing response index", steps: []string{boundary, `{"state":"DONE","step_type":"agent_response","text_delta":"Complete answer.\n"}`}, wantStream: answer, noUsage: true},
		{name: "negative response index", steps: []string{boundary, `{"step_index":-1,"state":"DONE","step_type":"agent_response"}`}, wantStream: answer, noUsage: true},
		{name: "negative index before boundary", steps: []string{`{"step_index":-1,"state":"DONE","step_type":"agent_response"}`, boundary, active, done}, wantStream: answer},
		{name: "missing later index", steps: appendSteps(`{"state":"ACTIVE","step_type":"tool"}`), wantStream: answer},
		{name: "missing response state", steps: []string{boundary, `{"step_index":103,"step_type":"agent_response","text_delta":"Complete answer.\n"}`}, wantStream: answer, noUsage: true},
		{name: "done regresses to active", steps: appendSteps(active), wantStream: answer},
		{name: "done regresses to active without delta", steps: appendSteps(`{"step_index":103,"state":"ACTIVE","step_type":"agent_response"}`), wantStream: answer},
		{name: "conflicting done delta", steps: appendSteps(`{"step_index":103,"state":"DONE","step_type":"agent_response","text_delta":"different"}`), wantStream: answer},
		{name: "conflicting step kind", steps: appendSteps(`{"step_index":103,"state":"DONE","step_type":"error_message"}`), wantStream: answer},
		{name: "second input without completion", steps: appendSteps(`{"step_index":104,"state":"DONE","step_type":"user_input"}`), wantStream: answer},
		{name: "second input with complete reply", steps: appendSteps(`{"step_index":104,"state":"DONE","step_type":"user_input"}`, `{"step_index":105,"state":"DONE","step_type":"agent_response","text_delta":"Complete answer.\n"}`), wantStream: answer + answer},
		{name: "boundary arrives after response", steps: []string{active, done, boundary}, wantStream: answer, noUsage: true},
		{name: "active boundary", steps: []string{`{"step_index":100,"state":"ACTIVE","step_type":"user_input"}`, active, done}, wantStream: answer},
		{name: "mismatched conversation", steps: appendSteps(`{"conversation_id":"different-conversation","step_index":104,"state":"DONE","step_type":"checkpoint"}`), wantStream: answer},
		{name: "entire stream uses wrong resumed conversation", steps: base, conversation: "different-conversation", wantStream: answer},
		{name: "canonical text differs", steps: base, response: completionString("Different answer.\n"), wantStream: answer},
		{name: "empty canonical response", steps: base, response: completionString(""), wantStream: answer},
		{name: "empty done and empty canonical response", steps: []string{boundary, `{"step_index":103,"state":"DONE","step_type":"agent_response"}`}, response: completionString(""), noUsage: true},
		{name: "canonical adds one terminal newline", steps: []string{boundary, `{"step_index":103,"state":"DONE","step_type":"agent_response","text_delta":"Complete answer."}`}, wantStatus: "completed", wantStream: "Complete answer.", noUsage: true},
		{name: "delta adds one terminal newline", steps: base, response: completionString("Complete answer."), wantStatus: "completed", wantStream: answer},
		{name: "multiple terminal newlines do not match", steps: base, response: completionString("Complete answer.\n\n"), wantStream: answer},
		{name: "terminal whitespace does not match", steps: base, response: completionString("Complete answer. \n"), wantStream: answer},
		{name: "legacy canonical adds one terminal newline", steps: []string{boundary, `{"step_index":103,"state":"DONE","step_type":"agent_response","text_delta":"Complete answer."}`}, err: antigravityNetworkIssueError, wantStatus: "completed", wantStream: "Complete answer.", noUsage: true},
		{name: "no terminal result", steps: base, noResult: true, wantStream: answer},
		{name: "provider error before missing result", steps: base, noResult: true, log: "agent executor error: FAILED_PRECONDITION: synthetic provider failure", wantError: "agy provider error: FAILED_PRECONDITION: synthetic provider failure", wantStream: answer},
		{name: "killed process before missing result", steps: base, noResult: true, kill: true, wantError: "agy exited with error: signal: killed", wantStream: answer},
		{name: "exit error before missing result", steps: base, noResult: true, exit: 2, wantError: "agy exited with error: exit status 2", wantStream: answer},
		{name: "non-provider exit", steps: base, exit: 2, wantStream: answer},
		{name: "print timeout prevents recovery without replacing structured error", steps: base, log: "Print mode: timed out after 100 polls", wantStream: answer},
		{name: "quota error precedes print timeout", steps: base, err: "RESOURCE_EXHAUSTED: Individual quota reached.", log: "Print mode: timed out after 100 polls", wantStream: answer},
		{name: "print timeout before missing result", steps: base, noResult: true, log: "Print mode: timed out after 100 polls", wantStatus: "timeout", wantError: "agy --print-timeout elapsed after ", wantStream: answer},
		{name: "current provider log prevents recovery", steps: base, log: "agent executor error: permission denied", wantStream: answer},
		{name: "legacy provider log prevents recovery", steps: base, err: antigravityNetworkIssueError, log: "agent executor error: " + antigravityNetworkIssueError, wantStream: answer},
		{name: "malformed trailing line", steps: base, trailing: "{bad-json", wantStream: answer + "\n{bad-json"},
		{name: "step after result", steps: base, trailing: `{"event":"step_update","step_update":{"step_index":104,"state":"ACTIVE","step_type":"tool"}}`, wantStream: answer},
		{name: "done checkpoint after result", steps: base, trailing: `{"event":"step_update","step_update":{"step_index":104,"state":"DONE","step_type":"checkpoint"}}`, wantStream: answer},
		{name: "null step payload after result", steps: base, trailing: `{"event":"step_update"}`, wantStream: answer},
		{name: "unknown event before result", steps: base, beforeResult: `{"event":"unknown"}`, wantStream: answer},
		{name: "null result before valid result", steps: base, beforeResult: `{"event":"result"}`, wantStream: answer},
		{name: "active usage is not counted", steps: appendSteps(`{"step_index":104,"state":"ACTIVE","step_type":"tool","usage":{"input_tokens":5000,"output_tokens":500}}`), wantStream: answer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			status, providerError, response := tc.status, tc.err, answer
			if status == "" {
				status = "ERROR"
			}
			if providerError == "" {
				providerError = antigravityStreamInterruptedError
			}
			if tc.response != nil {
				response = *tc.response
			}
			conversation := tc.conversation
			if conversation == "" {
				conversation = "fixture-conversation"
			}
			var stream strings.Builder
			fmt.Fprintf(&stream, "{\"event\":\"init\",\"conversation_id\":%q,\"init\":{\"model\":\"fixture-model\"}}\n", conversation)
			for _, step := range tc.steps {
				fmt.Fprintf(&stream, "{\"event\":\"step_update\",\"step_update\":%s}\n", step)
			}
			if tc.beforeResult != "" {
				fmt.Fprintln(&stream, tc.beforeResult)
			}
			if !tc.noResult {
				result, err := json.Marshal(map[string]any{"event": "result", "result": map[string]any{
					"conversation_id": conversation, "status": status, "error": providerError, "response": response,
					"usage": map[string]int{"input_tokens": 99999, "output_tokens": 9999},
				}})
				if err != nil {
					t.Fatal(err)
				}
				fmt.Fprintln(&stream, string(result))
			}
			if tc.trailing != "" {
				fmt.Fprintln(&stream, tc.trailing)
			}
			script := "#!/bin/sh\n"
			if tc.log != "" {
				script += "while [ $# -gt 0 ]; do\n  case \"$1\" in\n    --log-file) printf '%s\\n' '" + tc.log + "' > \"$2\"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\n"
			}
			script += "cat <<'JSONL'\n" + stream.String() + "JSONL\n"
			if tc.stderr != "" {
				script += "cat >&2 <<'STDERR'\n" + tc.stderr + "\nSTDERR\n"
			}
			if tc.kill {
				script += "kill -KILL $$\n"
			}
			script += fmt.Sprintf("exit %d\n", tc.exit)
			fakePath := filepath.Join(t.TempDir(), "agy")
			writeTestExecutable(t, fakePath, []byte(script))
			backend, err := New("antigravity", Config{ExecutablePath: fakePath, Logger: quietAntigravityLogger()})
			if err != nil {
				t.Fatal(err)
			}
			opts := ExecOptions{ResumeSessionID: "fixture-conversation"}
			if tc.fresh {
				opts.ResumeSessionID = ""
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			session, err := backend.Execute(ctx, "synthetic prompt", opts)
			if err != nil {
				t.Fatal(err)
			}
			var streamed strings.Builder
			for msg := range session.Messages {
				if msg.Type == MessageText {
					streamed.WriteString(msg.Content)
				}
				if msg.Type == MessageToolUse || msg.Type == MessageToolResult {
					t.Errorf("historical tool replayed: %+v", msg)
				}
			}
			result := <-session.Result
			wantStatus := tc.wantStatus
			if wantStatus == "" {
				wantStatus = "failed"
			}
			wantOutput := response
			if response == "" || tc.noResult {
				wantOutput = tc.wantStream
			}
			if result.Status != wantStatus || result.Output != wantOutput || result.SessionID != conversation {
				t.Fatalf("result = %+v; want %s, output %q, session %q", result, wantStatus, wantOutput, conversation)
			}
			if (result.Error == "") != (wantStatus == "completed") {
				t.Errorf("error = %q for status %s", result.Error, result.Status)
			}
			if wantStatus != "completed" {
				wantError := tc.wantError
				if wantError == "" {
					wantError = providerError
					if tc.noResult {
						wantError = "agy stream ended without a result"
					}
				}
				if !strings.HasPrefix(result.Error, wantError) {
					t.Errorf("error = %q, want prefix %q", result.Error, wantError)
				}
			}
			if streamed.String() != tc.wantStream {
				t.Errorf("streamed %q, want %q", streamed.String(), tc.wantStream)
			}
			usage, reported := result.Usage["fixture-model"]
			if tc.noUsage {
				if reported {
					t.Errorf("historical usage leaked: %+v", result.Usage)
				}
			} else if !reported || usage != (TokenUsage{InputTokens: 20, OutputTokens: 5, CacheReadTokens: 7}) {
				t.Errorf("usage = %+v; want current step once, without historical result aggregate", result.Usage)
			}
		})
	}
}

func completionString(value string) *string { return &value }

func TestAntigravityBackendCompletionHonorsContext(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(fmt.Sprintf("deadline=%v", deadline), func(t *testing.T) {
			fakePath := filepath.Join(t.TempDir(), "agy")
			script := `#!/bin/sh
cat <<'JSONL'
{"event":"step_update","step_update":{"step_index":100,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"step_index":103,"state":"DONE","step_type":"agent_response","text_delta":"Complete answer."}}
{"event":"result","result":{"status":"ERROR","response":"Complete answer.","error":"The stream was interrupted. Please continue the task you were working on."}}
JSONL
sleep 60
`
			writeTestExecutable(t, fakePath, []byte(script))
			backend, err := New("antigravity", Config{ExecutablePath: fakePath, Logger: quietAntigravityLogger()})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			opts := ExecOptions{}
			want := "aborted"
			if deadline {
				opts.Timeout = 200 * time.Millisecond
				want = "timeout"
			}
			session, err := backend.Execute(ctx, "synthetic prompt", opts)
			if err != nil {
				t.Fatal(err)
			}
			for message := range session.Messages {
				if !deadline && message.Type == MessageText {
					cancel()
				}
			}
			result := <-session.Result
			if result.Status != want {
				t.Fatalf("status = %s, want %s", result.Status, want)
			}
		})
	}
}
