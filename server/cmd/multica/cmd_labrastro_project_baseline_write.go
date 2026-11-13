package main

import (
	"context"
	"encoding/json"
	"net/url"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

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
	if err := baselineWriteMetadata(ctx, cmd, client, body); err != nil {
		return err
	}
	var raw json.RawMessage
	if err := client.PostJSON(ctx, base+"/pages", body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	return baselinePrintWriteResult(cmd, raw, "created")
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
	if err := baselineWriteMetadata(ctx, cmd, client, body); err != nil {
		return err
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
	if err := baselineWriteMetadata(ctx, cmd, client, body); err != nil {
		return err
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
	if err := baselineWriteMetadata(ctx, cmd, client, body); err != nil {
		return err
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
	if err := baselineWriteMetadata(ctx, cmd, client, body); err != nil {
		return err
	}
	var raw json.RawMessage
	if err := client.PostJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/rollback", body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	return baselinePrintWriteResult(cmd, raw, "rolled back")
}

func baselineWriteMetadata(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, body map[string]any) error {
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
	return nil
}
