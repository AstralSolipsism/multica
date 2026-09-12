package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// maxPreviewTriggerIssues caps a single preview request so a pathological
// selection cannot fan out into thousands of readiness probes.
const maxPreviewTriggerIssues = 500

// issueTriggerWriteProbe carries invocation and self-loop checks into the
// compound transaction now that it owns the queue insertion.
func (h *Handler) issueTriggerWriteProbe(r *http.Request, actorType, actorID string, issue db.Issue) service.IssueTriggerProbe {
	originatorUserID := h.invokeOriginatorFromRequest(r, actorType, actorID)
	return service.IssueTriggerProbe{
		CanAccessAgent: func(agent db.Agent) bool {
			return h.canInvokeAgent(r.Context(), agent, actorType, actorID, originatorUserID, uuidToString(issue.WorkspaceID))
		},
		IsSelfLoop: func() bool {
			return h.isAgentRunningOnIssue(r, actorType, issue)
		},
		SuppressActiveSelfAssignment: func(agentID pgtype.UUID) bool {
			suppress := h.shouldSuppressActiveSelfAssignment(r.Context(), actorType, actorID, issue.ID, agentID)
			if suppress {
				slog.Info("suppressing duplicate self-assignment enqueue",
					"issue_id", uuidToString(issue.ID),
					"agent_id", uuidToString(agentID),
				)
			}
			return suppress
		},
	}
}

// issueTriggerPreviewProbe mirrors the real write-time gates for the read-only
// preview: the private-agent gate (so preview never leaks a private agent's
// readiness to a member who cannot see it — matching validateAssigneePair /
// canEnqueueSquadLeader) and the same self-loop guard.
func (h *Handler) issueTriggerPreviewProbe(r *http.Request, actorType, actorID, workspaceID string, issue db.Issue) service.IssueTriggerProbe {
	originatorUserID := h.invokeOriginatorFromRequest(r, actorType, actorID)
	return service.IssueTriggerProbe{
		CanAccessAgent: func(agent db.Agent) bool {
			return h.canInvokeAgent(r.Context(), agent, actorType, actorID, originatorUserID, workspaceID)
		},
		IsSelfLoop: func() bool {
			return h.isAgentRunningOnIssue(r, actorType, issue)
		},
		SuppressActiveSelfAssignment: func(agentID pgtype.UUID) bool {
			return h.shouldSuppressActiveSelfAssignment(r.Context(), actorType, actorID, issue.ID, agentID)
		},
	}
}

// shouldSuppressActiveSelfAssignment prevents a trusted task-scoped agent
// actor from creating another run for the target pair merely to claim issue
// ownership. It intentionally checks the TARGET pair, not whether the actor is
// busy anywhere: cross-issue self handoffs are a supported workflow and must
// still enqueue when the target has no active run. Query errors fail closed
// against the external enqueue side effect while leaving the ownership write
// itself intact. The API still returns success for that ownership write; only
// the server log exposes the failed advisory lookup, because enqueue is the
// optional side effect and suppressing it is safer than risking duplicate work.
func (h *Handler) shouldSuppressActiveSelfAssignment(ctx context.Context, actorType, actorID string, issueID, targetAgentID pgtype.UUID) bool {
	if actorType != "agent" || actorID == "" || actorID != uuidToString(targetAgentID) {
		return false
	}
	active, err := h.Queries.HasActiveTaskForIssueAndAgent(ctx, db.HasActiveTaskForIssueAndAgentParams{IssueID: issueID, AgentID: targetAgentID})
	return active || err != nil
}

// memberActorUserID returns the acting member's user id as a pgtype.UUID when the
// actor is a member, and an invalid UUID otherwise (an agent actor id is not a
// human and must never become an accountable human). Used to thread the
// assign/promote actor into the attribution resolver (MUL-4302 §4).
func memberActorUserID(actorType, actorID string) pgtype.UUID {
	if actorType != "member" {
		return pgtype.UUID{}
	}
	uid, err := util.ParseUUID(actorID)
	if err != nil {
		return pgtype.UUID{}
	}
	return uid
}

