package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
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

type baselineCLIError struct {
	code    int
	message string
}

func (e *baselineCLIError) Error() string { return e.message }
func baselineFailure(code int, format string, args ...any) error {
	return &baselineCLIError{code, fmt.Sprintf(format, args...)}
}

// labrastroBaselineExitCode keeps the contract's 0/1/2/3 exit convention for
// this command family, including Cobra's flag/argument errors.
func labrastroBaselineExitCode(cmd *cobra.Command, err error) int {
	if err == nil {
		return 0
	}
	for c := cmd; c != nil; c = c.Parent() {
		if (c.Name() == "baseline" || c.Name() == "engineering") && c.Parent() != nil && c.Parent().Name() == "project" {
			var e *baselineCLIError
			if errors.As(err, &e) {
				return e.code
			}
			return 2
		}
	}
	return cli.ExitCodeFor(err)
}

// ---------- response shapes ----------

type baselineCLIPage struct {
	ID                    string  `json:"id"`
	Slug                  string  `json:"slug"`
	Title                 string  `json:"title"`
	ParentID              *string `json:"parent_id"`
	Position              int32   `json:"position"`
	ArchivedAt            *string `json:"archived_at"`
	CurrentRevisionNumber int32   `json:"current_revision_number"`
}

type baselineCLIRevision struct {
	ID            string  `json:"id"`
	PageID        string  `json:"page_id"`
	Number        int32   `json:"revision_number"`
	Kind          string  `json:"revision_kind"`
	Title         string  `json:"title"`
	Slug          string  `json:"slug"`
	Content       string  `json:"content_markdown"`
	Summary       string  `json:"change_summary"`
	SourceIssueID *string `json:"source_issue_id"`
	CreatedByType string  `json:"created_by_type"`
	CreatedByID   string  `json:"created_by_id"`
	CreatedAt     string  `json:"created_at"`
	RestoredFrom  *string `json:"restored_from_revision_id"`
}

type baselineCLITreePage struct {
	baselineCLIPage
	Depth         int `json:"depth"`
	RevisionCount int `json:"revision_count"`
	Current       *struct {
		Number        int32  `json:"number"`
		Kind          string `json:"kind"`
		CreatedAt     string `json:"created_at"`
		CreatedByType string `json:"created_by_type"`
		CreatedByID   string `json:"created_by_id"`
		ChangeSummary string `json:"change_summary"`
	} `json:"current"`
	Sections []struct {
		Anchor string `json:"anchor"`
		Title  string `json:"title"`
		Level  int    `json:"level"`
	} `json:"sections"`
}

type baselineCLITree struct {
	Pages []baselineCLITreePage `json:"pages"`
}

// ---------- validation ----------

func baselineNumber(s string) (int32, error) {
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil || n < 1 {
		return 0, baselineFailure(2, "revision number must be a positive 32-bit integer")
	}
	return int32(n), nil
}

