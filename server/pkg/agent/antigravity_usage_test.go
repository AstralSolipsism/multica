package agent

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// Exercise the stream and Result contract, including a resumed request that
// fails before it can report any usage for the current turn.
func TestAntigravityUsagePresenceAndResume(t *testing.T) {
	t.Parallel()
	const zero = `{"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"total_tokens":0}`
	const historical = `{"input_tokens":100,"output_tokens":10,"total_tokens":110}`
	for _, tc := range []struct {
		name, resume, step, aggregate string
		reported                      bool
		want                          TokenUsage
	}{
		{name: "fresh terminal zero", aggregate: zero, reported: true},
		{name: "fresh terminal usage", aggregate: historical, reported: true, want: TokenUsage{InputTokens: 100, OutputTokens: 10}},
		{name: "fresh unreported", aggregate: "null"},
		{name: "resume historical aggregate", resume: "prior-conversation", aggregate: historical},
		{name: "resume aggregate zero still has no delta", resume: "prior-conversation", aggregate: zero},
		{name: "resume unreported step", resume: "prior-conversation", step: "null", aggregate: historical},
		{name: "resume confirmed zero step", resume: "prior-conversation", step: zero, aggregate: historical, reported: true},
		{name: "fresh zero step overrides aggregate", step: zero, aggregate: historical, reported: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script := "#!/bin/sh\n"
			script += `printf '%s\n' '{"event":"init","conversation_id":"current-conversation","init":{"model":"fixture-model"}}'` + "\n"
			if tc.step != "" {
				script += `printf '%s\n' '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","usage":` + tc.step + `}}'` + "\n"
			}
			script += `printf '%s\n' '{"event":"result","result":{"status":"ERROR","error":"fixture failure","usage":` + tc.aggregate + `}}'` + "\nexit 1\n"
			fakePath := filepath.Join(t.TempDir(), "agy")
			writeTestExecutable(t, fakePath, []byte(script))
			backend, err := New("antigravity", Config{ExecutablePath: fakePath, Logger: quietAntigravityLogger()})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			session, err := backend.Execute(ctx, "fixture prompt", ExecOptions{ResumeSessionID: tc.resume})
			if err != nil {
				t.Fatal(err)
			}
			for range session.Messages {
			}
			result := <-session.Result
			if result.Status != "failed" {
				t.Fatalf("status = %s, want failed", result.Status)
			}
			usage, reported := result.Usage["fixture-model"]
			if reported != tc.reported || usage != tc.want || (!tc.reported && len(result.Usage) != 0) {
				t.Fatalf("usage = %+v (reported %v), want %+v (reported %v)", result.Usage, reported, tc.want, tc.reported)
			}
		})
	}
}
