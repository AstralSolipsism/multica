package service

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// LockAdmission precedes capacity and queue locks. Structural writers take the
// incompatible structure lock; status producers synchronize through
// the issue row locks without acquiring new completion-specific permissions.
// The workspace KEY SHARE lock fences deletion without keeping writers out of
// the structure lock's wait queue. Do not strengthen it to SHARE: successive
// readers can otherwise starve a writer waiting on the workspace counter row.
// ponytail: full-workspace snapshots still cost O(V+E); use the OL-45 load gate
// before increasing rollout size, and narrow only with a closure proof.
func (s *DependencyService) LockAdmission(ctx context.Context, q *db.Queries, ws pgtype.UUID) (*DependencySnapshot, error) {
	if _, err := q.LockWorkspaceForDependencyAdmission(ctx, ws); err != nil {
		return nil, err
	}
	if err := q.LockIssueStatusCatalogShared(ctx, ws); err != nil {
		return nil, err
	}
	if err := q.LockIssueDependencyStructureShared(ctx, ws); err != nil {
		return nil, err
	}
	if err := q.LockIssuesForDependencyAdmission(ctx, ws); err != nil {
		return nil, err
	}
	return s.Load(ctx, q, ws)
}

func (s *DependencySnapshot) CheckRun(ctx context.Context, issueID pgtype.UUID) error {
	if !issueID.Valid {
		return nil
	}
	if _, ok := s.Model.Issues[util.UUIDToString(issueID)]; !ok {
		return dependencyError("not_found", "issue not found")
	}
	return s.CheckWriteAdmission(ctx, db.Issue{ID: issueID}, false, true)
}

// WithIssueAdmission runs a mutation under the complete dependency snapshot.
// It accepts no human override; only the compound assignment transaction may
// mint an admission record for one specifically confirmed queue row.
func (s *TaskService) WithIssueAdmission(ctx context.Context, ws, issueID pgtype.UUID, fn func(*db.Queries) error) error {
	if s.TxStarter == nil {
		return errors.New("issue admission requires a transaction starter")
	}
	return s.runInTx(ctx, func(q *db.Queries) error {
		snapshot, err := NewDependencyService(s.Queries, s.TxStarter).LockAdmission(ctx, q, ws)
		if err != nil {
			return err
		}
		if err := snapshot.CheckRun(ctx, issueID); err != nil {
			return err
		}
		return fn(q)
	})
}

func (s *TaskService) enqueuePreparedTask(ctx context.Context, issue db.Issue, p db.CreateAgentTaskParams, fireAt pgtype.Timestamptz) (db.AgentTaskQueue, error) {
	var task db.AgentTaskQueue
	err := s.WithIssueAdmission(ctx, issue.WorkspaceID, issue.ID, func(q *db.Queries) error {
		var err error
		task, err = insertPreparedIssueTask(ctx, q, p, fireAt)
		return err
	})
	return task, err
}

// PreparedIssueRun contains only database inputs. External overlay preparation
// occurs before any transaction; the target is checked again before insertion.
type PreparedIssueRun struct {
	Params db.CreateAgentTaskParams
	FireAt pgtype.Timestamptz
}

func (s *TaskService) PrepareIssueRun(ctx context.Context, issue db.Issue, trigger IssueRunTrigger, actor pgtype.UUID, handoff string) (*PreparedIssueRun, error) {
	var p db.CreateAgentTaskParams
	var err error
	if trigger.AssigneeType == "squad" {
		p, err = s.prepareMentionTaskWithCommentPlan(ctx, issue, trigger.AgentID, pgtype.UUID{}, nil, true, issue.AssigneeID, false, handoff, actor, pgtype.UUID{})
	} else {
		p, err = s.prepareIssueTaskWithCommentPlan(ctx, issue, pgtype.UUID{}, nil, false, handoff, actor, pgtype.UUID{}, pgtype.Timestamptz{})
	}
	if err != nil {
		return nil, err
	}
	return &PreparedIssueRun{Params: p}, nil
}

