package main

import (
	"os"
	"strings"
	"testing"
)

// The server ticket template (handler.baselineReviewTicket) instructs the
// woken agent with these exact command lines (OL-1243 acceptance 3). Pin the
// CLI side two ways: every referenced subcommand and flag must exist, and the
// propose line must satisfy the CLI's own required-flag validation when its
// placeholders are replaced with legal values. The handler-side test
// TestBaselineReviewTicketCommands pins the template to the same literals.
func TestLabrastroAnnotationTicketCommandsMatchCLI(t *testing.T) {
	cmdLines := []string{
		"multica project baseline annotations <project> --batch <batch> --with-sections",
		"multica project baseline propose <project> --chapter <chapter> --section \"<anchor>\" --content-file … --summary \"<变更说明>\" --source-issue <本任务> --base-current",
		"multica project baseline respond <project> --batch <batch> --responses-file ./responses.json",
	}
	for _, cmdLine := range cmdLines {
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
				t.Fatalf("%s is missing flag --%s used by the ticket template", fields[3], flag)
			}
		}
	}
	// Executing the propose line with placeholders swapped for legal values
	// must pass baselineValidate: a missing required flag (e.g. --summary)
	// fails here even though the literal check above stays green.
	t.Chdir(t.TempDir())
	if err := os.WriteFile("section.md", []byte("## [RULE-3] 结算规则\n正文\n"), 0600); err != nil {
		t.Fatal(err)
	}
	validated := strings.NewReplacer(
		"<project>", baselineTestProject,
		"<chapter>", "domain_rules",
		"<anchor>", "RULE-3",
		"<变更说明>", "按批注修订",
		"<本任务>", "OL-1240",
		"--content-file …", "--content-file ./section.md",
	).Replace(cmdLines[1])
	args := strings.Fields(validated)
	sub, _, err := newLabrastroProjectBaselineCmd().Find([]string{args[3]})
	if err != nil {
		t.Fatal(err)
	}
	if err := sub.ParseFlags(args[4:]); err != nil {
		t.Fatalf("ticket propose line does not parse: %v\n%s", err, cmdLines[1])
	}
	if err := baselineValidate(sub); err != nil {
		t.Fatalf("ticket propose line fails CLI validation (a woken agent copying it verbatim would exit 2): %v", err)
	}

	propose, _, _ := newLabrastroProjectBaselineCmd().Find([]string{"propose"})
	if propose.Flags().Lookup("responses-file") != nil || propose.Flags().Lookup("batch") != nil {
		t.Fatal("propose must not gain annotation flags")
	}
}
