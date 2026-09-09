package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/issuedependency"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type DependencyOverride struct {
	RequestID string `json:"request_id"`
	Challenge string `json:"challenge"`
}

type DependencyChallenge struct {
	DependencyOverride
	ExpiresAt time.Time `json:"expires_at"`
}

type dependencyChallengeClaims struct {
	RequestID     string    `json:"request_id"`
	WorkspaceID   string    `json:"workspace_id"`
	IssueID       string    `json:"issue_id"`
	AgentID       string    `json:"agent_id"`
	SquadID       string    `json:"squad_id"`
	UserID        string    `json:"user_id"`
	PayloadDigest string    `json:"payload_digest"`
	Version       string    `json:"version"`
	Creating      bool      `json:"creating"`
	ExpiresAt     time.Time `json:"expires_at"`
}

// The record belongs to one queue row, outside its mutable prompt/context.
// Retry SQL never copies it. ConsumedAt proves this row crossed the first
// dispatch boundary, including recovery after a lost response or failed token
// finalization. TaskID prevents a copied record authorizing a different run.
type dependencyAdmission struct {
	RequestID         string     `json:"request_id,omitempty"`
	PayloadDigest     string     `json:"payload_digest,omitempty"`
	ConfirmedBy       string     `json:"confirmed_by,omitempty"`
	ConfirmedAt       time.Time  `json:"confirmed_at,omitempty"`
	DependencyVersion string     `json:"dependency_version"`
	TaskID            string     `json:"task_id"`
	IssueID           string     `json:"issue_id"`
	AgentID           string     `json:"agent_id"`
	SquadID           string     `json:"squad_id"`
	ClaimBefore       time.Time  `json:"claim_before,omitempty"`
	ConsumedAt        *time.Time `json:"consumed_at,omitempty"`
}

// DependencyPayloadDigest canonicalizes the entire mutation, not just assignee
// fields. Equivalent JSON whitespace/order is harmless; changed input is not.
func DependencyPayloadDigest(raw []byte) (string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return "", dependencyError("dependency_override_stale", "invalid mutation payload")
	}
	delete(fields, "dependency_override")
	canonical, err := json.Marshal(fields)
	if err != nil {
		return "", err
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(canonical)))
	decoder.UseNumber()
	if err = decoder.Decode(&value); err != nil {
		return "", err
	}
	canonical, err = json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

// ProposalVersion includes both the old target and proposed inherited/direct
// constraints. Synthetic edge IDs are deterministic; they are never persisted.
func (s *DependencySnapshot) Proposal(issue db.Issue, blockedBy *[]pgtype.UUID) *DependencySnapshot {
	next := *s
	next.Model = s.Model.Clone()
	id := util.UUIDToString(issue.ID)
	n := next.Model.Issues[id]
	n.ID = id
	n.ParentID = util.UUIDToString(issue.ParentIssueID)
	next.Model.Issues[id] = n
	if blockedBy != nil {
		kept := []issuedependency.Edge{}
		for _, e := range next.Model.Edges {
			if e.IssueID != id || e.Type != "blocked_by" {
				kept = append(kept, e)
			}
		}
		refs := map[string]bool{}
		for _, r := range *blockedBy {
			refs[util.UUIDToString(r)] = true
		}
		keys := make([]string, 0, len(refs))
		for key := range refs {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			kept = append(kept, issuedependency.Edge{ID: "proposal:" + key, IssueID: id, DependsOnID: key, Type: "blocked_by"})
		}
		next.Model.Edges = kept
	}
	return &next
}

func (s *DependencyService) signChallenge(payload []byte) []byte {
	mac := hmac.New(sha256.New, s.SigningKey)
	mac.Write([]byte("issue-dependency-confirmation-v1\x00"))
	mac.Write(payload)
	return mac.Sum(nil)
}

