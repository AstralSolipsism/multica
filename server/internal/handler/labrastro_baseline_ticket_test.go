package handler

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// OL-1243 acceptance 3: the ticket's commands must match the CLI exactly.
// The CLI side of this contract is pinned by TestLabrastroAnnotationTicketCommandsMatchCLI
// in server/cmd/multica, which asserts these same command lines resolve to
// registered subcommands with the referenced flags.
func TestBaselineReviewTicketCommands(t *testing.T) {
	batch := db.ProjectBaselineAnnotationBatch{Chapter: "domain_rules"}
	revision := db.ProjectBaselineRevision{RevisionNumber: 5, Status: "candidate"}
	annotations := []db.ProjectBaselineAnnotation{{Ordinal: 1, AnchorKind: "lines", SectionAnchor: "RULE-1", LineStart: pgtype.Int4{Int32: 2, Valid: true}, LineEnd: pgtype.Int4{Int32: 2, Valid: true}}}
	for _, appendReview := range []bool{false, true} {
		ticket := baselineReviewTicket(batch, db.ProjectBaselineReview{Summary: "总结"}, revision, annotations, appendReview, true)
		want := []string{
			"multica project baseline annotations ",
			"--batch ",
			"--with-sections",
		}
		if !appendReview {
			// The append-review comment carries only the pull command; the
			// full ticket additionally pins propose and respond.
			want = append(want,
				"multica project baseline propose ",
				"--section \"<anchor>\" --content-file … --source-issue <本任务> --base-current",
				"--replaces <候选号>",
				"multica project baseline respond ",
				"--responses-file ./responses.json",
			)
		}
		for _, w := range want {
			if !strings.Contains(ticket, w) {
				t.Fatalf("appendReview=%v ticket missing %q:\n%s", appendReview, w, ticket)
			}
		}
		if strings.Contains(ticket, "mention://agent/") && strings.Count(ticket, "mention://") != 1 {
			t.Fatalf("appendReview=%v ticket has more than one mention:\n%s", appendReview, ticket)
		}
	}
}