func baselineValidate(cmd *cobra.Command) error {
	action, output := cmd.Name(), mustString(cmd, "output")
	valid := map[string][]string{
		"tree": {"text", "json"}, "get": {"markdown", "text", "json"}, "create": {"text", "json"},
		"write": {"text", "json"}, "rename": {"text", "json"}, "move": {"text", "json"},
		"archive": {"text", "json"}, "restore": {"text", "json"}, "history": {"text", "json"},
		"diff": {"text", "json"}, "rollback": {"text", "json"}, "activity": {"text", "json"},
		"search": {"text", "json"}, "export": {"text", "json"},
	}
	if !contains(valid[action], output) {
		return baselineFailure(2, "unsupported --output format")
	}
	needNumber := func(flag string) (int32, error) {
		value := mustString(cmd, flag)
		if value == "" {
			return 0, baselineFailure(2, "--%s is required", flag)
		}
		return baselineNumber(value)
	}
	optNumber := func(flag string) (int32, error) {
		if !cmd.Flags().Changed(flag) {
			return 0, nil
		}
		return baselineNumber(mustString(cmd, flag))
	}
	switch action {
	case "get":
		if index, _ := cmd.Flags().GetBool("index"); index {
			return baselineFailure(2, "--index is retired: use `multica project baseline tree <project-id>` for the page outline")
		}
		if candidate, _ := cmd.Flags().GetBool("candidate"); candidate {
			return baselineFailure(2, "--candidate is retired: writes publish immediately; use `history` and `diff` instead")
		}
		if chapter := mustString(cmd, "chapter"); chapter != "" {
			return baselineFailure(2, "--chapter is retired: use `get --page %s`; module:<name> becomes --page <name>, or run `tree` first when the slug was hashed or renamed", baselineChapterHint(chapter))
		}
		section := mustString(cmd, "section")
		if cmd.Flags().Changed("section") && strings.TrimSpace(section) == "" {
			return baselineFailure(2, "--section must not be empty")
		}
		if cmd.Flags().Changed("revision") {
			if strings.Contains(mustString(cmd, "revision"), ":") {
				return baselineFailure(2, "--revision chapter:number is retired: use `get --page <slug> --revision <n>` (built-in chapter keys are slugs)")
			}
			if _, err := needNumber("revision"); err != nil {
				return err
			}
			if mustString(cmd, "page") == "" {
				return baselineFailure(2, "--revision requires --page")
			}
		}
	case "create":
		if strings.TrimSpace(mustString(cmd, "title")) == "" {
			return baselineFailure(2, "--title is required")
		}
		if mustString(cmd, "content-file") == "" {
			// Content is optional for create; nothing to check.
			_ = 0
		}
	case "write":
		if mustString(cmd, "page") == "" {
			return baselineFailure(2, "--page is required")
		}
		base, err := needNumber("base")
		if err != nil {
			return err
		}
		_ = base
		section, deleting := mustString(cmd, "section"), mustString(cmd, "delete-section")
		if cmd.Flags().Changed("section") && strings.TrimSpace(section) == "" || cmd.Flags().Changed("delete-section") && strings.TrimSpace(deleting) == "" {
			return baselineFailure(2, "--section and --delete-section must not be empty")
		}
		if section != "" && deleting != "" {
			return baselineFailure(2, "use --section or --delete-section, not both")
		}
		if mustString(cmd, "content-file") == "" && deleting == "" {
			return baselineFailure(2, "--content-file is required (or use --delete-section)")
		}
	case "rename", "move", "archive", "restore", "history", "diff", "rollback":
		if mustString(cmd, "page") == "" {
			return baselineFailure(2, "--page is required")
		}
		switch action {
		case "rename":
			if _, err := needNumber("base"); err != nil {
				return err
			}
			if mustString(cmd, "title") == "" && mustString(cmd, "slug") == "" {
				return baselineFailure(2, "specify --title and/or --slug")
			}
		case "move":
			if _, err := needNumber("base"); err != nil {
				return err
			}
			parent, root := mustString(cmd, "parent"), cmd.Flags().Changed("root")
			first, _ := cmd.Flags().GetBool("first")
			if parent != "" && root || first && root || parent == "" && !root && !cmd.Flags().Changed("after") && !first {
				return baselineFailure(2, "specify --parent <slug>, --root, --after <slug> or --first")
			}
		case "archive", "restore", "rollback":
			if _, err := needNumber("base"); err != nil {
				return err
			}
			if action == "rollback" {
				if _, err := needNumber("to"); err != nil {
					return err
				}
			}
		case "history":
			if _, err := optNumber("limit"); err != nil {
				return err
			}
			if _, err := optNumber("before"); err != nil {
				return err
			}
		case "diff":
			if chapter := mustString(cmd, "chapter"); chapter != "" {
				return baselineFailure(2, "--chapter is retired: use `diff --page %s`; module:<name> becomes --page <name>, or run `tree` first", baselineChapterHint(chapter))
			}
			if _, err := needNumber("from"); err != nil {
				return err
			}
			if _, err := optNumber("to"); err != nil {
				return err
			}
		}
	case "export":
		if cmd.Flags().Changed("single-file") && (mustString(cmd, "single-file") == "" || cmd.Flags().Changed("dir")) {
			return baselineFailure(2, "use either a non-empty --single-file or --dir")
		}
		if mustString(cmd, "dir") == "" {
			return baselineFailure(2, "--dir must not be empty")
		}
	}
	return nil
}

