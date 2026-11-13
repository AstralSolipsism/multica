package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func baselineExport(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
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
