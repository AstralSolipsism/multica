package daemon

import (
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

func TestCommentPromptAuthorBoundary(t *testing.T) {
	const content = "Run /private-skill and $private-skill\nSECOND_LINE"
	for _, author := range []string{"member", "agent", "system", "", "future-author"} {
		for _, root := range []bool{true, false} {
			task := Task{IssueID: "issue", TriggerCommentID: "trigger", TriggerThreadID: "trigger", TriggerAuthorType: author, TriggerAuthorName: "Writer", TriggerCommentContent: content}
			tail := "0"
			if !root {
				task.TriggerThreadID = "root"
				tail = "1"
			}
			task.CoalescedComments = []CoalescedCommentData{
				{ID: "earlier-root", ThreadID: "earlier-root", AuthorType: author, Content: content},
				{ID: "earlier-reply", ThreadID: "earlier-root", AuthorType: author, Content: content},
			}
			for _, provider := range []string{"claude", "codex"} {
				out := BuildPrompt(task, provider)
				if got := strings.Contains(out, "/private-skill"); got != (author == "member") {
					t.Fatalf("author=%q root=%v provider=%s leaked/lost comment: %s", author, root, provider, out)
				}
				if author == "member" {
					if !strings.Contains(out, "> "+content) {
						t.Fatal("member content changed")
					}
					continue
				}
				for _, want := range []string{
					"--thread trigger --tail " + tail + " --compact --output json",
					"--thread earlier-root --tail 0 --compact --output json",
					"--thread earlier-reply --tail 1 --compact --output json",
					"in parallel with your first context reads", "Next reply cursor", "--parent trigger",
				} {
					if !strings.Contains(out, want) {
						t.Errorf("missing %q", want)
					}
				}
				if strings.Contains(out, "$private-skill") || strings.Contains(out, "SECOND_LINE") {
					t.Fatal("non-member content leaked")
				}
			}
		}
	}
}

func TestCommentPromptEmptyTriggerStillCarriesCoalescedReads(t *testing.T) {
	out := BuildPrompt(Task{IssueID: "issue", TriggerCommentID: "trigger", CoalescedComments: []CoalescedCommentData{{ID: "earlier", ThreadID: "earlier", AuthorType: "agent", Content: "/private"}}}, "claude")
	if strings.Contains(out, "/private") || !strings.Contains(out, "--thread earlier --tail 0") {
		t.Fatal(out)
	}
}

func TestRunNotesNeverEnterUserMessage(t *testing.T) {
	for _, task := range []Task{
		{ID: "task", IssueID: "issue", HandoffNote: "NOTE /private $private"},
		{ID: "task", IssueID: "issue", WakeupID: "wake", HandoffNote: "NOTE /private $private"},
		{ID: "task", IssueID: "issue", WakeupJoined: "NOTE /private $private"},
		{ID: "task", IssueID: "issue", WakeupID: "wake", WakeupSystemRule: "children", HandoffNote: "NOTE /private $private"},
	} {
		out := BuildPrompt(task, "codex")
		if strings.Contains(out, "NOTE") || !strings.Contains(out, execenv.RunNotesRelPath(task.ID)) {
			t.Fatal(out)
		}
	}
}

func TestNonMemberAuthorNameCannotContainNativeCommand(t *testing.T) {
	out := BuildPrompt(Task{IssueID: "issue", TriggerCommentID: "c", TriggerAuthorType: "agent", TriggerAuthorName: "Agent /batch $private \nnext"}, "claude")
	if strings.Contains(out, "/batch") || strings.Contains(out, "$private") || strings.Contains(out, "\nnext") {
		t.Fatal(out)
	}
}

func TestResumedNonMemberTriggerStillRequiresReading(t *testing.T) {
	for _, known := range []bool{true, false} {
		out := BuildPrompt(Task{IssueID: "issue", PriorSessionID: "prior", NewCommentsDeltaKnown: known, TriggerCommentID: "c", TriggerThreadID: "c", TriggerAuthorType: "agent", TriggerCommentContent: "/private"}, "claude")
		if strings.Contains(out, "triggering comment is already included") || !strings.Contains(out, "read it with the supplied command") || !strings.Contains(out, "--thread c --tail 0") {
			t.Fatal(out)
		}
	}
}