// baselineChapterHint maps an old --chapter value to its closest new --page
// argument for migration hints.
func baselineChapterHint(chapter string) string {
	if slug, ok := strings.CutPrefix(chapter, "module:"); ok {
		return slug
	}
	return chapter
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// ---------- execution ----------

func runLabrastroProjectBaseline(cmd *cobra.Command, args []string) error {
	if err := baselineValidate(cmd); err != nil {
		return err
	}
	action := cmd.Name()
	var content string
	if action == "create" || action == "write" && mustString(cmd, "delete-section") == "" {
		if path := mustString(cmd, "content-file"); path != "" {
			var err error
			content, err = baselineReadContent(path)
			if err != nil {
				return err
			}
		}
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return baselineFailure(1, "%s", err)
	}
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	var lookupErr error
	project, err := resolveIDByPrefix(ctx, client, "project", args[0], func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		candidates, err := fetchProjectCandidates(ctx, client)
		lookupErr = err
		return candidates, err
	})
	if err != nil {
		if lookupErr != nil {
			return baselineRequestError(lookupErr, false)
		}
		return baselineFailure(2, "%s", err)
	}
	base := "/api/projects/" + project.ID + "/baseline"
	writing := action != "tree" && action != "get" && action != "history" && action != "diff" && action != "activity" && action != "search" && action != "export"

	switch action {
	case "tree":
		return baselineTree(ctx, cmd, client, base)
	case "get":
		return baselineGet(ctx, cmd, client, base)
	case "create":
		return baselineCreate(ctx, cmd, client, base, content)
	case "write":
		return baselineWrite(ctx, cmd, client, base, content)
	case "rename":
		return baselineRenameMove(ctx, cmd, client, base, true)
	case "move":
		return baselineRenameMove(ctx, cmd, client, base, false)
	case "archive", "restore":
		return baselineArchiveRestore(ctx, cmd, client, base, action == "archive")
	case "history":
		return baselineHistory(ctx, cmd, client, base)
	case "diff":
		return baselineDiff(ctx, cmd, client, base)
	case "rollback":
		return baselineRollback(ctx, cmd, client, base)
	case "activity":
		return baselineActivity(ctx, cmd, client, base)
	case "search":
		return baselineSearch(ctx, cmd, client, base, args[1])
	case "export":
		return baselineExport(ctx, cmd, client, base)
	}
	return baselineFailure(2, "unknown baseline subcommand %q (writing=%v)", action, writing)
}

func baselineRequestError(err error, writing bool) error {
	var e *cli.HTTPError
	if errors.As(err, &e) {
		code := cli.ServerErrorCode(err)
		if e.StatusCode == 401 {
			safe := *e
			safe.Body = ""
			return baselineFailure(1, "%s", cli.FormatError(&safe, false))
		}
		if e.StatusCode == 409 && code == "baseline_conflict" {
			return baselineFailure(3, "baseline conflict: the page changed since --base was read; re-read with tree/get, merge, then retry with the new --base (current revision is in the error body)")
		}
		if e.StatusCode >= 500 && writing {
			return baselineFailure(1, "baseline request failed (HTTP %d); result is indeterminate. Inspect baseline state before retrying.", e.StatusCode)
		}
		exit := 1
		if e.StatusCode == 400 || e.StatusCode == 404 || e.StatusCode == 422 {
			exit = 2
		}
		detail := fmt.Sprintf("HTTP %d", e.StatusCode)
		if code != "" {
			detail += ", " + code
		}
		return baselineFailure(exit, "baseline request failed (%s); inspect baseline state before retrying", detail)
	}
	if writing {
		return baselineFailure(1, "baseline request failed; result is indeterminate. Inspect baseline state before retrying.")
	}
	return baselineFailure(1, "baseline read failed; check project reference, connection and access")
}

func baselineReadContent(path string) (string, error) {
	return readProjectInputFile(path, "content-file", 65536)
}

func readProjectInputFile(path, flag string, limit int64) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", baselineFailure(2, "cannot locate current directory")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", baselineFailure(2, "invalid --%s path", flag)
	}
	rel, err := filepath.Rel(cwd, absolute)
	if err != nil || !filepath.IsLocal(rel) {
		return "", baselineFailure(2, "--%s must be inside the current directory", flag)
	}
	root, err := os.OpenRoot(cwd)
	if err != nil {
		return "", baselineFailure(2, "cannot open current directory")
	}
	defer root.Close()
	info, err := root.Stat(rel)
	if err != nil || !info.Mode().IsRegular() {
		return "", baselineFailure(2, "--%s must be a regular file inside the current directory", flag)
	}
	f, err := root.Open(rel)
	if err != nil {
		return "", baselineFailure(2, "cannot open --%s inside the current directory", flag)
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", baselineFailure(2, "--%s must be a regular file", flag)
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return "", baselineFailure(2, "cannot read --%s", flag)
	}
	if int64(len(data)) > limit || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return "", baselineFailure(2, "--%s must contain at most %d bytes of UTF-8 text without NUL bytes", flag, limit)
	}
	return string(data), nil
}

