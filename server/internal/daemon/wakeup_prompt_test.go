package daemon

import (
	"strings"
	"testing"
)

func TestWakeupPromptPreservesInstructionAndDeliveryThread(t *testing.T) {
	p := BuildPrompt(Task{IssueID: "issue", WakeupID: "wake", TriggerCommentID: "original", TriggerCommentContent: "old instruction", HandoffNote: "task.completed run-x; check its result"}, "codex")
	for _, want := range []string{"[WAKEUP]", ".multica/run-notes/", "wakeup get issue wake", "--parent original", "wakeup disable issue wake", "--roots-only"} {
		if !strings.Contains(p, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(p, "[NEW COMMENT]") || strings.Contains(p, "old instruction") || strings.Contains(p, "check its result") {
		t.Fatal("replayed the old comment instead of the wakeup")
	}
}