// EnqueueIssueRunTx is used by compound issue writes after validating their
// proposed snapshot. The caller owns commit and publishes only the returned row.
func (s *TaskService) EnqueueIssueRunTx(ctx context.Context, q *db.Queries, issue db.Issue, trigger IssueRunTrigger, prepared *PreparedIssueRun, snapshot *DependencySnapshot, confirmation []byte) (db.AgentTaskQueue, error) {
	if snapshot == nil {
		return db.AgentTaskQueue{}, dependencyError("dependency_data_unverified", "dependency snapshot is required")
	}
	if err := snapshot.CheckRun(ctx, issue.ID); err != nil {
		var dep *DependencyError
		if confirmation == nil || !errors.As(err, &dep) || dep.Code != "dependency_unsatisfied" {
			return db.AgentTaskQueue{}, err
		}
	}
	if prepared == nil || prepared.Params.AgentID != trigger.AgentID {
		return db.AgentTaskQueue{}, dependencyError("dependency_version_conflict", "execution target changed; refresh before dispatch")
	}
	p := prepared.Params
	p.IssueID = issue.ID
	p.Priority = priorityToInt(issue.Priority)
	if trigger.AssigneeType == "squad" {
		squad, err := q.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: issue.AssigneeID, WorkspaceID: issue.WorkspaceID})
		if err != nil || squad.LeaderID != p.AgentID || squad.ArchivedAt.Valid {
			return db.AgentTaskQueue{}, dependencyError("dependency_version_conflict", "squad leader changed; refresh before dispatch")
		}
	}
	agent, err := q.GetAgent(ctx, p.AgentID)
	if err != nil || agent.ArchivedAt.Valid || agent.RuntimeID != p.RuntimeID {
		return db.AgentTaskQueue{}, dependencyError("dependency_version_conflict", "execution target changed; refresh before dispatch")
	}
	// Preserve pending-task dedup, including the reviewed head. Under the issue
	// lock, concurrent admitted enqueues cannot race this check in the same workspace.
	pending, err := q.GetPendingTaskForIssueAndAgent(ctx, db.GetPendingTaskForIssueAndAgentParams{IssueID: issue.ID, AgentID: p.AgentID, HeadSha: p.HeadSha})
	if err == nil {
		return pending, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.AgentTaskQueue{}, fmt.Errorf("load pending execution: %w", err)
	}
	return insertPreparedIssueTask(ctx, q, p, prepared.FireAt)
}

func (s *TaskService) PublishIssueTask(ctx context.Context, task db.AgentTaskQueue) {
	if !task.ID.Valid {
		return
	}
	if task.Status == "deferred" {
		s.notifyRuntimeMayHaveWork(task.RuntimeID, "")
		return
	}
	s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, task)
	s.NotifyTaskEnqueued(ctx, task)
}

func (s *TaskService) checkRetryAdmission(ctx context.Context, q *db.Queries, parent db.AgentTaskQueue) error {
	if !parent.IssueID.Valid && parent.AutopilotRunID.Valid {
		run, err := q.GetAutopilotRun(ctx, parent.AutopilotRunID)
		if err != nil {
			return dependencyError("dependency_data_unverified", "autopilot execution target is unavailable")
		}
		parent.IssueID = run.IssueID
	}
	if !parent.IssueID.Valid {
		return nil
	}
	issue, err := q.GetIssue(ctx, parent.IssueID)
	if err != nil {
		return dependencyError("not_found", "issue not found")
	}
	snapshot, err := NewDependencyService(s.Queries, s.TxStarter).LockAdmission(ctx, q, issue.WorkspaceID)
	if err != nil {
		return err
	}
	return snapshot.CheckRun(ctx, parent.IssueID)
}

