package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func (h *Handler) RegisterLabrastroYSKRoutes(r chi.Router) {
	r.With(RequireHumanActor).Get("/api/issues/{id}/tips", h.LabrastroListIssueTips)
	r.With(RequireHumanActor).Get("/api/tips/active", h.LabrastroListActiveTips)
	r.With(RequireHumanActor).Post("/api/tips/{tipId}/state", h.LabrastroSetTipState)
}

func labrastroYSKEnabled(settings []byte) bool {
	var s struct {
		Enabled bool `json:"you_should_know_enabled"`
	}
	return json.Unmarshal(settings, &s) == nil && s.Enabled
}

func labrastroYSKPreferenceDefaults(prefs map[string]string) map[string]string {
	if prefs == nil {
		prefs = map[string]string{}
	}
	if prefs["you_should_know"] == "" {
		prefs["you_should_know"] = "all"
	}
	return prefs
}

// Called only by the shared claim builder, after its workspace/source gates.
// taskToResponse and all human/agent-readable task projections leave this nil.
func (h *Handler) labrastroYSKClaimContext(r *http.Request, task db.AgentTaskQueue, runtime db.AgentRuntime, resp AgentTaskResponse) *protocol.YouShouldKnowContext {
	if !task.IssueID.Valid || task.ChatSessionID.Valid || task.AutopilotRunID.Valid || runtime.Provider != "claude" ||
		!requestHasClientCapability(r, protocol.DaemonCapabilityYouShouldKnowV1) {
		return nil
	}
	ctx := r.Context()
	ws, err := h.Queries.GetWorkspace(ctx, runtime.WorkspaceID)
	if err != nil || !labrastroYSKEnabled(ws.Settings) {
		if err != nil {
			slog.Warn("ysk: claim context omitted", "task_id", uuidToString(task.ID), "error", err)
		}
		return nil
	}
	result, err := h.labrastroYSKLoadContext(ctx, task, runtime.WorkspaceID, resp.IssueIdentifier)
	if err != nil {
		slog.Warn("ysk: claim context omitted", "task_id", uuidToString(task.ID), "error", err)
		return nil
	}
	return result
}

func (h *Handler) labrastroYSKLoadContext(ctx context.Context, task db.AgentTaskQueue, workspaceID pgtype.UUID, identifier string) (*protocol.YouShouldKnowContext, error) {
	result := &protocol.YouShouldKnowContext{
		Version: 1, IssueIdentifier: identifier, AnchorCommentID: uuidToPtr(task.TriggerCommentID),
		ExistingTips: []protocol.YouShouldKnowTip{}, KnownTopics: []string{},
		LightTipCount: 3, CheckEverySteps: 6,
		Limits: protocol.YouShouldKnowLimits{Line: 40, Title: 12, Explanation: 200},
	}
	tips, err := h.Queries.LabrastroYSKExistingTips(ctx, db.LabrastroYSKExistingTipsParams{WorkspaceID: workspaceID, IssueID: task.IssueID})
	if err != nil {
		return nil, err
	}
	for _, tip := range tips {
		result.ExistingTips = append(result.ExistingTips, protocol.YouShouldKnowTip{ID: uuidToString(tip.ID), Tag: tip.Tag, Line: tip.Line})
	}
	comment, err := h.Queries.LabrastroYSKLatestHumanComment(ctx, db.LabrastroYSKLatestHumanCommentParams{WorkspaceID: workspaceID, IssueID: task.IssueID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	result.LatestHumanComment = comment
	// The contract says attribution.initiator, not the authorization originator
	// or runtime owner. No attribution means no person's known-topic history.
	if task.AccountableUserID.Valid {
		result.KnownTopics, err = h.Queries.LabrastroYSKKnownTopics(ctx, db.LabrastroYSKKnownTopicsParams{WorkspaceID: workspaceID, UserID: task.AccountableUserID})
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

type LabrastroTipState struct {
	State     string  `json:"state"`
	Feedback  *string `json:"feedback"`
	UpdatedAt *string `json:"updated_at"`
}

type LabrastroTipResponse struct {
	ID                    string             `json:"id"`
	WorkspaceID           string             `json:"workspace_id"`
	IssueID               string             `json:"issue_id"`
	IssueIdentifier       string             `json:"issue_identifier"`
	TaskID                string             `json:"task_id"`
	AgentID               string             `json:"agent_id"`
	AnchorCommentID       *string            `json:"anchor_comment_id"`
	Tag                   string             `json:"tag"`
	Line                  string             `json:"line"`
	Title                 string             `json:"title"`
	Explanation           string             `json:"explanation"`
	Status                string             `json:"status"`
	OverturnedByTaskID    *string            `json:"overturned_by_task_id"`
	OverturnedByCommentID *string            `json:"overturned_by_comment_id"`
	OverturnedReason      *string            `json:"overturned_reason"`
	CreatedAt             *string            `json:"created_at"`
	UpdatedAt             *string            `json:"updated_at"`
	UserState             *LabrastroTipState `json:"user_state,omitempty"`
}

func labrastroTipResponse(t db.LabrastroIssueTip, identifier string) LabrastroTipResponse {
	return LabrastroTipResponse{
		ID: uuidToString(t.ID), WorkspaceID: uuidToString(t.WorkspaceID), IssueID: uuidToString(t.IssueID),
		IssueIdentifier: identifier, TaskID: uuidToString(t.TaskID), AgentID: uuidToString(t.AgentID),
		AnchorCommentID: uuidToPtr(t.AnchorCommentID), Tag: t.Tag, Line: t.Line, Title: t.Title, Explanation: t.Explanation, Status: t.Status,
		OverturnedByTaskID: uuidToPtr(t.OverturnedByTaskID), OverturnedByCommentID: uuidToPtr(t.OverturnedByCommentID), OverturnedReason: textToPtr(t.OverturnedReason),
		CreatedAt: timestampToNanoPtr(t.CreatedAt), UpdatedAt: timestampToNanoPtr(t.UpdatedAt),
	}
}

func (h *Handler) labrastroYSKMember(w http.ResponseWriter, r *http.Request) (pgtype.UUID, pgtype.UUID, bool) {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "this endpoint is only available to human actors")
		return pgtype.UUID{}, pgtype.UUID{}, false
	}
	uid, ok := requireUserID(w, r)
	if !ok {
		return pgtype.UUID{}, pgtype.UUID{}, false
	}
	ws, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return pgtype.UUID{}, pgtype.UUID{}, false
	}
	_, ok = h.requireWorkspaceMember(w, r, uuidToString(ws), "workspace not found")
	return ws, parseUUID(uid), ok
}

func (h *Handler) labrastroYSKError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "tip or source not found")
		return
	}
	slog.Warn("ysk: operation failed", "error", err)
	writeError(w, http.StatusInternalServerError, "failed to process tips")
}