func (s *DependencyService) decodeChallenge(ctx context.Context, override *DependencyOverride, digest string, ws pgtype.UUID) (dependencyChallengeClaims, error) {
	var c dependencyChallengeClaims
	identity, ok := auth.IdentityFromContext(ctx)
	if !ok || !isDependencyHuman(ctx) {
		return c, dependencyError("dependency_override_not_allowed", "explicit confirmation requires an authenticated human session")
	}
	if override == nil || len(override.Challenge) > 8192 {
		return c, dependencyError("dependency_override_stale", "invalid confirmation")
	}
	parts := strings.Split(override.Challenge, ".")
	if len(parts) != 2 {
		return c, dependencyError("dependency_override_stale", "invalid confirmation")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return c, dependencyError("dependency_override_stale", "invalid confirmation")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, s.signChallenge(payload)) {
		return c, dependencyError("dependency_override_stale", "invalid confirmation")
	}
	if json.Unmarshal(payload, &c) != nil || c.RequestID != override.RequestID || c.UserID != identity.UserID || c.WorkspaceID != util.UUIDToString(ws) || c.PayloadDigest != digest {
		return c, dependencyError("dependency_override_stale", "confirmation does not match this mutation")
	}
	return c, nil
}

func (s *DependencyService) humanCanInvoke(ctx context.Context, q *db.Queries, ws pgtype.UUID, userID, agentID, squadID string) error {
	user, err := util.ParseUUID(userID)
	if err != nil {
		return err
	}
	agentUUID, err := util.ParseUUID(agentID)
	if err != nil {
		return err
	}
	if _, err = q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: user, WorkspaceID: ws}); err != nil {
		return dependencyError("dependency_override_not_allowed", "confirmation permission is no longer available")
	}
	agent, err := q.GetAgent(ctx, agentUUID)
	if err != nil || agent.WorkspaceID != ws || agent.ArchivedAt.Valid {
		return dependencyError("dependency_override_not_allowed", "execution target is unavailable")
	}
	if squadID != "" {
		squadUUID, err := util.ParseUUID(squadID)
		if err != nil {
			return err
		}
		squad, err := q.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: squadUUID, WorkspaceID: ws})
		if err != nil || squad.LeaderID != agentUUID {
			return dependencyError("dependency_override_stale", "squad leader changed; confirm the current target")
		}
	}
	if agent.OwnerID == user {
		return nil
	}
	if agent.PermissionMode == "public_to" {
		targets, err := q.ListAgentInvocationTargets(ctx, agent.ID)
		if err != nil {
			return err
		}
		for _, target := range targets {
			if target.TargetType == "workspace" || (target.TargetType == "member" && target.TargetID == user) {
				return nil
			}
		}
	}
	return dependencyError("dependency_override_not_allowed", "confirmation permission is no longer available")
}

func (s *DependencyService) Challenge(ctx context.Context, snapshot *DependencySnapshot, issue db.Issue, trigger IssueRunTrigger, blockedBy *[]pgtype.UUID, digest string, creating bool) (*DependencyChallenge, error) {
	if !isDependencyHuman(ctx) {
		return nil, nil
	}
	identity, _ := auth.IdentityFromContext(ctx)
	squadID := ""
	if trigger.AssigneeType == "squad" {
		squadID = util.UUIDToString(issue.AssigneeID)
	}
	if err := s.humanCanInvoke(ctx, s.Queries, issue.WorkspaceID, identity.UserID, util.UUIDToString(trigger.AgentID), squadID); err != nil {
		return nil, err
	}
	c := dependencyChallengeClaims{
		RequestID: util.UUIDToString(dbid.NewV7()), WorkspaceID: util.UUIDToString(issue.WorkspaceID),
		IssueID: util.UUIDToString(issue.ID), AgentID: util.UUIDToString(trigger.AgentID), SquadID: squadID,
		UserID: identity.UserID, PayloadDigest: digest, Version: snapshot.ProposalVersion(issue, blockedBy),
		Creating: creating, ExpiresAt: time.Now().UTC().Add(5 * time.Minute),
	}
	payload, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(s.signChallenge(payload))
	return &DependencyChallenge{DependencyOverride: DependencyOverride{RequestID: c.RequestID, Challenge: token}, ExpiresAt: c.ExpiresAt}, nil
}