// ---------- shared helpers ----------

func baselinePrintWriteResult(cmd *cobra.Command, raw json.RawMessage, action string) error {
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var out struct {
		Page     baselineCLIPage     `json:"page"`
		Revision baselineCLIRevision `json:"revision"`
		Rebased  bool                `json:"rebased"`
		Pages    []struct {
			Page     baselineCLIPage     `json:"page"`
			Revision baselineCLIRevision `json:"revision"`
		} `json:"pages"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Page.Slug == "" && len(out.Pages) == 0 {
		return baselineFailure(1, "invalid baseline write response")
	}
	if out.Page.Slug != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "%s: %s v%d (%s)%s\n", action, out.Page.Slug, out.Revision.Number, out.Revision.Summary, rebasedMark(out.Rebased))
		return nil
	}
	for _, item := range out.Pages {
		fmt.Fprintf(cmd.OutOrStdout(), "%s: %s v%d (%s)\n", action, item.Page.Slug, item.Revision.Number, item.Revision.Summary)
	}
	return nil
}

func rebasedMark(rebased bool) string {
	if rebased {
		return " [rebased]"
	}
	return ""
}

// ---------- subcommands ----------

func baselineTree(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	query := url.Values{}
	if noSections, _ := cmd.Flags().GetBool("no-sections"); noSections {
		query.Set("sections", "false")
	}
	var raw json.RawMessage
	if err := client.GetJSON(ctx, base+"/tree?"+query.Encode(), &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var tree baselineCLITree
	if json.Unmarshal(raw, &tree) != nil {
		return baselineFailure(1, "invalid baseline tree response")
	}
	if len(tree.Pages) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "(no pages; enable engineering and create the first page)")
		return nil
	}
	children := map[string][]baselineCLITreePage{}
	roots := []baselineCLITreePage{}
	for _, page := range tree.Pages {
		if page.ArchivedAt != nil {
			continue
		}
		key := ""
		if page.ParentID != nil {
			key = *page.ParentID
		}
		if key == "" {
			roots = append(roots, page)
		} else {
			children[key] = append(children[key], page)
		}
	}
	var walk func(page baselineCLITreePage)
	walk = func(page baselineCLITreePage) {
		fmt.Fprintf(cmd.OutOrStdout(), "%s%s v%d %s\n", strings.Repeat("  ", page.Depth-1), page.Slug, page.currentRevision(), page.Title)
		for _, section := range page.Sections {
			if section.Level >= 2 && section.Level <= 3 {
				fmt.Fprintf(cmd.OutOrStdout(), "%s  # %s\n", strings.Repeat("  ", page.Depth-1), section.Title)
			}
		}
		for _, child := range children[page.ID] {
			walk(child)
		}
	}
	for _, root := range roots {
		walk(root)
	}
	archived := 0
	for _, page := range tree.Pages {
		if page.ArchivedAt != nil {
			archived++
		}
	}
	if archived > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "(%d archived page(s); restore with `restore`)\n", archived)
	}
	return nil
}

func (p baselineCLITreePage) currentRevision() int32 {
	if p.Current != nil {
		return p.Current.Number
	}
	return p.CurrentRevisionNumber
}

func baselineGet(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	query := url.Values{}
	page, section, revision := mustString(cmd, "page"), mustString(cmd, "section"), mustString(cmd, "revision")
	if page != "" {
		query.Set("page", "")
	}
	output := mustString(cmd, "output")
	if section != "" && page == "" {
		// Cross-page section lookup falls back to tree + per-page reads.
		return baselineGetSectionAcrossPages(ctx, cmd, client, base, section)
	}
	if page == "" {
		return baselineFailure(2, "--page is required (or --section for a cross-page lookup)")
	}
	path := base + "/pages/" + url.PathEscape(page)
	if revision != "" {
		query.Set("revision", revision)
	}
	if section != "" {
		query.Set("section", section)
	}
	if output == "json" {
		query.Set("with", "links,backlinks,related_issues")
	}
	var raw json.RawMessage
	if err := client.GetJSON(ctx, path+"?"+query.Encode(), &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var out struct {
		Page     baselineCLIPage     `json:"page"`
		Revision baselineCLIRevision `json:"revision"`
		Content  string              `json:"content_markdown"`
		Sections []struct {
			Page   string `json:"page"`
			Anchor string `json:"anchor"`
			Title  string `json:"title"`
			Body   string `json:"content_markdown"`
		} `json:"sections"`
		ReferencedSections []struct {
			Page       string `json:"page"`
			Anchor     string `json:"anchor"`
			Title      string `json:"title"`
			Definition string `json:"definition"`
			Why        string `json:"why"`
		} `json:"referenced_sections"`
	}
	if json.Unmarshal(raw, &out) != nil || out.Page.Slug == "" {
		return baselineFailure(1, "invalid baseline page response")
	}
	// The version header gives agents the --base number straight from `get`.
	// Markdown stdout must stay byte-identical to the page body so
	// `get > page.md` → edit → `write --content-file page.md` round-trips
	// without polluting the body; the header goes to stderr there.
	if output == "markdown" {
		fmt.Fprintf(cmd.ErrOrStderr(), "%s v%d · %s\n\n", out.Page.Slug, out.Revision.Number, out.Page.Title)
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "%s v%d · %s\n\n", out.Page.Slug, out.Revision.Number, out.Page.Title)
	}
	if len(out.Sections) > 0 {
		for _, s := range out.Sections {
			fmt.Fprintf(cmd.OutOrStdout(), "# %s\n\n%s\n", s.Title, s.Body)
		}
		for _, ref := range out.ReferencedSections {
			fmt.Fprintf(cmd.OutOrStdout(), "→ [%s] %s\n", ref.Page, ref.Title)
			if ref.Definition != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "  %s\n", ref.Definition)
			}
		}
		return nil
	}
	fmt.Fprint(cmd.OutOrStdout(), out.Content)
	if output == "text" {
		fmt.Fprintln(cmd.OutOrStdout())
	}
	return nil
}

func baselineGetSectionAcrossPages(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base, section string) error {
	var tree baselineCLITree
	if err := client.GetJSON(ctx, base+"/tree", &tree); err != nil {
		return baselineRequestError(err, false)
	}
	if mustString(cmd, "output") == "json" {
		return baselineFailure(2, "cross-page --section reads require --page with --output json")
	}
	query := strings.ToLower(section)
	matched := false
	seenRefs := map[string]bool{}
	for _, page := range tree.Pages {
		pageMatches := false
		for _, s := range page.Sections {
			if strings.Contains(strings.ToLower(s.Title), query) || strings.Contains(strings.ToLower(s.Anchor), query) {
				pageMatches = true
				break
			}
		}
		if !pageMatches {
			continue
		}
		matched = true
		var raw json.RawMessage
		path := base + "/pages/" + url.PathEscape(page.Slug) + "?" + url.Values{"section": {section}}.Encode()
		if err := client.GetJSON(ctx, path, &raw); err != nil {
			return baselineRequestError(err, false)
		}
		var out struct {
			Sections []struct {
				Title string `json:"title"`
				Body  string `json:"content_markdown"`
			} `json:"sections"`
			ReferencedSections []struct {
				Page       string `json:"page"`
				Title      string `json:"title"`
				Definition string `json:"definition"`
				Why        string `json:"why"`
			} `json:"referenced_sections"`
		}
		if json.Unmarshal(raw, &out) != nil {
			return baselineFailure(1, "invalid baseline section response")
		}
		for _, s := range out.Sections {
			fmt.Fprintf(cmd.OutOrStdout(), "[%s] # %s\n\n%s\n", page.Slug, s.Title, s.Body)
		}
		for _, ref := range out.ReferencedSections {
			key := ref.Page + "\x00" + ref.Title
			if seenRefs[key] {
				continue
			}
			seenRefs[key] = true
			fmt.Fprintf(cmd.OutOrStdout(), "→ [%s] %s", ref.Page, ref.Title)
			if ref.Why != "" {
				fmt.Fprintf(cmd.OutOrStdout(), " — %s", ref.Why)
			}
			fmt.Fprintln(cmd.OutOrStdout())
		}
	}
	if !matched {
		return baselineFailure(2, "no section matches %q; run `multica project baseline tree <project-id>` for the outline", section)
	}
	return nil
}

func baselineCreate(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base, content string) error {
	body := map[string]any{"title": mustString(cmd, "title")}
	if flag := mustString(cmd, "slug"); flag != "" {
		body["slug"] = flag
	}
	if flag := mustString(cmd, "parent"); flag != "" {
		body["parent"] = flag
	}
	if flag := mustString(cmd, "after"); flag != "" {
		body["after"] = flag
	}
	if content != "" {
		body["content_markdown"] = content
	}
	if flag := mustString(cmd, "summary"); flag != "" {
		body["change_summary"] = flag
	}
	source, err := baselineSourceIssueParam(ctx, cmd, client)
	if err != nil {
		return err
	}
	if source != nil {
		body["source_issue_id"] = *source
	}
	var raw json.RawMessage
	if err := client.PostJSON(ctx, base+"/pages", body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	return baselinePrintWriteResult(cmd, raw, "created")
}

func baselineSourceIssueParam(ctx context.Context, cmd *cobra.Command, client *cli.APIClient) (*string, error) {
	value := mustString(cmd, "source-issue")
	if value == "" {
		return nil, nil
	}
	resolved, err := baselineResolveSourceIssue(ctx, client, value)
	if err != nil {
		return nil, err
	}
	return &resolved, nil
}

func baselineResolveSourceIssue(ctx context.Context, client *cli.APIClient, value string) (string, error) {
	if uuidRegexp.MatchString(value) {
		return value, nil
	}
	issue, err := fetchIssueRef(ctx, client, value)
	if err != nil {
		return "", baselineFailure(2, "cannot resolve --source-issue %q: %v", value, err)
	}
	return issue.ID, nil
}

func baselineWrite(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base, content string) error {
	baseNumber, err := baselineNumber(mustString(cmd, "base"))
	if err != nil {
		return err
	}
	body := map[string]any{"base_revision_number": baseNumber}
	section, deleting := mustString(cmd, "section"), mustString(cmd, "delete-section")
	switch {
	case deleting != "":
		body["delete_section"] = deleting
	case section != "":
		body["section"] = section
		body["content_markdown"] = content
	default:
		body["content_markdown"] = content
	}
	if flag := mustString(cmd, "summary"); flag != "" {
		body["change_summary"] = flag
	}
	source, err := baselineSourceIssueParam(ctx, cmd, client)
	if err != nil {
		return err
	}
	if source != nil {
		body["source_issue_id"] = *source
	}
	var raw json.RawMessage
	if err := client.PutJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/content", body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	return baselinePrintWriteResult(cmd, raw, "written")
}

func baselineRenameMove(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, renaming bool) error {
	baseNumber, err := baselineNumber(mustString(cmd, "base"))
	if err != nil {
		return err
	}
	body := map[string]any{"base_revision_number": baseNumber}
	if renaming {
		if flag := mustString(cmd, "title"); flag != "" {
			body["title"] = flag
		}
		if flag := mustString(cmd, "slug"); flag != "" {
			body["slug"] = flag
		}
	} else {
		if flag := mustString(cmd, "parent"); flag != "" {
			body["parent"] = flag
		} else if root, _ := cmd.Flags().GetBool("root"); root {
			body["parent"] = nil
		}
		if first, _ := cmd.Flags().GetBool("first"); first {
			body["after"] = "first"
		} else if flag := mustString(cmd, "after"); flag != "" {
			body["after"] = flag
		}
	}
	if flag := mustString(cmd, "summary"); flag != "" {
		body["change_summary"] = flag
	}
	source, err := baselineSourceIssueParam(ctx, cmd, client)
	if err != nil {
		return err
	}
	if source != nil {
		body["source_issue_id"] = *source
	}
	var raw json.RawMessage
	if err := client.PatchJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page")), body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	return baselinePrintWriteResult(cmd, raw, map[bool]string{true: "renamed", false: "moved"}[renaming])
}

func baselineArchiveRestore(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, archiving bool) error {
	baseNumber, err := baselineNumber(mustString(cmd, "base"))
	if err != nil {
		return err
	}
	body := map[string]any{"base_revision_number": baseNumber}
	if recursive, _ := cmd.Flags().GetBool("recursive"); recursive {
		body["recursive"] = true
	}
	if flag := mustString(cmd, "parent"); flag != "" {
		body["parent"] = flag
	}
	if flag := mustString(cmd, "summary"); flag != "" {
		body["change_summary"] = flag
	}
	source, err := baselineSourceIssueParam(ctx, cmd, client)
	if err != nil {
		return err
	}
	if source != nil {
		body["source_issue_id"] = *source
	}
	action := "archive"
	if !archiving {
		action = "restore"
	}
	var raw json.RawMessage
	if err := client.PostJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/"+action, body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	return baselinePrintWriteResult(cmd, raw, action+"d")
}

func baselineHistory(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	query := url.Values{"with_content": {"false"}}
	if flag := mustString(cmd, "limit"); flag != "" {
		query.Set("limit", flag)
	}
	if flag := mustString(cmd, "before"); flag != "" {
		query.Set("before", flag)
	}
	var raw json.RawMessage
	if err := client.GetJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/revisions?"+query.Encode(), &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var out struct {
		Revisions []baselineCLIRevision `json:"revisions"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return baselineFailure(1, "invalid baseline history response")
	}
	for _, revision := range out.Revisions {
		fmt.Fprintf(cmd.OutOrStdout(), "v%-4d %-8s %s\n", revision.Number, revision.Kind, revision.Summary)
		fmt.Fprintf(cmd.OutOrStdout(), "      by %s %s at %s\n", revision.CreatedByType, revision.CreatedByID, revision.CreatedAt)
	}
	return nil
}