// reclaimDependencyTasks keeps the workspace/issue locks ahead of the queue
// update, including a machine polling runtimes from several workspaces. New
// rows carry a consumed proof; legacy dispatched rows are checked now.
func (s *TaskService) reclaimDependencyTasks(ctx context.Context, ids []pgtype.UUID, maxTasks int32) ([]db.AgentTaskQueue, error) {
	if s.TxStarter == nil {
		return nil, errors.New("task recovery requires a transaction starter")
	}
	var admitted, rejected []db.AgentTaskQueue
	err := s.runInTx(ctx, func(q *db.Queries) error {
		runtimes, err := q.GetAgentRuntimes(ctx, ids)
		if err != nil {
			return err
		}
		workspaces := map[string]pgtype.UUID{}
		runtimeWorkspace := map[pgtype.UUID]string{}
		for _, runtime := range runtimes {
			key := util.UUIDToString(runtime.WorkspaceID)
			workspaces[key] = runtime.WorkspaceID
			runtimeWorkspace[runtime.ID] = key
		}
		keys := make([]string, 0, len(workspaces))
		for key := range workspaces {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		snapshots := map[string]*DependencySnapshot{}
		for _, key := range keys {
			snapshots[key], err = NewDependencyService(s.Queries, s.TxStarter).LockAdmission(ctx, q, workspaces[key])
			if err != nil {
				return err
			}
		}
		for int32(len(admitted)) < maxTasks {
			rows, err := q.ReclaimStaleDispatchedTasksForRuntimes(ctx, db.ReclaimStaleDispatchedTasksForRuntimesParams{RuntimeIds: ids, MaxTasks: maxTasks - int32(len(admitted)), ClaimRecoverySecs: claimResponseRecoveryWindow.Seconds(), PrepareLeaseSecs: prepareLeaseDuration.Seconds(), RuntimeStaleSecs: RuntimeClaimFreshnessSeconds})
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				break
			}
			for _, row := range rows {
				snapshot := snapshots[runtimeWorkspace[row.RuntimeID]]
				if snapshot == nil {
					return dependencyError("dependency_data_unverified", "execution workspace is unavailable")
				}
				task, err := snapshot.AdmitClaim(ctx, q, row)
				if err == nil {
					admitted = append(admitted, task)
					continue
				}
				var dep *DependencyError
				if !errors.As(err, &dep) {
					return err
				}
				denied, err := q.RejectTaskDependencyAdmission(ctx, db.RejectTaskDependencyAdmissionParams{ID: row.ID, Error: pgtype.Text{String: dep.Message, Valid: true}, FailureReason: pgtype.Text{String: dep.Code, Valid: true}})
				if err != nil {
					return err
				}
				rejected = append(rejected, denied)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, task := range rejected {
		s.broadcastTaskFailedEvent(ctx, task, task.Error.String, task.FailureReason.String, false)
	}
	return admitted, nil
}

// WithPendingIssueAdmission checks only a pre-claim merge. A missing merge
// target must still let the caller preserve input for an already active run.
func (s *TaskService) WithPendingIssueAdmission(ctx context.Context, ws, issueID, agentID pgtype.UUID, head pgtype.Text, fn func(*db.Queries) error) error {
	if s.TxStarter == nil {
		return errors.New("issue admission requires a transaction starter")
	}
	return s.runInTx(ctx, func(q *db.Queries) error {
		snapshot, err := NewDependencyService(s.Queries, s.TxStarter).LockAdmission(ctx, q, ws)
		if err != nil {
			return err
		}
		pending, err := q.GetPendingTaskForIssueAndAgent(ctx, db.GetPendingTaskForIssueAndAgentParams{IssueID: issueID, AgentID: agentID, HeadSha: head})
		if err != nil {
			return err
		}
		if pending.Status == "dispatched" {
			return pgx.ErrNoRows
		}
		if err := snapshot.CheckRun(ctx, issueID); err != nil {
			return err
		}
		return fn(q)
	})
}
