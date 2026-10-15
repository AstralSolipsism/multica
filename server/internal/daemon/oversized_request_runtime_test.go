package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// A fake agy emits the real stream shape with a nonempty session ID on failure.
// Run through environment reuse, prompt rebuilding and retirement, not only
// the retry predicate. No installed agent or provider account is accessed.
func TestRunTaskOversizedRequestRecovery(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	for _, mode := range []string{"recover", "fresh also fails", "tools already ran"} {
		t.Run(mode, func(t *testing.T) {
			d, _, cleanup := newLeaderReuseTestDaemon(t)
			defer cleanup()
			capture := t.TempDir()
			fake := filepath.Join(t.TempDir(), "agy-fixture")
			writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo '1.0.6'; exit 0;; esac
attempt=1
if [ -f "$OL416_CAPTURE/count" ]; then
 attempt=$(cat "$OL416_CAPTURE/count")
 attempt=$((attempt + 1))
fi
printf '%s' "$attempt" > "$OL416_CAPTURE/count"
printf '%s\n' "$@" > "$OL416_CAPTURE/args-$attempt"
pwd > "$OL416_CAPTURE/cwd-$attempt"
if [ "$attempt" = 2 ] && [ "$OL416_MODE" = 'tools already ran' ]; then
 printf '%s\n' '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"output":"ok"}}}'
fi
if [ "$attempt" = 2 ] || { [ "$attempt" -gt 2 ] && [ "$OL416_MODE" = 'fresh also fails' ]; }; then
 printf '%s\n' '{"event":"result","result":{"conversation_id":"1a6d8f2-8523-46fc-8fc9-87e630cbe295","status":"ERROR","error":"FAILED_PRECONDITION (code 400): The message size (31402142 bytes) exceeds 30.000MB limit."}}'
 exit 1
fi
printf '{"event":"result","result":{"conversation_id":"%sa6d8f2-8523-46fc-8fc9-87e630cbe295","status":"SUCCESS","response":"done"}}\n' "$attempt"
`))
			d.cfg.Agents = map[string]AgentEntry{"antigravity": {Path: fake}}
			d.runtimeIndex["rt-leader"] = Runtime{ID: "rt-leader", Provider: "antigravity"}
			task := leaderReuseTestTask("oversized-first")
			task.IsLeaderTask = false
			task.Agent.CustomEnv = map[string]string{"OL416_CAPTURE": capture, "OL416_MODE": mode}
			first, err := d.runTask(t.Context(), task, "antigravity", 0, d.logger)
			if err != nil || first.Status != "completed" {
				t.Fatalf("seed: %+v, %v", first, err)
			}
			task.ID = "oversized-followup"
			task.PriorWorkDir, task.PriorSessionID = first.WorkDir, first.SessionID
			result, err := d.runTask(t.Context(), task, "antigravity", 0, d.logger)
			if err != nil {
				t.Fatal(err)
			}
			attempts := 3
			if mode == "tools already ran" {
				attempts = 2
			}
			count, err := os.ReadFile(filepath.Join(capture, "count"))
			if err != nil || string(count) != fmt.Sprint(attempts) {
				t.Fatalf("attempts=%s err=%v, want %d", count, err, attempts)
			}
			if !sameDir(t, result.WorkDir, first.WorkDir) {
				t.Fatal("retry lost working directory")
			}
			if mode == "recover" {
				if result.Status != "completed" || result.SessionID == first.SessionID || result.RetiredSessionID != first.SessionID {
					t.Fatalf("recovery: %+v", result)
				}
			} else if result.Status != "blocked" || result.FailureReason != FailureReasonAPIInvalidRequest {
				t.Fatalf("failure: %+v", result)
			}
			if attempts == 3 && result.RetiredSessionID != first.SessionID {
				t.Fatalf("missing retired session: %+v", result)
			}
			for attempt := 2; attempt <= attempts; attempt++ {
				args, err := os.ReadFile(filepath.Join(capture, fmt.Sprintf("args-%d", attempt)))
				if err != nil {
					t.Fatal(err)
				}
				if got := strings.Contains(string(args), "--conversation\n"); got != (attempt == 2) {
					t.Fatalf("attempt %d resume=%v", attempt, got)
				}
				if got := strings.Contains(string(args), execenv.SessionContinuityNoticeIssue); got != (attempt == 3) {
					t.Fatalf("attempt %d continuity=%v", attempt, got)
				}
				cwd, err := os.ReadFile(filepath.Join(capture, fmt.Sprintf("cwd-%d", attempt)))
				if err != nil || !sameDir(t, strings.TrimSpace(string(cwd)), first.WorkDir) {
					t.Fatalf("attempt %d cwd=%q err=%v", attempt, cwd, err)
				}
			}
		})
	}
}
