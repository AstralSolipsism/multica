package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func newLabrastroBaselineCommentCmd() *cobra.Command {
	group := &cobra.Command{Use: "comment", Short: "Discuss wiki passages; only explicit @agent or @squad mentions wake agents"}
	for _, action := range []string{"list", "show", "create", "reply", "edit", "delete", "resolve", "reopen"} {
		cmd := &cobra.Command{Use: action + " <project-id>", Args: cobra.ExactArgs(1), RunE: runLabrastroBaselineComment}
		cmd.Flags().String("output", "text", "Output format: text or json")
		switch action {
		case "list", "create":
			cmd.Flags().String("page", "", "Page slug or UUID (required)")
			_ = cmd.MarkFlagRequired("page")
		case "show", "reply", "resolve", "reopen":
			cmd.Flags().String("thread", "", "Thread UUID (required)")
			_ = cmd.MarkFlagRequired("thread")
		case "edit", "delete":
			cmd.Flags().String("comment", "", "Comment UUID (required)")
			_ = cmd.MarkFlagRequired("comment")
		}
		switch action {
		case "list":
			cmd.Flags().String("state", "open", "open, resolved or all")
		case "show":
			cmd.Flags().Bool("with-section", false, "Include the current section Markdown")
		case "create":
			cmd.Flags().String("quote", "", "Exact rendered passage (unique within the section or page)")
			cmd.Flags().String("section", "", "Section title or anchor")
			cmd.Flags().String("issue", "", "Existing carrier issue in the same project")
		}
		if action == "create" || action == "reply" || action == "edit" {
			cmd.Flags().String("content-file", "", "UTF-8 Markdown file inside the current directory (required)")
			_ = cmd.MarkFlagRequired("content-file")
		}
		group.AddCommand(cmd)
	}
	return group
}

func runLabrastroBaselineComment(cmd *cobra.Command, args []string) error {
	action := cmd.Name()
	if !contains([]string{"text", "json"}, mustString(cmd, "output")) {
		return baselineFailure(2, "unsupported --output format")
	}
	if action == "list" && !contains([]string{"open", "resolved", "all"}, mustString(cmd, "state")) {
		return baselineFailure(2, "--state must be open, resolved or all")
	}
	if action == "create" && strings.TrimSpace(mustString(cmd, "quote")) == "" && strings.TrimSpace(mustString(cmd, "section")) == "" {
		return baselineFailure(2, "--quote or --section is required")
	}
	for _, flag := range []string{"thread", "comment"} {
		if value := mustString(cmd, flag); value != "" && !uuidRegexp.MatchString(value) {
			return baselineFailure(2, "--%s must be a UUID", flag)
		}
	}
	body := map[string]any{}
	if action == "create" || action == "reply" || action == "edit" {
		text, err := readProjectInputFile(mustString(cmd, "content-file"), "content-file", 16000)
		if err != nil {
			return err
		}
		if strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > 4000 {
			return baselineFailure(2, "comment must contain 1–4000 characters")
		}
		body["body_markdown"] = text
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return baselineFailure(1, "%s", err)
	}
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	project, err := resolveIDByPrefix(ctx, client, "project", args[0], func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		return fetchProjectCandidates(ctx, client)
	})
	if err != nil {
		return baselineFailure(2, "%s", err)
	}
	base := "/api/projects/" + project.ID + "/baseline"
	path := base + "/threads/" + url.PathEscape(mustString(cmd, "thread"))
	var raw json.RawMessage
	switch action {
	case "list":
		err = client.GetJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/threads?state="+mustString(cmd, "state"), &raw)
	case "show":
		with, _ := cmd.Flags().GetBool("with-section")
		if with {
			path += "?with_section=true"
		}
		err = client.GetJSON(ctx, path, &raw)
	case "create":
		body["quote"], body["section"] = mustString(cmd, "quote"), mustString(cmd, "section")
		if issue := mustString(cmd, "issue"); issue != "" {
			id, e := baselineResolveSourceIssue(ctx, client, issue)
			if e != nil {
				return e
			}
			body["carrier_issue_id"] = id
		}
		err = client.PostJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/threads", body, &raw)
	case "reply":
		err = client.PostJSON(ctx, path+"/comments", body, &raw)
	case "resolve", "reopen":
		err = client.PostJSON(ctx, path+"/resolve", map[string]any{"resolved": action == "resolve"}, &raw)
	case "edit":
		err = client.PatchJSON(ctx, base+"/comments/"+url.PathEscape(mustString(cmd, "comment")), body, &raw)
	case "delete":
		err = client.DeleteJSON(ctx, base+"/comments/"+url.PathEscape(mustString(cmd, "comment")))
	}
	if err != nil {
		return baselineRequestError(err, action != "list" && action != "show")
	}
	if len(raw) == 0 {
		raw = json.RawMessage(`{"ok":true}`)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var out struct {
		Thread  *baselineCLIThread  `json:"thread"`
		Threads []baselineCLIThread `json:"threads"`
		Woke    []struct {
			TargetType string `json:"target_type"`
			TargetID   string `json:"target_id"`
			Status     string `json:"status"`
			Reason     string `json:"reason_code"`
		} `json:"woke"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return baselineFailure(1, "invalid comment response")
	}
	if out.Thread != nil {
		out.Threads = append(out.Threads, *out.Thread)
	}
	for _, t := range out.Threads {
		state := "open"
		if t.ResolvedAt != nil {
			state = "resolved"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s [%s / %s] § %s\n> %s\n", t.ID, state, t.AnchorState, t.Anchor.SectionAnchor, t.Anchor.Exact)
		for _, c := range t.Comments {
			fmt.Fprintf(cmd.OutOrStdout(), "  %s · %s %s\n%s\n", c.ID, c.AuthorType, c.AuthorID, c.Body)
		}
		if t.Section != nil {
			fmt.Fprintf(cmd.OutOrStdout(), "\n%s\n", t.Section.Markdown)
		}
	}
	for _, w := range out.Woke {
		fmt.Fprintf(cmd.OutOrStdout(), "@%s/%s: %s (%s)\n", w.TargetType, w.TargetID, w.Status, w.Reason)
	}
	if len(out.Threads) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), action+": ok")
	}
	return nil
}

type baselineCLIThread struct {
	ID          string  `json:"id"`
	AnchorState string  `json:"anchor_state"`
	ResolvedAt  *string `json:"resolved_at"`
	Anchor      struct {
		SectionAnchor string `json:"section_anchor"`
		Exact         string `json:"exact"`
	} `json:"anchor"`
	Comments []struct {
		ID         string `json:"id"`
		AuthorType string `json:"author_type"`
		AuthorID   string `json:"author_id"`
		Body       string `json:"body_markdown"`
	} `json:"comments"`
	Section *struct {
		Markdown string `json:"content_markdown"`
	} `json:"section"`
}