// IssueTriggerPreviewRequest asks "if I apply this assignee and/or status to
// these issues (or create one), which runs will start". All fields are
// optional; a nil prospective field means "leave unchanged".
type IssueTriggerPreviewRequest struct {
	// IssueIDs are existing issues to evaluate (single assign, single status,
	// or a batch). Empty with IsCreate=true evaluates a candidate new issue.
	IssueIDs []string `json:"issue_ids"`
	// IsCreate previews a not-yet-persisted issue from AssigneeType/ID/Status.
	IsCreate     bool            `json:"is_create"`
	AssigneeType *string         `json:"assignee_type"`
	AssigneeID   *string         `json:"assignee_id"`
	Status       *string         `json:"status"`
	Mutation     json.RawMessage `json:"mutation,omitempty"`
}

// IssueTriggerPreviewItem is one issue that WILL start a run under the
// prospective write. AgentID is the runnable agent (squad leader for squads).
type IssueTriggerPreviewItem struct {
	IssueID string `json:"issue_id"`
	AgentID string `json:"agent_id"`
	Source  string `json:"source"`
}

// IssueTriggerPreviewResponse lists every issue that will enqueue plus a total
// the UI can show directly ("将启动 N 个"). Issues that will NOT start a run are
// simply absent, so total_count == len(triggers).
type IssueTriggerPreviewResponse struct {
	Triggers   []IssueTriggerPreviewItem `json:"triggers"`
	TotalCount int                       `json:"total_count"`
	Blocked    []IssueDependencyPreview  `json:"blocked,omitempty"`
}

type IssueDependencyPreview struct {
	IssueID      string                       `json:"issue_id"`
	ReasonCode   string                       `json:"reason_code"`
	Dependencies *service.DependencyView      `json:"dependencies,omitempty"`
	Confirmation *service.DependencyChallenge `json:"confirmation,omitempty"`
}

