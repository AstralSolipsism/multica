package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

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
