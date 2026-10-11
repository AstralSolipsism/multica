package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type labrastroYSKReport struct {
	Version    int                         `json:"ysk"`
	Kind       string                      `json:"kind"`
	Step       int                         `json:"step"`
	Tips       []labrastroYSKInputTip      `json:"tips"`
	Overturned []labrastroYSKInputOverturn `json:"overturned"`
}

type labrastroYSKInputTip struct {
	Tag         string `json:"tag"`
	Line        string `json:"line"`
	Title       string `json:"title"`
	Explanation string `json:"explanation"`
}

type labrastroYSKInputOverturn struct {
	TipID  string `json:"tip_id"`
	Reason string `json:"reason"`
}

func labrastroYSKValidText(s string, limit int) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && strings.TrimSpace(s) != "" && utf8.RuneCountInString(s) <= limit
}

func labrastroYSKValidTip(t labrastroYSKInputTip, kind string) bool {
	return ((kind == "light" && t.Tag == "you_should_know") || (kind == "heads_up" && t.Tag == "heads_up")) &&
		labrastroYSKValidText(t.Line, 40) && labrastroYSKValidText(t.Title, 12) && labrastroYSKValidText(t.Explanation, 200) &&
		!strings.ContainsAny(t.Line+t.Title, "\r\n")
}

// Parsing has no database or logging side effects. A nil report rejects the
// envelope; otherwise valid entries survive alongside content-free diagnostics.
func labrastroYSKParseReport(body io.Reader) (*labrastroYSKReport, []string) {
	var req labrastroYSKReport
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(&req); err != nil {
		return nil, []string{"invalid JSON"}
	}
	if err := decoder.Decode(new(any)); err != io.EOF || req.Version != 1 || req.Step < 1 || (req.Kind != "light" && req.Kind != "heads_up") {
		return nil, []string{"invalid report envelope"}
	}
	var rejected []string
	tips := req.Tips[:0]
	for _, tip := range req.Tips {
		if !labrastroYSKValidTip(tip, req.Kind) {
			rejected = append(rejected, "invalid tip")
			continue
		}
		tips = append(tips, tip)
	}
	req.Tips = tips
	overturned := req.Overturned[:0]
	for _, item := range req.Overturned {
		_, err := util.ParseUUID(item.TipID)
		if req.Kind != "light" || err != nil || strings.TrimSpace(item.Reason) == "" || strings.ContainsRune(item.Reason, 0) {
			rejected = append(rejected, "invalid overturn")
			continue
		}
		overturned = append(overturned, item)
	}
	req.Overturned = overturned
	return &req, rejected
}

// The caller holds the issue lock and has re-read the task after taking it.
func labrastroYSKReportSource(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, workspaceID pgtype.UUID) (string, error) {
	if task.Status != "running" && task.Status != "dispatched" {
		return "task no longer active", nil
	}
	if !task.TriggerCommentID.Valid {
		return "", nil
	}
	comment, err := q.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: task.TriggerCommentID, WorkspaceID: workspaceID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if err != nil || comment.DeletedAt.Valid || comment.IssueID != task.IssueID ||
		(task.DispatchedAt.Valid && comment.UpdatedAt.Time.After(task.DispatchedAt.Time)) {
		return "source comment changed", nil
	}
	return "", nil
}

// Only parsed reports reach persistence. The issue lock serializes quotas,
// invalidation and deletion; publication happens after the caller commits.
func labrastroYSKPersistReport(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, workspaceID pgtype.UUID, req *labrastroYSKReport) (created, updated []db.LabrastroIssueTip, err error) {
	for _, input := range req.Tips {
		tip, err := q.LabrastroYSKCreateTip(ctx, db.LabrastroYSKCreateTipParams{
			WorkspaceID: workspaceID, IssueID: task.IssueID, TaskID: task.ID, AgentID: task.AgentID, AnchorCommentID: task.TriggerCommentID,
			Tag: input.Tag, Line: input.Line, Title: input.Title, Explanation: input.Explanation,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue // A retry or a run that has already reached its tip quota.
		}
		if err != nil {
			return nil, nil, err
		}
		created = append(created, tip)
	}
	for _, overturned := range req.Overturned {
		tip, err := q.LabrastroYSKOverturnTip(ctx, db.LabrastroYSKOverturnTipParams{
			WorkspaceID: workspaceID, IssueID: task.IssueID, ID: parseUUID(overturned.TipID), TaskID: task.ID,
			CommentID: task.TriggerCommentID, Reason: pgtype.Text{String: overturned.Reason, Valid: true},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		updated = append(updated, tip)
	}
	return created, updated, nil
}
