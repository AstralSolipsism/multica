//go:build !windows

package agent

import (
	"fmt"
	"strings"
	"testing"
)

// Projected from agy 1.5.3 stdout on 2026-11-10 (claude-sonnet-5-5-low).
// IDs, tool arguments, usage and init metadata are omitted. The indices,
// states and text bytes are unchanged. The real result was SUCCESS, exit 0,
// response "BEFORE_READ\nAFTER_READ_47\n", with empty stderr and no executor error.
var agyCapturedMultiResponse = []string{
	`{"step_index":0,"state":"DONE","step_type":"user_input"}`,
	`{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"BEFORE_READ"}`,
	`{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n"}`,
	`{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file"}`,
	`{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file"}`,
	`{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"AFTER_READ_47"}`,
	`{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\n"}`,
}

func TestAntigravityCapturedMultiResponseRecovery(t *testing.T) {
	t.Parallel()
	const response = "BEFORE_READ\nAFTER_READ_47\n"
	const retryError = "Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse.\nPlease retry with a properly formatted function call\nRetries remaining: 3"
	for _, exit := range []int{0, 1, 3} {
		t.Run(fmt.Sprintf("exit_%d", exit), func(t *testing.T) {
			// Inject the incident's retry failure before the final response.
			// This mutation is synthetic; the real capture above had no retry.
			steps := append([]string{}, agyCapturedMultiResponse[:5]...)
			steps = append(steps, `{"step_index":3,"state":"DONE","step_type":"error_message"}`)
			for _, step := range agyCapturedMultiResponse[5:] {
				steps = append(steps, strings.Replace(step, `"step_index":3`, `"step_index":4`, 1))
			}
			out := runAgyFixture(t, agyRun{steps: steps, response: agyString(response), err: retryError,
				log: "agent executor error: generating and executing: Malformed function call", exit: exit})
			if out.result.Output != response || out.streamed != response {
				t.Fatalf("lost response: result=%q streamed=%q", out.result.Output, out.streamed)
			}
			if exit == 0 {
				if out.result.Status != "completed" || out.result.Error != "" || len(out.recovered) != 1 || out.recovered[0]["err"] != retryError || out.recovered[0]["level"] != "WARN" {
					t.Fatalf("expected recovered answer and original warning: %+v", out)
				}
			} else if out.result.Status != "failed" || out.result.Error != retryError || len(out.recovered) != 0 {
				t.Fatalf("nonzero exit recovered: %+v", out)
			}
		})
	}
	for _, tc := range []struct {
		name, response string
		steps          []string
		status         string
	}{
		{"captured success", response, agyCapturedMultiResponse, "SUCCESS"},
		{"stale error", response, agyCapturedMultiResponse, "ERROR"},
		{"only final segment", "AFTER_READ_47\n", agyCapturedMultiResponse, "ERROR"},
		{"unfinished final segment", response, agyCapturedMultiResponse[:6], "ERROR"},
		{"empty final segment", "BEFORE_READ\n", append(append([]string{}, agyCapturedMultiResponse[:5]...), `{"step_index":3,"state":"DONE","step_type":"agent_response"}`), "ERROR"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := runAgyFixture(t, agyRun{steps: tc.steps, response: agyString(tc.response), status: tc.status, err: "stale error"})
			want := "failed"
			if tc.name == "captured success" || tc.name == "stale error" {
				want = "completed"
			}
			if out.result.Status != want || out.result.Output != tc.response {
				t.Fatalf("result=%+v, want %s", out.result, want)
			}
		})
	}
}

func TestAntigravityCapturedPrintTimeout(t *testing.T) {
	t.Parallel()
	// agy 1.5.3, --print-timeout 1s, exit 3. stdout was init, user_input,
	// then result(ERROR, empty response, error below). AGY_ERROR was on stderr.
	const timeoutError = "print timeout after 1s with the turn still in progress; the response is partial"
	const stderr = "[agy] print timeout after 1s with turn in progress; returning partial output\nerror: " + timeoutError + "\n" +
		`AGY_ERROR: {"short_error":"print timeout after 1s with the turn still in progress; the response is partial","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}`
	for _, tc := range []struct {
		name, stderr, log, want string
		exit                    int
	}{
		{"captured timeout", stderr, "W1110 05:21:26.510821 1 poll.go:182] Print mode: print timeout after 1s with turn in progress after 40 polls (printed=1)", "timeout", 3},
		{"structured timeout without log", stderr, "", "timeout", 3},
		{"legacy timeout", "", "Print mode: timed out after 100 polls", "timeout", 0},
		{"exit 3 alone", "", "", "failed", 3},
		{"prose alone", timeoutError, "", "failed", 3},
		{"provider deadline", `AGY_ERROR: {"status":"DEADLINE_EXCEEDED","reason":"provider_timeout"}`, "", "failed", 3},
		{"malformed diagnostic", `AGY_ERROR: {"reason":"print_timeout"`, "", "failed", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := runAgyFixture(t, agyRun{steps: agyCapturedMultiResponse[:1], response: agyString(""), err: timeoutError, stderr: tc.stderr, log: tc.log, exit: tc.exit})
			if out.result.Status != tc.want || len(out.recovered) != 0 {
				t.Fatalf("result=%+v, want %s", out.result, tc.want)
			}
		})
	}
}

func TestAntigravityCapturedProviderRejection(t *testing.T) {
	t.Parallel()
	// Real gemini-4-argon-high rejection from the same agy 1.5.3 probe.
	const refusal = "FAILED_PRECONDITION (code 400): User location is not supported for the API use."
	for _, exit := range []int{0, 3} {
		out := runAgyFixture(t, agyRun{steps: []string{agyCapturedMultiResponse[0], `{"step_index":1,"state":"DONE","step_type":"error_message"}`},
			response: agyString(""), err: refusal, exit: exit,
			stderr: `AGY_ERROR: {"short_error":"` + refusal + `","status":"INVALID_ARGUMENT","error_code":400,"code_kind":"http","retryable":false}`,
			log:    "agent executor error: generating and executing: " + refusal})
		if out.result.Status != "failed" || !strings.HasPrefix(out.result.Error, refusal) || len(out.recovered) != 0 {
			t.Fatalf("provider rejection recovered: %+v", out)
		}
	}
}
