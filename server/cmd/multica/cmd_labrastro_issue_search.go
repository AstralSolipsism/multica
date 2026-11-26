package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

// OL-458 issue-search scope and paging. cmd_issue.go stays byte-identical to
// upstream, so the search command's fork flags, help and RunE live here.
// labrastroRunIssueSearch is upstream's runIssueSearch with the --scope and
// --offset handling and the paged JSON envelope added: when upstream changes
// its runIssueSearch, carry the change into this copy.

// issueSearchMaxLimit mirrors the page clamp in the server's SearchIssues
// handler; the two must move together.
const issueSearchMaxLimit = 50

func init() {
	issueSearchCmd.Long = "Search issues in the current workspace. The query matches issue titles,\n" +
		"descriptions, and comment bodies, so a conclusion that only lives in a\n" +
		"comment thread is still findable. Pass --scope title_desc to skip comments\n" +
		"when comment threads add too much noise or slow down large workspaces.\n\n" +
		"A bare number or an identifier-shaped query (\"412\", \"AGE-412\") matches\n" +
		"the issue with that number. The prefix is not validated, and number\n" +
		"matches rank first, so pasting an identifier from another tracker can\n" +
		"put an unrelated local issue at the top of the results.\n\n" +
		"The MATCH column (match_source in --output json) reports the strongest\n" +
		"field that matched — title, description, or comment — and falls back to\n" +
		"\"comment\" for a number-only hit (\"description\" with --scope title_desc,\n" +
		"where comments are skipped). Treat it as a display hint, not a\n" +
		"filter.\n\n" +
		"Results are paginated: --output json reports has_more, and --offset\n" +
		"advances by the number of issues in that same response."
	issueSearchCmd.RunE = labrastroRunIssueSearch
	issueSearchCmd.Flags().Lookup("limit").Usage = "Maximum number of results to return (values outside 1-50 use 50)"
	issueSearchCmd.Flags().Int("offset", 0, "Number of results to skip (for pagination; --output json reports has_more, advance it by the number of issues in that same response)")
	issueSearchCmd.Flags().String("scope", "all", "Match scope: all (title, description, comments) or title_desc (title and description only)")
}

func labrastroRunIssueSearch(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if client.WorkspaceID == "" {
		if _, err := requireWorkspaceID(cmd); err != nil {
			return err
		}
	}

	scope, _ := cmd.Flags().GetString("scope")
	if scope != "all" && scope != "title_desc" {
		return fmt.Errorf("invalid --scope %q: valid values are all, title_desc", scope)
	}

	includeClosed, _ := cmd.Flags().GetBool("include-closed")

	limit, _ := cmd.Flags().GetInt("limit")
	offset, _ := cmd.Flags().GetInt("offset")
	if offset < 0 {
		return fmt.Errorf("--offset must be zero or greater")
	}
	// The server caps the page at 50; echo the effective limit so callers
	// paging with offset += limit do not skip issues (OL-458 review #4).
	if limit <= 0 || limit > issueSearchMaxLimit {
		limit = issueSearchMaxLimit
	}

	params := url.Values{}
	params.Set("q", args[0])
	if limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", limit))
	}
	if offset > 0 {
		params.Set("offset", fmt.Sprintf("%d", offset))
	}
	if includeClosed {
		params.Set("include_closed", "true")
	}
	if scope == "title_desc" {
		params.Set("scope", scope)
	}
	if projectInput, _ := cmd.Flags().GetString("project"); projectInput != "" {
		project, err := resolveProjectID(ctx, client, projectInput)
		if err != nil {
			return err
		}
		params.Set("project_id", project.ID)
	}

	path := "/api/issues/search?" + params.Encode()

	var result map[string]any
	if err := client.GetJSON(ctx, path, &result); err != nil {
		return fmt.Errorf("search issues: %w", err)
	}

	issuesRaw, _ := result["issues"].([]any)
	hasMore, _ := result["has_more"].(bool)

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		wrapped := map[string]any{
			"issues":   issuesRaw,
			"limit":    limit,
			"offset":   offset,
			"has_more": hasMore,
		}
		return cli.PrintJSON(os.Stdout, wrapped)
	}

	headers := []string{"KEY", "TITLE", "STATUS", "MATCH"}
	rows := make([][]string, 0, len(issuesRaw))
	for _, raw := range issuesRaw {
		issue, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		matchInfo := strVal(issue, "match_source")
		if snippet := strVal(issue, "matched_snippet"); snippet != "" {
			if utf8.RuneCountInString(snippet) > 50 {
				runes := []rune(snippet)
				snippet = string(runes[:47]) + "..."
			}
			matchInfo += ": " + snippet
		}
		rows = append(rows, []string{
			strVal(issue, "identifier"),
			strVal(issue, "title"),
			strVal(issue, "status"),
			matchInfo,
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	if hasMore {
		fmt.Fprintf(os.Stderr, "More results available: --offset %d\n", offset+len(issuesRaw))
	}
	return nil
}
