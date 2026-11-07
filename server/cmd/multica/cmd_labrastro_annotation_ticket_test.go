package main

import (
	"strings"
	"testing"
)

// The server ticket template (handler.baselineReviewTicket) instructs the
// woken agent with these exact command lines (OL-1243 acceptance 3). Pin the
// CLI side: every referenced subcommand and flag must exist on this binary,
// and propose must not grow new flags. The handler-side test
// TestBaselineReviewTicketCommands pins the template to the same literals.
func TestLabrastroAnnotationTicketCommandsMatchCLI(t *testing.T) {
	for _, cmdLine := range []string{
		"multica project baseline annotations <project> --batch <batch> --with-sections",
		"multica project baseline propose <project> --chapter <chapter> --section \"<anchor>\" --content-file … --source-issue <本任务> --base-current",
		"multica project baseline respond <project> --batch <batch> --responses-file ./responses.json",
	} {
		fields := strings.Fields(cmdLine)
		if fields[0] != "multica" || fields[1] != "project" || fields[2] != "baseline" {
			t.Fatalf("unexpected command shape: %s", cmdLine)
		}
		sub, _, err := newLabrastroProjectBaselineCmd().Find([]string{fields[3]})
		if err != nil || sub.Name() != fields[3] {
			t.Fatalf("%s is not a registered baseline subcommand", fields[3])
		}
		for _, token := range fields[4:] {
			if !strings.HasPrefix(token, "--") {
				continue
			}
			flag := strings.TrimSuffix(strings.TrimPrefix(token, "--"), "…")
			if sub.Flags().Lookup(flag) == nil {
				t.Fatalf("%s is missing flag --%s used by the ticket template", fields[4], flag)
			}
		}
	}
	propose, _, _ := newLabrastroProjectBaselineCmd().Find([]string{"propose"})
	if propose.Flags().Lookup("responses-file") != nil || propose.Flags().Lookup("batch") != nil {
		t.Fatal("propose must not gain annotation flags")
	}
}
