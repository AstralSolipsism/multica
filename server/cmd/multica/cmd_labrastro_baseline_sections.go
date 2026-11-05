package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/spf13/cobra"
)

func baselineReadSlice(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, project string, index bool) error {
	query := url.Values{}
	if index {
		query.Set("index", "true")
	} else {
		query.Set("section", mustString(cmd, "section"))
	}
	if chapter := mustString(cmd, "chapter"); chapter != "" {
		query.Set("chapter", chapter)
	}
	if candidate, _ := cmd.Flags().GetBool("candidate"); candidate {
		query.Set("candidate", "true")
	}
	var raw json.RawMessage
	if err := client.GetJSON(ctx, "/api/projects/"+project+"/baseline?"+query.Encode(), &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if index {
		var result struct {
			Chapters []struct {
				Chapter        string                `json:"chapter"`
				Title          string                `json:"title"`
				Position       int32                 `json:"position"`
				RevisionNumber int32                 `json:"revision_number"`
				Status         string                `json:"status"`
				Sections       []engineering.Heading `json:"sections"`
			} `json:"chapters"`
		}
		if json.Unmarshal(raw, &result) != nil || result.Chapters == nil {
			return baselineFailure(1, "invalid baseline index response")
		}
		for _, c := range result.Chapters {
			if !engineering.ValidChapter(c.Chapter) || c.Sections == nil {
				return baselineFailure(1, "invalid baseline index response")
			}
			for _, h := range c.Sections {
				if h.Level < 1 || h.Level > 3 || h.Anchor == "" {
					return baselineFailure(1, "invalid baseline heading response")
				}
			}
		}
		if mustString(cmd, "output") == "json" {
			return cli.PrintJSON(cmd.OutOrStdout(), raw)
		}
		for _, c := range result.Chapters {
			fmt.Fprintf(cmd.OutOrStdout(), "%s — %s (position %d; %s v%d)\n", c.Chapter, c.Title, c.Position, c.Status, c.RevisionNumber)
			for _, h := range c.Sections {
				fmt.Fprintf(cmd.OutOrStdout(), "%s- %s [%s]\n", strings.Repeat("  ", h.Level-1), h.Title, h.Anchor)
			}
		}
		return nil
	}
	var result engineering.Slice
	if json.Unmarshal(raw, &result) != nil || len(result.Sections) == 0 || result.ReferencedSections == nil {
		return baselineFailure(1, "invalid baseline section response")
	}
	for _, s := range result.Sections {
		if !engineering.ValidChapter(s.Chapter) || s.Anchor == "" || s.ContentMarkdown == "" {
			return baselineFailure(1, "invalid baseline section response")
		}
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	for _, s := range result.Sections {
		fmt.Fprintf(cmd.OutOrStdout(), "<!-- %s [%s] -->\n%s\n", s.Chapter, s.Anchor, s.ContentMarkdown)
	}
	if len(result.ReferencedSections) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "\n### 关联概念摘要")
		for _, ref := range result.ReferencedSections {
			fmt.Fprintf(cmd.OutOrStdout(), "\n#### %s (%s [%s])\n%s\n", ref.Title, ref.Chapter, ref.Anchor, ref.Definition)
			if ref.Why != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "为什么：%s\n", ref.Why)
			}
		}
	}
	return nil
}