func (h *Handler) LabrastroListIssueTips(w http.ResponseWriter, r *http.Request) {
	ws, user, ok := h.labrastroYSKMember(w, r)
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "valid" && status != "all" {
		writeError(w, http.StatusBadRequest, "status must be valid or all")
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	h.labrastroYSKList(w, r, db.LabrastroYSKListTipsParams{WorkspaceID: ws, UserID: user, IssueID: issue.ID, IncludeInvalid: status == "all"})
}

func (h *Handler) LabrastroListActiveTips(w http.ResponseWriter, r *http.Request) {
	ws, user, ok := h.labrastroYSKMember(w, r)
	if !ok {
		return
	}
	h.labrastroYSKList(w, r, db.LabrastroYSKListTipsParams{WorkspaceID: ws, UserID: user, ActiveOnly: true})
}

func (h *Handler) labrastroYSKList(w http.ResponseWriter, r *http.Request, params db.LabrastroYSKListTipsParams) {
	ws, err := h.Queries.GetWorkspace(r.Context(), params.WorkspaceID)
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	rows, err := h.Queries.LabrastroYSKListTips(r.Context(), params)
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	tips := make([]LabrastroTipResponse, 0, len(rows))
	for _, row := range rows {
		tip := labrastroTipResponse(row.LabrastroIssueTip, service.IssueIdentifier(ws.IssuePrefix, row.IssueNumber))
		if row.UserState.Valid {
			tip.UserState = &LabrastroTipState{State: row.UserState.String, Feedback: textToPtr(row.UserFeedback), UpdatedAt: timestampToNanoPtr(row.StateUpdatedAt)}
		}
		tips = append(tips, tip)
	}
	writeJSON(w, http.StatusOK, map[string]any{"tips": tips})
}

func (h *Handler) LabrastroSetTipState(w http.ResponseWriter, r *http.Request) {
	ws, user, ok := h.labrastroYSKMember(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "tipId"), "tip_id")
	if !ok {
		return
	}
	var req struct {
		State    string  `json:"state"`
		Feedback *string `json:"feedback"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil ||
		(req.State != "known" && req.State != "dismissed") ||
		(req.Feedback != nil && *req.Feedback != "helpful" && *req.Feedback != "not_relevant" && *req.Feedback != "not_understood") {
		writeError(w, http.StatusBadRequest, "invalid tip state or feedback")
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	// Match membership revocation's first lock: a departing member cannot
	// recreate preferences after its cleanup but before its row is removed.
	if err = q.LockSubscriberWrites(ctx, db.LockSubscriberWritesParams{WorkspaceID: ws, UserID: user}); err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	if _, err = q.LabrastroYSKLockWorkspace(ctx, ws); err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	tip, err := q.LabrastroYSKGetTip(ctx, db.LabrastroYSKGetTipParams{WorkspaceID: ws, ID: id})
	if err == nil {
		_, err = q.LockIssueForDelete(ctx, db.LockIssueForDeleteParams{WorkspaceID: ws, ID: tip.IssueID})
	}
	if err == nil {
		_, err = q.LabrastroYSKLockMember(ctx, db.LabrastroYSKLockMemberParams{WorkspaceID: ws, UserID: user})
	}
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	state, err := q.LabrastroYSKSetState(ctx, db.LabrastroYSKSetStateParams{WorkspaceID: ws, TipID: tip.ID, UserID: user, State: req.State, Feedback: ptrToText(req.Feedback)})
	if err == nil && req.State == "known" {
		err = q.LabrastroYSKRememberTopic(ctx, db.LabrastroYSKRememberTopicParams{WorkspaceID: ws, UserID: user, Topic: tip.Line})
		if err == nil {
			err = q.LabrastroYSKPruneTopics(ctx, db.LabrastroYSKPruneTopicsParams{WorkspaceID: ws, UserID: user})
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	payload := map[string]any{
		"workspace_id": uuidToString(ws), "issue_id": uuidToString(tip.IssueID), "tip_id": uuidToString(tip.ID), "user_id": uuidToString(user),
		"state": state.State, "feedback": textToPtr(state.Feedback), "updated_at": timestampToNanoPtr(state.UpdatedAt),
	}
	h.publish(protocol.EventIssueTipStateChanged, uuidToString(ws), "member", uuidToString(user), payload)
	writeJSON(w, http.StatusOK, payload)
}

type labrastroYSKReport struct {
	Version    int                    `json:"ysk"`
	Kind       string                 `json:"kind"`
	Step       int                    `json:"step"`
	Tips       []labrastroYSKInputTip `json:"tips"`
	Overturned []struct {
		TipID  string `json:"tip_id"`
		Reason string `json:"reason"`
	} `json:"overturned"`
}

type labrastroYSKInputTip struct {
	Tag         string `json:"tag"`
	Line        string `json:"line"`
	Title       string `json:"title"`
	Explanation string `json:"explanation"`
}

func labrastroYSKValidText(s string, limit int) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && strings.TrimSpace(s) != "" && utf8.RuneCountInString(s) <= limit
}

func labrastroYSKValidTip(t labrastroYSKInputTip, kind string) bool {
	return ((kind == "light" && t.Tag == "you_should_know") || (kind == "heads_up" && t.Tag == "heads_up")) &&
		labrastroYSKValidText(t.Line, 40) && labrastroYSKValidText(t.Title, 12) && labrastroYSKValidText(t.Explanation, 200) &&
		!strings.ContainsAny(t.Line+t.Title, "\r\n")
}

// The daemon posts only side-channel results. It receives no tip data back.
func (h *Handler) LabrastroReportTaskTips(w http.ResponseWriter, r *http.Request) {
	task, workspaceID, ok := h.requireDaemonTaskAccessWithWorkspace(w, r, chi.URLParam(r, "taskId"))
	if !ok {
		return
	}
	runtime, ok := h.requireDaemonRuntimeAccess(w, r, uuidToString(task.RuntimeID))
	if !ok || !h.requireRuntimeQuotaPushAccess(w, r, runtime) {
		return
	}
	if workspaceID != uuidToString(runtime.WorkspaceID) {
		writeError(w, http.StatusNotFound, "task not found")
		return
	}
	drop := func(reason string) {
		slog.Warn("ysk: report discarded", "task_id", uuidToString(task.ID), "reason", reason)
		w.WriteHeader(http.StatusNoContent)
	}
	var req labrastroYSKReport
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	if err := decoder.Decode(&req); err != nil {
		drop("invalid JSON")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF || req.Version != 1 || req.Step < 1 || (req.Kind != "light" && req.Kind != "heads_up") {
		drop("invalid report envelope")
		return
	}
	if !task.IssueID.Valid || task.ChatSessionID.Valid || task.AutopilotRunID.Valid || runtime.Provider != "claude" {
		drop("ineligible task")
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if _, err = q.LabrastroYSKLockWorkspace(ctx, runtime.WorkspaceID); err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	ws, err := q.GetWorkspace(ctx, runtime.WorkspaceID)
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	if !labrastroYSKEnabled(ws.Settings) {
		drop("workspace disabled")
		return
	}
	_, err = q.LockIssueForDelete(ctx, db.LockIssueForDeleteParams{ID: task.IssueID, WorkspaceID: runtime.WorkspaceID})
	if err == nil {
		// Re-read after the issue lock: edits/deletes cancel runs and invalidate
		// tips under this same lock, so late reports cannot revive old input.
		task, err = q.GetAgentTask(ctx, task.ID)
	}
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	if task.Status != "running" && task.Status != "dispatched" {
		drop("task no longer active")
		return
	}
	if task.TriggerCommentID.Valid {
		comment, err := q.GetCommentInWorkspace(ctx, db.GetCommentInWorkspaceParams{ID: task.TriggerCommentID, WorkspaceID: runtime.WorkspaceID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			h.labrastroYSKError(w, err)
			return
		}
		if err != nil || comment.DeletedAt.Valid || comment.IssueID != task.IssueID ||
			(task.DispatchedAt.Valid && comment.UpdatedAt.Time.After(task.DispatchedAt.Time)) {
			drop("source comment changed")
			return
		}
	}
	var created, updated []db.LabrastroIssueTip
	for _, input := range req.Tips {
		if !labrastroYSKValidTip(input, req.Kind) {
			slog.Warn("ysk: invalid tip discarded", "task_id", uuidToString(task.ID))
			continue
		}
		tip, err := q.LabrastroYSKCreateTip(ctx, db.LabrastroYSKCreateTipParams{
			WorkspaceID: runtime.WorkspaceID, IssueID: task.IssueID, TaskID: task.ID, AgentID: task.AgentID, AnchorCommentID: task.TriggerCommentID,
			Tag: input.Tag, Line: input.Line, Title: input.Title, Explanation: input.Explanation,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue // A retry or a run that has already reached its tip quota.
		}
		if err != nil {
			h.labrastroYSKError(w, err)
			return
		}
		created = append(created, tip)
	}
	if req.Kind == "light" {
		for _, overturned := range req.Overturned {
			id, err := util.ParseUUID(overturned.TipID)
			if err != nil || strings.TrimSpace(overturned.Reason) == "" || strings.ContainsRune(overturned.Reason, 0) {
				slog.Warn("ysk: invalid overturn discarded", "task_id", uuidToString(task.ID))
				continue
			}
			tip, err := q.LabrastroYSKOverturnTip(ctx, db.LabrastroYSKOverturnTipParams{
				WorkspaceID: runtime.WorkspaceID, IssueID: task.IssueID, ID: id, TaskID: task.ID, CommentID: task.TriggerCommentID, Reason: pgtype.Text{String: overturned.Reason, Valid: true},
			})
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				h.labrastroYSKError(w, err)
				return
			}
			updated = append(updated, tip)
		}
	}
	issue, err := q.GetIssue(ctx, task.IssueID)
	if err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		h.labrastroYSKError(w, err)
		return
	}
	identifier := service.IssueIdentifier(ws.IssuePrefix, issue.Number)
	h.labrastroYSKPublishTips(protocol.EventIssueTipCreated, created, identifier, "agent", uuidToString(task.AgentID))
	h.labrastroYSKPublishTips(protocol.EventIssueTipUpdated, updated, identifier, "agent", uuidToString(task.AgentID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) labrastroYSKPublishTips(event string, tips []db.LabrastroIssueTip, identifier, actorType, actorID string) {
	for _, tip := range tips {
		h.publish(event, uuidToString(tip.WorkspaceID), actorType, actorID, map[string]any{"tip": labrastroTipResponse(tip, identifier)})
	}
}

func (h *Handler) labrastroYSKPublishSourceChanges(ctx context.Context, tips []db.LabrastroIssueTip, actorType, actorID string) {
	if len(tips) == 0 {
		return
	}
	var identifier string
	ws, wsErr := h.Queries.GetWorkspace(ctx, tips[0].WorkspaceID)
	issue, issueErr := h.Queries.GetIssue(ctx, tips[0].IssueID)
	if wsErr == nil && issueErr == nil {
		identifier = service.IssueIdentifier(ws.IssuePrefix, issue.Number)
	}
	h.labrastroYSKPublishTips(protocol.EventIssueTipUpdated, tips, identifier, actorType, actorID)
}
