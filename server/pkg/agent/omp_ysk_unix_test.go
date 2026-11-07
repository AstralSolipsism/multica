//go:build unix

package agent

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercise the actual launch and stream reader without an installed agent or model.
func TestOmpExecuteRoutesYouShouldKnowFrames(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, tc := range []struct {
		name     string
		callback bool
		advisor  *OmpRuntimeOpts
		args     []string
		want     string
	}{
		{name: "ordinary", callback: true, want: "false"},
		{name: "managed advisor", callback: true, advisor: &OmpRuntimeOpts{AdvisorEnabled: true}, want: "true"},
		{name: "custom advisor", callback: true, args: []string{"--advisor"}, want: "true"},
		{name: "no callback", want: "false"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			fake := filepath.Join(dir, "omp")
			launch := filepath.Join(dir, "launch.txt")
			extension := filepath.Join(dir, "ysk extension.ts")
			writeTestExecutable(t, fake, []byte(`#!/bin/sh
printf '%s\n' "$MULTICA_OMP_YSK_ADVISOR" "$@" > "$CAPTURE"
while [ "$#" -gt 0 ]; do
 case "$1" in
  --session-dir) sessionDir="$2"; shift ;;
 esac
 shift
done
cat >/dev/null
printf '%s\n' '{"type":"session","id":"test"}' > "$sessionDir/main.jsonl"
printf '%s\n' '{"type":"agent_start"}' '{"type":"turn_start"}'
printf '%s\n' '{"type":"labrastro_ysk","batch":{"ysk":1,"kind":"light","step":6,"tips":[{"tag":"you_should_know","line":"private-ysk-tip","title":"Cache","explanation":"No lock"}],"overturned":[]}}'
printf '%s\n' '{"type":"labrastro_ysk","batch":"malformed-private-ysk"}' '{"type":"labrastro_ysk","batch":{"ysk":9,"kind":"light"}}'
printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Task completed"}}'
printf '%s\n' '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Task completed"}]}}' '{"type":"agent_end"}'
`))
			backend, err := ResolveBackend("omp", Config{ExecutablePath: fake, Logger: slog.Default(), Env: map[string]string{
				ompYouShouldKnowExtensionEnv: extension, "CAPTURE": launch,
			}})
			if err != nil {
				t.Fatal(err)
			}
			var batches []json.RawMessage
			opts := ExecOptions{Timeout: 5 * time.Second, OmpRuntime: tc.advisor, CustomArgs: tc.args}
			if tc.callback {
				opts.OnYouShouldKnow = func(batch json.RawMessage) { batches = append(batches, batch) }
			}
			session, err := backend.Execute(t.Context(), "prompt", opts)
			if err != nil {
				t.Fatal(err)
			}
			for message := range session.Messages {
				data, _ := json.Marshal(message)
				if strings.Contains(string(data), "private-ysk") || strings.Contains(string(data), "labrastro_ysk") {
					t.Fatalf("YSK reached transcript: %s", data)
				}
			}
			result := <-session.Result
			if result.Status != "completed" || result.Output != "Task completed" {
				t.Fatalf("task output changed: %+v", result)
			}
			if (len(batches) == 1) != tc.callback || len(batches) > 1 {
				t.Fatalf("callback got %d batches", len(batches))
			}
			if tc.callback && !strings.Contains(string(batches[0]), "private-ysk-tip") {
				t.Fatalf("lost valid batch: %s", batches[0])
			}
			data, err := os.ReadFile(launch)
			if err != nil || !strings.HasPrefix(string(data), tc.want+"\n") || !strings.Contains(string(data), "--extension\n"+extension+"\n") {
				t.Fatalf("launch = %s (%v)", data, err)
			}
		})
	}
}