func baselineDiff(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	query := url.Values{"from": {mustString(cmd, "from")}}
	if flag := mustString(cmd, "to"); flag != "" {
		query.Set("to", flag)
	}
	var raw json.RawMessage
	if err := client.GetJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/diff?"+query.Encode(), &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var out struct {
		Structure map[string]struct {
			From any `json:"from"`
			To   any `json:"to"`
		} `json:"structure"`
		Sections struct {
			Added    []map[string]any `json:"added"`
			Modified []map[string]any `json:"modified"`
			Removed  []map[string]any `json:"removed"`
		} `json:"sections"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return baselineFailure(1, "invalid baseline diff response")
	}
	if len(out.Structure) == 0 && len(out.Sections.Added) == 0 && len(out.Sections.Modified) == 0 && len(out.Sections.Removed) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "no differences")
		return nil
	}
	for _, field := range []string{"title", "slug", "parent", "position", "archived"} {
		if change, ok := out.Structure[field]; ok {
			fmt.Fprintf(cmd.OutOrStdout(), "%s: %v → %v\n", field, change.From, change.To)
		}
	}
	for _, section := range out.Sections.Added {
		fmt.Fprintf(cmd.OutOrStdout(), "+ %v\n", section["title"])
	}
	for _, section := range out.Sections.Modified {
		fmt.Fprintf(cmd.OutOrStdout(), "~ %v\n", section["title"])
		fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", section["before"])
		fmt.Fprintf(cmd.OutOrStdout(), "+ %s\n", section["after"])
	}
	for _, section := range out.Sections.Removed {
		fmt.Fprintf(cmd.OutOrStdout(), "- %v\n", section["title"])
	}
	return nil
}

func baselineRollback(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	to, err := baselineNumber(mustString(cmd, "to"))
	if err != nil {
		return err
	}
	baseNumber, err := baselineNumber(mustString(cmd, "base"))
	if err != nil {
		return err
	}
	body := map[string]any{"revision_number": to, "base_revision_number": baseNumber}
	if contentOnly, _ := cmd.Flags().GetBool("content-only"); contentOnly {
		body["content_only"] = true
	}
	if flag := mustString(cmd, "summary"); flag != "" {
		body["change_summary"] = flag
	}
	source, err := baselineSourceIssueParam(ctx, cmd, client)
	if err != nil {
		return err
	}
	if source != nil {
		body["source_issue_id"] = *source
	}
	var raw json.RawMessage
	if err := client.PostJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/rollback", body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	return baselinePrintWriteResult(cmd, raw, "rolled back")
}

func baselineActivity(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	query := url.Values{}
	if flag := mustString(cmd, "limit"); flag != "" {
		query.Set("limit", flag)
	}
	if flag := mustString(cmd, "before"); flag != "" {
		query.Set("before", flag)
	}
	var raw json.RawMessage
	if err := client.GetJSON(ctx, base+"/activity?"+query.Encode(), &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var out struct {
		Items []map[string]any `json:"items"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return baselineFailure(1, "invalid baseline activity response")
	}
	for _, item := range out.Items {
		fmt.Fprintf(cmd.OutOrStdout(), "%v v%v %v — %v (%v %v, %v)\n", item["slug"], item["number"], item["kind"], item["change_summary"], item["created_by_type"], item["created_by_id"], item["created_at"])
	}
	return nil
}

