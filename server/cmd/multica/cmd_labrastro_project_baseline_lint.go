package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

func baselineLintArgs(cmd *cobra.Command, args []string) error {
	dir := mustString(cmd, "dir")
	if len(args) > 1 || (len(args) == 1) == (dir != "") || cmd.Flags().Changed("dir") && strings.TrimSpace(dir) == "" || len(args) == 1 && strings.TrimSpace(args[0]) == "" {
		return baselineFailure(2, "specify exactly one project ID or --dir <local-export-dir>")
	}
	if cmd.Flags().Changed("page") && !engineering.ValidSlug(mustString(cmd, "page")) {
		return baselineFailure(2, "--page must be a valid page slug")
	}
	return nil
}

func baselineLintOnline(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string) error {
	snapshot, err := baselineLoadSnapshot(ctx, client, base)
	if err != nil {
		return baselineFailure(1, "%s", err)
	}
	pages := make([]engineering.LintPage, 0, len(snapshot))
	for _, p := range snapshot {
		// A non-nil (possibly empty) list is authoritative: an online lint can
		// tell a missing canvas attachment from an offline read that cannot.
		attachments := make([]string, 0, len(p.Attachments))
		for _, att := range p.Attachments {
			attachments = append(attachments, att.Filename)
		}
		pages = append(pages, engineering.LintPage{
			WikiPageContent: engineering.WikiPageContent{Slug: p.Page.Slug, Title: p.Page.Title, Content: p.Content},
			Parent:          p.Parent,
			Attachments:     attachments,
		})
	}
	return baselineLintPrint(cmd, pages)
}

func baselineLintReadDir(dir string) ([]engineering.LintPage, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, baselineFailure(2, "cannot locate current directory")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, baselineFailure(2, "invalid --dir path")
	}
	rel, err := filepath.Rel(cwd, absolute)
	if err != nil || !filepath.IsLocal(rel) {
		return nil, baselineFailure(2, "--dir must be inside the current directory")
	}
	root, err := os.OpenRoot(cwd)
	if err != nil {
		return nil, baselineFailure(2, "cannot open current directory")
	}
	defer root.Close()
	folder, err := root.Open(rel)
	if err != nil {
		return nil, baselineFailure(2, "cannot open --dir inside the current directory")
	}
	defer folder.Close()
	entries, err := folder.ReadDir(-1)
	if err != nil {
		return nil, baselineFailure(2, "--dir must be a readable directory")
	}
	pages := []engineering.LintPage{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		data, err := readProjectInputFile(filepath.Join(dir, entry.Name()), "dir", 65536+4096)
		if err != nil {
			return nil, err
		}
		data = strings.ReplaceAll(data, "\r\n", "\n")
		header, body, found := strings.Cut(strings.TrimPrefix(data, "---\n"), "\n---\n")
		if !strings.HasPrefix(data, "---\n") || !found {
			return nil, baselineFailure(2, "%s: expected exported YAML frontmatter", entry.Name())
		}
		var meta struct {
			Slug   string `yaml:"slug"`
			Title  string `yaml:"title"`
			Parent string `yaml:"parent"`
		}
		if err := yaml.Unmarshal([]byte(header), &meta); err != nil || !engineering.ValidSlug(meta.Slug) || !engineering.ValidWikiTitle(meta.Title) || meta.Parent != "" && !engineering.ValidSlug(meta.Parent) {
			return nil, baselineFailure(2, "%s: invalid slug, title or parent in frontmatter", entry.Name())
		}
		// Export places one separator line before and one newline after the body.
		body = strings.TrimSuffix(strings.TrimPrefix(body, "\n"), "\n")
		pages = append(pages, engineering.LintPage{WikiPageContent: engineering.WikiPageContent{Slug: meta.Slug, Title: meta.Title, Content: body}, Parent: meta.Parent})
		if len(pages) > engineering.MaxWikiPages {
			return nil, baselineFailure(2, "--dir exceeds %d pages", engineering.MaxWikiPages)
		}
	}
	if len(pages) == 0 {
		return nil, baselineFailure(2, "--dir has no exported Markdown pages")
	}
	parents := map[string]string{}
	for _, p := range pages {
		if _, exists := parents[p.Slug]; exists {
			return nil, baselineFailure(2, "duplicate page slug %s", p.Slug)
		}
		parents[p.Slug] = p.Parent
	}
	for _, p := range pages {
		seen := map[string]bool{p.Slug: true}
		for parent := p.Parent; parent != ""; {
			next, exists := parents[parent]
			if !exists || seen[parent] {
				return nil, baselineFailure(2, "%s: missing or cyclic parent %s", p.Slug, parent)
			}
			seen[parent] = true
			parent = next
		}
	}
	return pages, nil
}

func baselineLintPrint(cmd *cobra.Command, pages []engineering.LintPage) error {
	page := mustString(cmd, "page")
	if page != "" {
		found := false
		for _, p := range pages {
			if p.Slug == page {
				found = true
				break
			}
		}
		if !found {
			return baselineFailure(2, "--page %q is not an active page", page)
		}
	}
	result := engineering.Lint(pages, page)
	if mustString(cmd, "output") == "json" {
		if err := cli.PrintJSON(cmd.OutOrStdout(), result); err != nil {
			return err
		}
	} else {
		for _, d := range result.Diagnostics {
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "%s:%d [%s] %s %s: %s\n", d.Page, d.Line, d.Section, d.Severity, d.Code, d.Message); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintf(cmd.OutOrStdout(), "%d error(s), %d warning(s)\n", result.ErrorCount, result.WarningCount); err != nil {
			return err
		}
	}
	if !result.OK {
		return baselineFailure(1, "baseline lint found %d error(s)", result.ErrorCount)
	}
	return nil
}