func (s *DependencyService) OverrideCreateID(ctx context.Context, override *DependencyOverride, digest string, ws pgtype.UUID) (pgtype.UUID, error) {
	c, err := s.decodeChallenge(ctx, override, digest, ws)
	if err != nil {
		return pgtype.UUID{}, err
	}
	if !c.Creating {
		return pgtype.UUID{}, dependencyError("dependency_override_stale", "confirmation is for an existing issue")
	}
	return util.ParseUUID(c.IssueID)
}

// Replay runs before issue mutation under the workspace write lock. A retry is
// read-only even after the original run finishes. Expired challenges cannot be
// used to mint a new row if retention/deletion has removed their old record.
func (s *DependencyService) Replay(ctx context.Context, q *db.Queries, ws, issueID pgtype.UUID, override *DependencyOverride, digest string) (*db.AgentTaskQueue, error) {
	if override == nil {
		return nil, nil
	}
	c, err := s.decodeChallenge(ctx, override, digest, ws)
	if err != nil {
		return nil, err
	}
	if c.IssueID != util.UUIDToString(issueID) {
		return nil, dependencyError("dependency_override_stale", "confirmation target changed")
	}
	task, err := q.GetTaskByDependencyRequest(ctx, c.RequestID)
	if errors.Is(err, pgx.ErrNoRows) {
		used, checkErr := q.HasDependencyConfirmationRequest(ctx, db.HasDependencyConfirmationRequestParams{WorkspaceID: ws, RequestID: c.RequestID})
		if checkErr != nil {
			return nil, checkErr
		}
		if used {
			return nil, dependencyError("dependency_override_stale", "this confirmation has already been used")
		}

		if !time.Now().Before(c.ExpiresAt) {
			return nil, dependencyError("dependency_override_expired", "confirmation expired; preview again")
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var a dependencyAdmission
	if json.Unmarshal(task.DependencyAdmission, &a) != nil || a.ConfirmedBy != c.UserID || a.PayloadDigest != digest || a.TaskID != util.UUIDToString(task.ID) || a.IssueID != c.IssueID || a.AgentID != c.AgentID || a.SquadID != c.SquadID {
		return nil, dependencyError("dependency_override_stale", "request ID is already bound to a different execution")
	}
	return &task, nil
}

func (s *DependencyService) Confirm(ctx context.Context, q *db.Queries, before *DependencySnapshot, issue db.Issue, trigger IssueRunTrigger, write DependencyWrite) ([]byte, error) {
	c, err := s.decodeChallenge(ctx, write.Override, write.PayloadDigest, issue.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if !time.Now().Before(c.ExpiresAt) {
		return nil, dependencyError("dependency_override_expired", "confirmation expired; preview again")
	}
	squadID := ""
	if trigger.AssigneeType == "squad" {
		squadID = util.UUIDToString(issue.AssigneeID)
	}
	if c.Creating != write.Creating || c.IssueID != util.UUIDToString(issue.ID) || c.AgentID != util.UUIDToString(trigger.AgentID) || c.SquadID != squadID || c.Version != before.ProposalVersion(issue, write.BlockedBy) {
		return nil, dependencyError("dependency_override_stale", "dependencies or execution target changed; preview again")
	}
	if err = s.humanCanInvoke(ctx, q, issue.WorkspaceID, c.UserID, c.AgentID, squadID); err != nil {
		return nil, err
	}
	a := dependencyAdmission{
		RequestID: c.RequestID, PayloadDigest: c.PayloadDigest, ConfirmedBy: c.UserID, ConfirmedAt: time.Now().UTC(),
		IssueID: c.IssueID, AgentID: c.AgentID, SquadID: c.SquadID, ClaimBefore: time.Now().UTC().Add(15 * time.Minute),
	}
	return json.Marshal(a)
}

func (s *DependencySnapshot) RecordConfirmation(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, record []byte) (db.AgentTaskQueue, error) {
	var a dependencyAdmission
	if json.Unmarshal(record, &a) != nil {
		return db.AgentTaskQueue{}, dependencyError("dependency_override_stale", "invalid confirmation record")
	}
	if task.DependencyAdmission != nil || task.Status != "queued" && task.Status != "deferred" {
		return db.AgentTaskQueue{}, dependencyError("dependency_override_stale", "confirmation requires a new execution")
	}
	a.TaskID = util.UUIDToString(task.ID)
	a.DependencyVersion = s.Version(a.IssueID)
	raw, err := json.Marshal(a)
	if err != nil {
		return db.AgentTaskQueue{}, err
	}
	tombstone, _ := json.Marshal(map[string]string{"request_id": a.RequestID, "task_id": a.TaskID})
	if err = s.service.audit(ctx, q, s.WorkspaceID, task.IssueID, "dispatch_confirmation", "{}", string(tombstone)); err != nil {
		return db.AgentTaskQueue{}, err
	}

	return q.SetTaskDependencyAdmission(ctx, db.SetTaskDependencyAdmissionParams{ID: task.ID, DependencyAdmission: raw})
}

func (s *DependencySnapshot) AdmitClaim(ctx context.Context, q *db.Queries, task db.AgentTaskQueue) (db.AgentTaskQueue, error) {
	// Older run-only rows may predate issue binding. The live server-owned
	// autopilot association, never caller context, supplies their effective target.
	if !task.IssueID.Valid && task.AutopilotRunID.Valid {
		run, err := q.GetAutopilotRun(ctx, task.AutopilotRunID)
		if err != nil {
			return task, dependencyError("dependency_data_unverified", "autopilot execution target is unavailable")
		}
		if run.IssueID.Valid {
			task, err = q.BindTaskDependencyIssue(ctx, db.BindTaskDependencyIssueParams{ID: task.ID, IssueID: run.IssueID})
			if err != nil {
				return task, err
			}
		}
	}
	if !task.IssueID.Valid {
		return task, nil
	}
	if _, exists := s.Model.Issues[util.UUIDToString(task.IssueID)]; !exists {
		return task, dependencyError("dependency_data_unverified", "execution issue is missing from its workspace")
	}
	var a dependencyAdmission
	if len(task.DependencyAdmission) > 0 && json.Unmarshal(task.DependencyAdmission, &a) != nil {
		return task, dependencyError("dependency_override_stale", "invalid execution admission")
	}
	matches := a.TaskID == util.UUIDToString(task.ID) && a.IssueID == util.UUIDToString(task.IssueID) && a.AgentID == util.UUIDToString(task.AgentID) && a.SquadID == util.UUIDToString(task.SquadID)
	if matches && a.ConsumedAt != nil {
		return task, nil
	}
	err := s.CheckRun(ctx, task.IssueID)
	if err != nil {
		var dep *DependencyError
		if !errors.As(err, &dep) || dep.Code != "dependency_unsatisfied" || a.ConfirmedBy == "" {
			return task, err
		}
		if !matches || a.DependencyVersion != s.Version(util.UUIDToString(task.IssueID)) {
			return task, dependencyError("dependency_override_stale", "dependencies changed after confirmation")
		}
		if !time.Now().Before(a.ClaimBefore) {
			return task, dependencyError("dependency_override_expired", "execution confirmation expired")
		}
		if err = s.service.humanCanInvoke(ctx, q, s.WorkspaceID, a.ConfirmedBy, a.AgentID, a.SquadID); err != nil {
			return task, err
		}
	}
	now := time.Now().UTC()
	a.ConsumedAt = &now
	a.TaskID = util.UUIDToString(task.ID)
	a.IssueID = util.UUIDToString(task.IssueID)
	a.AgentID = util.UUIDToString(task.AgentID)
	a.SquadID = util.UUIDToString(task.SquadID)
	a.DependencyVersion = s.Version(a.IssueID)
	raw, err := json.Marshal(a)
	if err != nil {
		return task, err
	}
	return q.SetTaskDependencyAdmission(ctx, db.SetTaskDependencyAdmissionParams{ID: task.ID, DependencyAdmission: raw})
}

func (s *DependencySnapshot) ProposalVersion(issue db.Issue, blockedBy *[]pgtype.UUID) string {
	return s.Proposal(issue, blockedBy).Version(util.UUIDToString(issue.ID))
}

func (s *DependencyService) ReadWorkspace(ctx context.Context, ws pgtype.UUID) (*DependencySnapshot, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"); err != nil {
		return nil, err
	}
	snapshot, err := s.Load(ctx, s.Queries.WithTx(tx), ws)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return snapshot, nil
}
