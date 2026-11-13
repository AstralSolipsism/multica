package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

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
