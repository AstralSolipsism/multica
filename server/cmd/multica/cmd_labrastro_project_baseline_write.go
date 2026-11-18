package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

// baselineAttachmentMaxBytes mirrors the server's /api/upload-file cap so an
// oversized artifact fails here instead of after the page write has committed.
const baselineAttachmentMaxBytes int64 = 100 << 20

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
	// Read every --attachment before the page write commits: a missing or
	// oversized local file must fail without leaving a new revision behind.
	type pendingAttachment struct {
		data     []byte
		filename string
	}
	paths, _ := cmd.Flags().GetStringArray("attachment")
	attachments := make([]pendingAttachment, 0, len(paths))
	for _, path := range paths {
		data, filename, err := baselineReadAttachment(path)
		if err != nil {
			return err
		}
		attachments = append(attachments, pendingAttachment{data: data, filename: filename})
	}
	var raw json.RawMessage
	if err := client.PutJSON(ctx, base+"/pages/"+url.PathEscape(mustString(cmd, "page"))+"/content", body, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	if len(attachments) == 0 {
		return baselinePrintWriteResult(cmd, raw, "written")
	}
	var written struct {
		Page     baselineCLIPage     `json:"page"`
		Revision baselineCLIRevision `json:"revision"`
	}
	if json.Unmarshal(raw, &written) != nil || written.Page.ID == "" || written.Revision.ID == "" {
		return baselineFailure(1, "invalid baseline write response")
	}
	// The page write is authoritative and already committed. Print it before
	// uploading so a failed canvas upload still tells the caller which revision
	// the body landed on.
	if err := baselinePrintWriteResult(cmd, raw, "written"); err != nil {
		return err
	}
	for _, attachment := range attachments {
		att, err := client.UploadBaselinePageAttachment(ctx, attachment.data, attachment.filename, written.Page.ID, written.Revision.ID)
		if err != nil {
			return baselineFailure(1, "%s v%d written, but uploading %s failed: %s", written.Page.Slug, written.Revision.Number, attachment.filename, baselineUploadError(err))
		}
		fmt.Fprintf(cmd.OutOrStdout(), "attachment: %s (%d bytes) → %s\n", att.Filename, att.SizeBytes, att.ID)
	}
	return nil
}

func baselineUploadError(err error) string {
	var e *cli.HTTPError
	if errors.As(err, &e) {
		return fmt.Sprintf("HTTP %d", e.StatusCode)
	}
	return err.Error()
}

// baselineReadAttachment reads one --attachment file. It must be a regular
// file inside the current directory (the same boundary --content-file uses)
// so a stray absolute path cannot ship an arbitrary local file.
func baselineReadAttachment(path string) ([]byte, string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, "", baselineFailure(2, "cannot locate current directory")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, "", baselineFailure(2, "invalid --attachment path")
	}
	rel, err := filepath.Rel(cwd, absolute)
	if err != nil || !filepath.IsLocal(rel) {
		return nil, "", baselineFailure(2, "--attachment must be inside the current directory")
	}
	root, err := os.OpenRoot(cwd)
	if err != nil {
		return nil, "", baselineFailure(2, "cannot open current directory")
	}
	defer root.Close()
	info, err := root.Stat(rel)
	if err != nil || !info.Mode().IsRegular() {
		return nil, "", baselineFailure(2, "--attachment must be a regular file inside the current directory")
	}
	if info.Size() == 0 {
		return nil, "", baselineFailure(2, "--attachment %s is empty", filepath.Base(rel))
	}
	if info.Size() > baselineAttachmentMaxBytes {
		return nil, "", baselineFailure(2, "--attachment %s exceeds the 100 MiB upload limit", filepath.Base(rel))
	}
	f, err := root.Open(rel)
	if err != nil {
		return nil, "", baselineFailure(2, "cannot open --attachment inside the current directory")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, baselineAttachmentMaxBytes+1))
	if err != nil {
		return nil, "", baselineFailure(2, "cannot read --attachment")
	}
	if int64(len(data)) > baselineAttachmentMaxBytes {
		return nil, "", baselineFailure(2, "--attachment %s exceeds the 100 MiB upload limit", filepath.Base(rel))
	}
	return data, filepath.Base(rel), nil
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
