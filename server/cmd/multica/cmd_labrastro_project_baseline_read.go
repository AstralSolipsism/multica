package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

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