// PreviewIssueTrigger dry-runs WillEnqueueRun for a prospective issue write and
// returns the runs that would start, without any side effect. It is the single
// authority the four entry points (create / single assign / single status /
// batch) consult so the frontend never re-implements the enqueue rule
// (MUL-3375). Mirrors PreviewCommentTriggers.
func (h *Handler) PreviewIssueTrigger(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace is required")
		return
	}

	var req IssueTriggerPreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.IssueIDs) > maxPreviewTriggerIssues {
		writeError(w, http.StatusBadRequest, "too many issue_ids")
		return
	}

	var mutation UpdateIssueRequest
	var mutationFields map[string]json.RawMessage
	var dependencyWrite service.DependencyWrite
	var proposedParent pgtype.UUID
	digest := ""
	if req.Mutation != nil {
		if json.Unmarshal(req.Mutation, &mutation) != nil || json.Unmarshal(req.Mutation, &mutationFields) != nil {
			writeError(w, http.StatusBadRequest, "invalid mutation")
			return
		}
		req.AssigneeType = mutation.AssigneeType
		req.AssigneeID = mutation.AssigneeID
		req.Status = mutation.Status
		var valid bool
		dependencyWrite, valid = h.parseDependencyWrite(w, r, mutation.dependencyWriteFields, true, req.IsCreate)
		if !valid {
			return
		}
		if dependencyWrite.Override != nil {
			writeError(w, http.StatusBadRequest, "preview mutation must not include dependency_override")
			return
		}
		if raw, ok := mutationFields["parent_issue_id"]; ok && string(raw) != "null" {
			var parent string
			if json.Unmarshal(raw, &parent) != nil {
				writeError(w, http.StatusBadRequest, "invalid parent_issue_id")
				return
			}
			if parent != "" {
				row, ok := h.loadDependencyIssue(w, r, parent)
				if !ok {
					return
				}
				proposedParent = row.ID
			}
		}
		digest, valid = dependencyPayloadDigest(w, r, req.Mutation)
		if !valid {
			return
		}
	}

	// Resolve the prospective assignee once — a malformed id is a deterministic
	// 400, never a silent miscount.
	var (
		newAssigneeType pgtype.Text
		newAssigneeID   pgtype.UUID
		hasNewAssignee  bool
	)
	if req.AssigneeType != nil && *req.AssigneeType != "" && req.AssigneeID != nil && *req.AssigneeID != "" {
		id, parseOK := parseUUIDOrBadRequest(w, *req.AssigneeID, "assignee_id")
		if !parseOK {
			return
		}
		newAssigneeType = pgtype.Text{String: *req.AssigneeType, Valid: true}
		newAssigneeID = id
		hasNewAssignee = true
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	resp := IssueTriggerPreviewResponse{Triggers: make([]IssueTriggerPreviewItem, 0)}

	appendTrigger := func(issue db.Issue, in service.IssueTriggerInput) bool {
		if _, ok := mutationFields["parent_issue_id"]; ok {
			issue.ParentIssueID = proposedParent
			in.Issue = issue
		}
		if mutation.SuppressRun {
			return true
		}
		probe := h.issueTriggerPreviewProbe(r, actorType, actorID, workspaceID, issue)
		trigger, ok := h.IssueService.WillEnqueueRun(r.Context(), in, probe)
		if !ok {
			return true
		}
		snapshot, err := h.IssueService.Dependencies.ReadWorkspace(r.Context(), issue.WorkspaceID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read dependencies")
			return false
		}
		proposal := snapshot.Proposal(issue, dependencyWrite.BlockedBy)
		if err = proposal.CheckRun(r.Context(), issue.ID); err != nil {
			var dep *service.DependencyError
			if !errors.As(err, &dep) {
				writeError(w, http.StatusInternalServerError, "failed to check dependencies")
				return false
			}
			item := IssueDependencyPreview{IssueID: uuidToString(issue.ID), ReasonCode: dep.Code, Dependencies: dep.View}
			if digest != "" && dep.Code == "dependency_unsatisfied" {
				item.Confirmation, err = h.IssueService.Dependencies.Challenge(r.Context(), snapshot, issue, trigger, dependencyWrite.BlockedBy, digest, req.IsCreate)
				if err != nil {
					if !writeDependencyError(w, err) {
						writeError(w, http.StatusInternalServerError, "failed to prepare confirmation")
					}
					return false
				}
			}
			resp.Blocked = append(resp.Blocked, item)
			return true
		}
		displayID := uuidToString(trigger.IssueID)
		if req.IsCreate {
			displayID = ""
		}
		resp.Triggers = append(resp.Triggers, IssueTriggerPreviewItem{IssueID: displayID, AgentID: uuidToString(trigger.AgentID), Source: string(trigger.Source)})
		return true
	}

	if req.IsCreate {
		wsUUID, err := util.ParseUUID(workspaceID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid workspace")
			return
		}
		status := "todo"
		if req.Status != nil && *req.Status != "" {
			status = *req.Status
		}
		candidate := db.Issue{
			ID:           dbid.NewV7(),
			WorkspaceID:  wsUUID,
			Status:       status,
			AssigneeType: newAssigneeType,
			AssigneeID:   newAssigneeID,
		}
		if !appendTrigger(candidate, service.IssueTriggerInput{Issue: candidate, IsCreate: true}) {
			return
		}
		resp.TotalCount = len(resp.Triggers)
		writeJSON(w, http.StatusOK, resp)
		return
	}

	for _, rawID := range req.IssueIDs {
		issueUUID, err := util.ParseUUID(rawID)
		if err != nil {
			continue // malformed id contributes no trigger; deterministic
		}
		loaded, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{
			ID:          issueUUID,
			WorkspaceID: parseUUID(workspaceID),
		})
		if err != nil {
			continue // cross-workspace / unknown id contributes no trigger
		}

		post := loaded
		in := service.IssueTriggerInput{PrevStatus: loaded.Status}
		if hasNewAssignee {
			post.AssigneeType = newAssigneeType
			post.AssigneeID = newAssigneeID
			in.AssigneeChanged = loaded.AssigneeType.String != newAssigneeType.String ||
				uuidToString(loaded.AssigneeID) != uuidToString(newAssigneeID)
		}
		if req.Status != nil && *req.Status != "" {
			post.Status = *req.Status
			in.StatusChanged = loaded.Status != *req.Status
		}
		in.Issue = post
		if !appendTrigger(post, in) {
			return
		}
	}

	resp.TotalCount = len(resp.Triggers)
	writeJSON(w, http.StatusOK, resp)
}

func issueRunOutcome(task db.AgentTaskQueue, coalesced bool) *DispatchOutcome {
	out := &DispatchOutcome{Status: DispatchDeferred, ReasonCode: ReasonDeferred}
	if task.ID.Valid {
		id := uuidToString(task.ID)
		out.TaskID = &id
		out.RunID = &id
		if task.Status != "deferred" {
			out.Status = DispatchQueued
			out.ReasonCode = ReasonQueued
		}
	}
	if coalesced && task.ID.Valid {
		out.Status, out.ReasonCode = DispatchCoalesced, ReasonCoalesced
	}
	return out
}
