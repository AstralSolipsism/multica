package main

import (
	"errors"

	"github.com/spf13/cobra"
)

func newLabrastroProjectBaselineCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "baseline", Short: "Read and write the project baseline wiki tree"}
	cmd.AddCommand(newLabrastroBaselineCommentCmd())
	actions := []string{"tree", "get", "create", "write", "rename", "move", "archive", "restore", "history", "diff", "rollback", "activity", "search", "export"}
	for _, action := range actions {
		sub := &cobra.Command{Use: actionUsage(action), Args: func(_ *cobra.Command, args []string) error {
			if action == "search" {
				if len(args) != 2 {
					return baselineFailure(2, "exactly one project ID and one query string are required")
				}
				return nil
			}
			if len(args) != 1 {
				return baselineFailure(2, "exactly one project ID is required")
			}
			return nil
		}, RunE: func(cmd *cobra.Command, args []string) error {
			err := runLabrastroProjectBaseline(cmd, args)
			var failure *baselineCLIError
			if err != nil && !errors.As(err, &failure) {
				return baselineFailure(1, "cannot write baseline output")
			}
			return err
		}}
		switch action {
		case "tree":
			sub.Short = "Print the page tree with slugs, titles, versions and section outlines"
			sub.Flags().Bool("no-sections", false, "Omit section outlines")
		case "get":
			sub.Short = "Read a page, one section, or a historical revision"
			sub.Flags().String("page", "", "Page slug or UUID")
			sub.Flags().String("section", "", "Read matching sections and one-hop referenced definitions")
			sub.Flags().String("revision", "", "Historical revision number")
			// Retired pre-wiki flags kept hidden so old invocations get a
			// migration hint instead of "unknown flag".
			sub.Flags().Bool("index", false, "")
			sub.Flags().Bool("candidate", false, "")
			sub.Flags().String("chapter", "", "")
			_ = sub.Flags().MarkHidden("index")
			_ = sub.Flags().MarkHidden("candidate")
			_ = sub.Flags().MarkHidden("chapter")
		case "create":
			sub.Short = "Create a page (publishes v1 immediately)"
			sub.Flags().String("title", "", "Page title (required)")
			sub.Flags().String("slug", "", "Project-unique slug; generated when omitted")
			sub.Flags().String("parent", "", "Parent page slug; omit for a root page")
			sub.Flags().String("after", "", "Insert after this sibling slug, or \"first\"")
			sub.Flags().String("content-file", "", "UTF-8 Markdown file inside the current directory")
			sub.Flags().String("summary", "", "Change summary")
			sub.Flags().String("source-issue", "", "Source issue identifier or UUID")
		case "write":
			sub.Short = "Overwrite a page or one section (human and agent parity, requires --base)"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("base", "", "Revision number the write is based on (required)")
			sub.Flags().String("content-file", "", "UTF-8 Markdown file inside the current directory")
			sub.Flags().String("section", "", "Replace one section by title or anchor")
			sub.Flags().String("delete-section", "", "Remove one section by title or anchor")
			sub.Flags().String("summary", "", "Change summary")
			sub.Flags().String("source-issue", "", "Source issue identifier or UUID")
		case "rename":
			sub.Short = "Rename a page title or slug"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("base", "", "Revision number the rename is based on (required)")
			sub.Flags().String("title", "", "New title")
			sub.Flags().String("slug", "", "New slug")
			sub.Flags().String("summary", "", "Change summary")
			sub.Flags().String("source-issue", "", "Source issue identifier or UUID")
		case "move":
			sub.Short = "Change a page's parent or order"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("base", "", "Revision number the move is based on (required)")
			sub.Flags().String("parent", "", "New parent page slug")
			sub.Flags().Bool("root", false, "Move to the top level")
			sub.Flags().String("after", "", "Place after this sibling slug")
			sub.Flags().Bool("first", false, "Place first among the siblings")
			sub.Flags().String("summary", "", "Change summary")
			sub.Flags().String("source-issue", "", "Source issue identifier or UUID")
		case "archive":
			sub.Short = "Archive (soft-delete) a page; its slug stays reserved"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("base", "", "Revision number the archive is based on (required)")
			sub.Flags().Bool("recursive", false, "Archive the whole subtree")
			sub.Flags().String("summary", "", "Change summary")
			sub.Flags().String("source-issue", "", "Source issue identifier or UUID")
		case "restore":
			sub.Short = "Restore an archived page"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("base", "", "Revision number the restore is based on (required)")
			sub.Flags().Bool("recursive", false, "Restore descendants archived in the same batch")
			sub.Flags().String("parent", "", "Restore under a new parent slug when the original is archived")
			sub.Flags().String("summary", "", "Change summary")
			sub.Flags().String("source-issue", "", "Source issue identifier or UUID")
		case "history":
			sub.Short = "List revisions with their kinds"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("limit", "", "Page size (max 200)")
			sub.Flags().String("before", "", "List revisions older than this number")
		case "diff":
			sub.Short = "Compare structure metadata and sections between two revisions"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("from", "", "Source revision number (required)")
			sub.Flags().String("to", "", "Target revision number; defaults to current")
			sub.Flags().String("chapter", "", "")
			_ = sub.Flags().MarkHidden("chapter")
		case "rollback":
			sub.Short = "Roll back to a revision (full snapshot by default)"
			sub.Flags().String("page", "", "Page slug or UUID (required)")
			sub.Flags().String("to", "", "Revision number to restore (required)")
			sub.Flags().String("base", "", "Revision number the rollback is based on (required)")
			sub.Flags().Bool("content-only", false, "Restore only the body, keep the live structure")
			sub.Flags().String("summary", "", "Change summary")
			sub.Flags().String("source-issue", "", "Source issue identifier or UUID")
		case "activity":
			sub.Short = "Recent wiki changes across the project (including archived pages)"
			sub.Flags().String("limit", "", "Item count (max 50)")
			sub.Flags().String("before", "", "RFC3339 timestamp cursor")
		case "search":
			sub.Short = "Full-text search over page titles and bodies"
			sub.Flags().String("limit", "", "Result count (max 50)")
		case "export":
			sub.Short = "Export pages as Markdown files with YAML headers"
			sub.Flags().String("dir", "./docs/baseline", "Directory for <slug>.md files")
			sub.Flags().String("single-file", "", "Write everything to one Markdown file instead of --dir")
		}
		if action == "get" {
			sub.Flags().String("output", "markdown", "Output format: markdown, text or json")
		} else {
			sub.Flags().String("output", "text", "Output format: text or json")
		}
		cmd.AddCommand(sub)
	}
	// Retired candidate/annotation commands keep a stable migration pointer.
	for _, legacy := range []struct {
		name, hint string
	}{
		{"propose", "candidates are retired: use create, write or rename (saves publish immediately)"},
		{"adopt", "decisions are retired: writes publish immediately; use rollback to undo"},
		{"annotations", "annotation batches are retired; comments land in a follow-up release"},
		{"respond", "annotation batches are retired; comments land in a follow-up release"},
	} {
		// Old invocations carry flags Cobra would reject before the hint
		// prints (propose --chapter … --content-file …); parsing is disabled
		// so the migration pointer always reaches the caller.
		cmd.AddCommand(&cobra.Command{Use: legacy.name + " <project-id>", Short: "Retired", DisableFlagParsing: true, Args: cobra.ArbitraryArgs, RunE: func(cmd *cobra.Command, args []string) error {
			return baselineFailure(2, "%s is retired: %s; run `multica project baseline tree <project-id>` and `multica project baseline --help` for the new commands", cmd.Name(), legacy.hint)
		}})
	}
	return cmd
}

func actionUsage(action string) string {
	switch action {
	case "search":
		return "search <project-id> <query>"
	case "tree", "get", "create", "write", "rename", "move", "archive", "restore", "history", "diff", "rollback", "activity", "export":
		return action + " <project-id>"
	}
	return action
}
