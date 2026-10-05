package service

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/attribution"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrConversationQuickCreateOrigin = errors.New("quick-create origin must belong to the current conversation task's ancestry")

// A same-agent quick-create task from another human is not evidence for this
// request. Walk only persisted execution parents; a sibling is not an ancestor.
func validateConversationQuickCreateOrigin(ctx context.Context, q *db.Queries, workspaceID, originID pgtype.UUID) error {
	current, external := channel.ConversationTaskFromContext(ctx)
	if !external {
		return nil
	}
	seen := map[pgtype.UUID]bool{}
	for current.ID.Valid && !seen[current.ID] {
		if current.ID == originID {
			return nil
		}
		seen[current.ID] = true
		parent := current.RetryOfTaskID
		if !parent.Valid && (current.OriginatorSource.String == "delegation" || current.OriginatorSource.String == "comment_source") {
			parent = current.DelegatedFromTaskID
		}
		if !parent.Valid {
			break
		}
		var err error
		current, err = q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: parent, WorkspaceID: workspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			break
		}
		if err != nil {
			return err
		}
	}
	return ErrConversationQuickCreateOrigin
}

// Wakeup receipts are trusted database evidence, not prompt text. Coalescing
// retains a bounded external-root summary even when its latest event is human.
type wakeupSources struct {
	TaskID     string   `json:"source_task_id"`
	TaskIDs    []string `json:"source_task_ids"`
	RootTaskID string   `json:"conversation_root_task_id"`
	Conflict   bool     `json:"conversation_roots_conflict"`
	Incomplete bool     `json:"sources_incomplete"`
	Count      int64    `json:"coalesced_count"`
}

type wakeupAuthority struct {
	attribution.Result
	RootTaskID pgtype.UUID
}

func (a wakeupAuthority) matches(task db.AgentTaskQueue) bool {
	return a.UserID == task.OriginatorUserID && a.RootTaskID == task.ConversationRootTaskID
}

// Classify every persisted source before considering the request context or
// issue/rule owner. Missing evidence and conflicting external grants fail closed.
// The root itself is the delegation anchor, so ordinary source retention cannot
// later strip a successfully classified run's frozen consent.
func conversationAttributionFromSources(ctx context.Context, q *db.Queries, workspaceID, agentID pgtype.UUID, ids []pgtype.UUID) (wakeupAuthority, bool, error) {
	var result wakeupAuthority
	seen := map[pgtype.UUID]bool{}
	for _, id := range ids {
		if !id.Valid || seen[id] {
			continue
		}
		seen[id] = true
		task, err := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: id, WorkspaceID: workspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return result, false, channel.ErrConversationDenied
		}
		if err != nil {
			return result, false, err
		}
		if !task.ConversationRootTaskID.Valid && task.OriginatorSource.String != channel.ConversationOrigin {
			continue
		}
		// Validate the target agent's invocation rights under the same grant.
		candidate := db.AgentTaskQueue{AgentID: agentID, OriginatorUserID: task.OriginatorUserID,
			ConversationRootTaskID: task.ConversationRootTaskID, OriginatorSource: task.OriginatorSource}
		subject, err := channel.AuthorizeConversationTask(ctx, q, candidate, workspaceID)
		if err != nil {
			return result, false, err
		}
		if result.RootTaskID.Valid && result.RootTaskID != task.ConversationRootTaskID {
			return result, false, channel.ErrConversationDenied
		}
		result = wakeupAuthority{RootTaskID: task.ConversationRootTaskID, Result: attribution.Result{
			UserID: subject.UserID, AccountableUserID: subject.UserID,
			Source: attribution.SourceDelegation, DelegatedFromTaskID: task.ConversationRootTaskID,
		}}
	}
	return result, result.RootTaskID.Valid, nil
}

func (s *IssueWakeupService) wakeupRunAuthority(ctx context.Context, q *db.Queries, issue db.Issue, agent db.Agent, w db.IssueWakeup, receipts []db.IssueWakeupReceipt) (wakeupAuthority, error) {
	var ids []pgtype.UUID
	for _, receipt := range receipts {
		var source wakeupSources
		if err := json.Unmarshal(receipt.Payload, &source); err != nil {
			return wakeupAuthority{}, err
		}
		if source.Conflict {
			return wakeupAuthority{}, channel.ErrConversationDenied
		}
		for _, raw := range append(source.TaskIDs, source.TaskID, source.RootTaskID) {
			if raw == "" {
				continue
			}
			id, err := util.ParseUUID(raw)
			if err != nil {
				return wakeupAuthority{}, channel.ErrConversationDenied
			}
			ids = append(ids, id)
		}
	}
	// The event is the primary authority. The issue's historical creator and
	// the live request are only fallback evidence when no external source exists.
	ids = append(ids, w.SourceTaskID)
	result, external, err := conversationAttributionFromSources(ctx, q, w.WorkspaceID, agent.ID, ids)
	if err != nil || external {
		return result, err
	}
	base := attribution.Result{UserID: w.CreatedBy, AccountableUserID: w.CreatedBy, Source: attribution.SourceTriggerOwner, DelegatedFromTaskID: w.SourceTaskID}
	if w.SystemRule.Valid {
		base = s.Tasks.attributionForIssueTask(ctx, issue, pgtype.UUID{}, attribution.SourceDelegation, pgtype.UUID{})
		result, external, err = conversationAttributionFromSources(ctx, q, w.WorkspaceID, agent.ID, []pgtype.UUID{base.DelegatedFromTaskID})
		if err != nil || external {
			return result, err
		}
	}
	base, err = s.Tasks.applyAttributionFallback(ctx, base, agent)
	return wakeupAuthority{Result: base}, err
}

// A denied external wakeup must neither join nor prevent an independently
// authorized run from starting. Infrastructure errors still retry the claim.
func (s *IssueWakeupService) wakeupMayJoin(ctx context.Context, q *db.Queries, issue db.Issue, agent db.Agent, task db.AgentTaskQueue, w db.IssueWakeup, receipts []db.IssueWakeupReceipt) (bool, error) {
	authority, err := s.wakeupRunAuthority(ctx, q, issue, agent, w, receipts)
	if errors.Is(err, channel.ErrConversationDenied) {
		return false, nil
	}
	return err == nil && authority.matches(task), err
}