func baselineSearch(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base, queryString string) error {
	query := url.Values{"q": {queryString}}
	if flag := mustString(cmd, "limit"); flag != "" {
		query.Set("limit", flag)
	}
	var raw json.RawMessage
	if err := client.GetJSON(ctx, base+"/search?"+query.Encode(), &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var out struct {
		Results []struct {
			Slug         string `json:"slug"`
			Title        string `json:"title"`
			SectionTitle string `json:"section_title"`
			Snippet      string `json:"snippet"`
			Match        string `json:"match"`
		} `json:"results"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return baselineFailure(1, "invalid baseline search response")
	}
	for _, hit := range out.Results {
		section := hit.SectionTitle
		if section != "" {
			section = "#" + section
		}
		fmt.Fprintf(cmd.OutOrStdout(), "[%s%s] %s (%s)\n    %s\n", hit.Slug, section, hit.Title, hit.Match, hit.Snippet)
	}
	if len(out.Results) == 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "no matches for %q\n", queryString)
	}
	return nil
}

func baselineExport(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	var bodies struct {
		Results []struct {
			PageID   string `json:"page_id"`
			Slug     string `json:"slug"`
			Title    string `json:"title"`
			Revision int32  `json:"revision_number"`
			Content  string `json:"content_markdown"`
		} `json:"results"`
	}
	// Reuse search's SQL shape by requesting every page through the tree and
	// one page read per slug.
	var tree baselineCLITree
	if err := client.GetJSON(ctx, base+"/tree?sections=false", &tree); err != nil {
		return baselineRequestError(err, false)
	}
	type exported struct {
		slug      string
		title     string
		number    int32
		content   string
		source    string
		updatedAt string
	}
	pages := make([]exported, 0, len(tree.Pages))
	for _, page := range tree.Pages {
		if page.ArchivedAt != nil {
			continue
		}
		var raw json.RawMessage
		if err := client.GetJSON(ctx, base+"/pages/"+url.PathEscape(page.Slug), &raw); err != nil {
			return baselineRequestError(err, false)
		}
		var out struct {
			Page     baselineCLIPage     `json:"page"`
			Revision baselineCLIRevision `json:"revision"`
			Content  string              `json:"content_markdown"`
		}
		if json.Unmarshal(raw, &out) != nil {
			return baselineFailure(1, "invalid baseline page response")
		}
		source := ""
		if out.Revision.SourceIssueID != nil {
			source = *out.Revision.SourceIssueID
		}
		pages = append(pages, exported{out.Page.Slug, out.Page.Title, out.Revision.Number, out.Content, source, out.Revision.CreatedAt})
	}
	_ = bodies
	single := mustString(cmd, "single-file")
	if single != "" {
		var sb strings.Builder
		for _, page := range pages {
			sb.WriteString(baselineExportHeader(page.slug, page.title, page.number, page.source, page.updatedAt))
			sb.WriteString(page.content)
			sb.WriteString("\n\n")
		}
		return os.WriteFile(single, []byte(sb.String()), 0o644)
	}
	dir := mustString(cmd, "dir")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return baselineFailure(1, "cannot create --dir: %v", err)
	}
	for _, page := range pages {
		if !wikiExportSlugPattern.MatchString(page.slug) {
			return baselineFailure(2, "refusing to export unsafe slug %q", page.slug)
		}
		name := filepath.Join(dir, page.slug+".md")
		var sb strings.Builder
		sb.WriteString(baselineExportHeader(page.slug, page.title, page.number, page.source, page.updatedAt))
		sb.WriteString(page.content)
		sb.WriteString("\n")
		if err := os.WriteFile(name, []byte(sb.String()), 0o644); err != nil {
			return baselineFailure(1, "cannot write %s: %v", name, err)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s\n", name)
	}
	return nil
}

var wikiExportSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

func baselineExportHeader(slug, title string, number int32, source, revisionAt string) string {
	header := fmt.Sprintf("---\nslug: %s\ntitle: %q\nrevision: %d\n", slug, title, number)
	if source != "" {
		header += fmt.Sprintf("source_issue: %s\n", source)
	}
	if revisionAt != "" {
		header += fmt.Sprintf("revision_at: %s\n", revisionAt)
	}
	header += fmt.Sprintf("exported_at: %s\n---\n\n", time.Now().UTC().Format(time.RFC3339))
	return header
}
