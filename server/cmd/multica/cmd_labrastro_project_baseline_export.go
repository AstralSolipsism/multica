package main

import (
	"context"
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

type baselineSnapshotPage struct {
	Page     baselineCLIPage     `json:"page"`
	Revision baselineCLIRevision `json:"revision"`
	Content  string              `json:"content_markdown"`
	Parent   string
}

func baselineLoadSnapshot(ctx context.Context, client *cli.APIClient, base string) ([]baselineSnapshotPage, error) {
	var tree baselineCLITree
	if err := client.GetJSON(ctx, base+"/tree?sections=false", &tree); err != nil {
		return nil, baselineRequestError(err, false)
	}
	if tree.Pages == nil {
		return nil, baselineFailure(1, "invalid baseline tree response")
	}
	byID := map[string]string{}
	for _, page := range tree.Pages {
		byID[page.ID] = page.Slug
	}
	pages := make([]baselineSnapshotPage, 0, len(tree.Pages))
	for _, page := range tree.Pages {
		if page.ArchivedAt != nil {
			continue
		}
		var out baselineSnapshotPage
		if err := client.GetJSON(ctx, base+"/pages/"+url.PathEscape(page.Slug), &out); err != nil {
			return nil, baselineRequestError(err, false)
		}
		if out.Page.Slug != page.Slug || out.Page.ArchivedAt != nil {
			return nil, baselineFailure(1, "baseline changed during read; read the snapshot again")
		}
		if page.ParentID != nil {
			out.Parent = byID[*page.ParentID]
			if out.Parent == "" {
				return nil, baselineFailure(1, "missing parent for page %s", page.Slug)
			}
		}
		pages = append(pages, out)
	}
	return pages, nil
}

func baselineExport(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	pages, err := baselineLoadSnapshot(ctx, client, base)
	if err != nil {
		return err
	}

	single := mustString(cmd, "single-file")
	if single != "" {
		var sb strings.Builder
		for _, page := range pages {
			sb.WriteString(baselineSnapshotHeader(page))
			sb.WriteString(page.Content)
			sb.WriteString("\n\n")
		}
		return os.WriteFile(single, []byte(sb.String()), 0o644)
	}
	dir := mustString(cmd, "dir")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return baselineFailure(1, "cannot create --dir: %v", err)
	}
	for _, page := range pages {
		if !wikiExportSlugPattern.MatchString(page.Page.Slug) {
			return baselineFailure(2, "refusing to export unsafe slug %q", page.Page.Slug)
		}
		name := filepath.Join(dir, page.Page.Slug+".md")
		var sb strings.Builder
		sb.WriteString(baselineSnapshotHeader(page))
		sb.WriteString(page.Content)
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

func baselineSnapshotHeader(page baselineSnapshotPage) string {
	source := ""
	if page.Revision.SourceIssueID != nil {
		source = *page.Revision.SourceIssueID
	}
	header := baselineExportHeader(page.Page.Slug, page.Page.Title, page.Revision.Number, source, page.Revision.CreatedAt)
	if page.Parent != "" {
		header = strings.Replace(header, "\nrevision:", "\nparent: "+page.Parent+"\nrevision:", 1)
	}
	return header
}
