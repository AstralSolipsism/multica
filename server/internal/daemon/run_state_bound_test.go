package daemon

import (
	"strings"
	"testing"
)

// TestRunStateStillBoundedAt4096 locks the owner decision's boundary: only
// the STEP state lost its whole-state trim; the run state keeps the 4096
// byte cap with the trim-from-the-end fallback (contract §4/§5 unchanged
// for run-level).
func TestRunStateStillBoundedAt4096(t *testing.T) {
	t.Parallel()
	// Worst realistic Chinese case: trigger 1000 + description 1500 runes.
	task := Task{
		ThreadName:            "标题",
		TriggerCommentContent: strings.Repeat("评", 1000),
		IssueDescription:      strings.Repeat("述", 1500),
	}
	state := BuildRunThinkingState(task, "claude", "claude-opus-5-5")
	if len(state) > runStateLimit {
		t.Fatalf("run state %d bytes exceeds the 4096 cap", len(state))
	}
}
