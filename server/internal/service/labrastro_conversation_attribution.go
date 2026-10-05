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
	Changes    []string `json:"changes"`
}

type wakeupAuthority struct {
	attribution.Result
	RootTaskID pgtype.UUID
}

type wakeupSourceTask struct {
	ID       pgtype.UUID
	Required bool
}

// Captured roots remain mandatory even after task-history retention. A captured
// null root proves a first-party event; its ordinary source row may be gone.
func wakeupReceiptSources(receipts []db.IssueWakeupReceipt) ([]wakeupSourceTask, error) {
	var sources []wakeupSourceTask
	for _, receipt := range receipts {
		var source wakeupSources
		var fields map[string]json.RawMessage
		if json.Unmarshal(receipt.Payload, &source) != nil || json.Unmarshal(receipt.Payload, &fields) != nil || source.Conflict {
			return nil, channel.ErrConversationDenied
		}
		_, captured := fields["conversation_root_task_id"]
		for _, raw := range append(source.TaskIDs, source.TaskID) {
			if raw == "" {
				continue
			}
			id, err := util.ParseUUID(raw)
			if err != nil {
				return nil, channel.ErrConversationDenied
			}
			sources = append(sources, wakeupSourceTask{ID: id, Required: !captured})
		}
		if source.RootTaskID != "" {
			id, err := util.ParseUUID(source.RootTaskID)
			if err != nil {
				return nil, channel.ErrConversationDenied
			}
			sources = append(sources, wakeupSourceTask{ID: id, Required: true})
		}
	}
	return sources, nil
}

func (a wakeupAuthority) matches(task db.AgentTaskQueue) bool {
	return a.UserID == task.OriginatorUserID && a.RootTaskID == task.ConversationRootTaskID
}

// Classify every persisted source before considering the request context or
// issue/rule owner. Missing evidence and conflicting external grants fail closed.
// The root itself is the delegation anchor, so ordinary source retention cannot
// later strip a successfully classified run's frozen consent.
func conversationAttributionFromSources(ctx context.Context, q *db.Queries, workspaceID, agentID pgtype.UUID, sources []wakeupSourceTask) (wakeupAuthority, bool, error) {
	var result wakeupAuthority
	seen := map[wakeupSourceTask]bool{}
	for _, source := range sources {
		id := source.ID
		if !id.Valid || seen[source] {
			continue
		}
		seen[source] = true
		task, err := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{ID: id, WorkspaceID: workspaceID})
		if errors.Is(err, pgx.ErrNoRows) {
			if !source.Required {
				continue
			}
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
	sources, err := wakeupReceiptSources(receipts)
	if err != nil {
		return wakeupAuthority{}, err
	}
	// The event is the primary authority. The issue's historical creator and
	// the live request are only fallback evidence when no external source exists.
	// Registration history is optional, unlike a captured external grant. The
	// HTTP boundary prevents external tasks from registering wakeups themselves.
	sources = append(sources, wakeupSourceTask{ID: w.SourceTaskID})
	result, external, err := conversationAttributionFromSources(ctx, q, w.WorkspaceID, agent.ID, sources)
	if err != nil || external {
		return result, err
	}
	base := attribution.Result{UserID: w.CreatedBy, AccountableUserID: w.CreatedBy, Source: attribution.SourceTriggerOwner, DelegatedFromTaskID: w.SourceTaskID}
	if w.SystemRule.Valid {
		base = s.Tasks.attributionForIssueTask(ctx, issue, pgtype.UUID{}, attribution.SourceDelegation, pgtype.UUID{})
		result, external, err = conversationAttributionFromSources(ctx, q, w.WorkspaceID, agent.ID, []wakeupSourceTask{{ID: base.DelegatedFromTaskID}})
		if err != nil || external {
			return result, err
		}
	}
	base, err = s.Tasks.applyAttributionFallback(ctx, base, agent)
	return wakeupAuthority{Result: base}, err
}

// Denial is a terminal outcome for these inputs, not a scheduler failure. Keep
// the rule enabled so a later independent human event can still fire it. A
// coalesced batch cannot safely be split back into its original source events.
func rejectWakeupReceipts(ctx context.Context, q *db.Queries, receipts []db.IssueWakeupReceipt, note func(string, map[string]any) error) error {
	if err := q.ConsumeWakeupReceipts(ctx, db.ConsumeWakeupReceiptsParams{Ids: receiptIDs(receipts)}); err != nil {
		return err
	}
	details := wakeupTriggerDetails(db.AgentTaskQueue{}, receipts)
	delete(details, "task_id")
	details["outcome"], details["reason"] = "rejected", "External conversation authorization unavailable or conflicting."
	return note(wakeupActivityTriggered, details)
}

// Prepare credentials from a read-only snapshot, outside the dispatch locks.
// Dispatch reclassifies locked inputs and retries if their principal changed.
func (s *IssueWakeupService) prepareWakeupOverlay(ctx context.Context, w db.IssueWakeup, issue db.Issue, agent db.Agent) (pgtype.UUID, runtimeMCPOverlayData, error) {
	if !agent.ID.Valid {
		return pgtype.UUID{}, runtimeMCPOverlayData{}, nil
	}
	receipts, err := s.Tasks.Queries.ListWakeupReceiptSources(ctx, db.ListWakeupReceiptSourcesParams{WakeupID: w.ID, Revision: w.Revision})
	if err != nil {
		return pgtype.UUID{}, runtimeMCPOverlayData{}, err
	}
	authority, err := s.wakeupRunAuthority(ctx, s.Tasks.Queries, issue, agent, w, receipts)
	if errors.Is(err, channel.ErrConversationDenied) {
		return pgtype.UUID{}, runtimeMCPOverlayData{}, nil
	}
	if err != nil {
		return pgtype.UUID{}, runtimeMCPOverlayData{}, err
	}
	return authority.UserID, s.Tasks.buildRuntimeMCPOverlay(ctx, authority.UserID, agent), nil
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
