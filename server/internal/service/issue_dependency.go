package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/issuedependency"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type DependencyError struct {
	Code      string
	Message   string
	View      *DependencyView
	Violation *issuedependency.Violation
}

func (e *DependencyError) Error() string { return e.Message }

func dependencyError(code, message string) *DependencyError {
	return &DependencyError{Code: code, Message: message}
}

// DependencyService owns graph validation and transaction-scoped relation writes.
// WritesEnabled is intentionally NOT wired to configuration in Stage 2. Only
// isolated tests enable it until enqueue/claim admission is integrated (OL-41).
type DependencyService struct {
	Queries       *db.Queries
	TxStarter     TxStarter
	SigningKey    []byte
	WritesEnabled bool
}

func NewDependencyService(q *db.Queries, tx TxStarter) *DependencyService {
	return &DependencyService{Queries: q, TxStarter: tx, SigningKey: auth.JWTSecret()}
}

type DependencySnapshot struct {
	WorkspaceID pgtype.UUID
	Model       issuedependency.Model
	Catalog     []db.IssueStatus
	service     *DependencyService
}

// LockWrite must precede any issue, attachment, queue or agent-capacity lock.
// Workspace ownership/counter -> catalog -> structure -> attachments (if any)
// -> sorted issue rows. Attachment binders already lock attachments before issues.
// Stage 2 favors a simple serialized write boundary. Read() uses MVCC and does
// not block edits. A future admission transaction can use the shared structural
// query and lock just the target's effective prerequisite rows in UUID order.
func (s *DependencyService) LockWrite(ctx context.Context, q *db.Queries, ws pgtype.UUID) error {
	if _, err := q.LockWorkspaceForDependencyWrite(ctx, ws); err != nil {
		return err
	}
	if err := q.LockIssueStatusCatalogShared(ctx, ws); err != nil {
		return err
	}
	if err := q.LockIssueDependencyStructure(ctx, ws); err != nil {
		return err
	}
	return nil
}

// LoadForWrite follows LockWrite and any attachment locks the caller needs.
// A status update that commits first is observed; one that arrives later waits
// until the structural edit commits or rolls back.
func (s *DependencyService) LoadForWrite(ctx context.Context, q *db.Queries, ws pgtype.UUID) (*DependencySnapshot, error) {
	if err := q.LockIssuesForDependencyWrite(ctx, ws); err != nil {
		return nil, err
	}
	return s.Load(ctx, q, ws)
}

// Load uses the caller's transaction. For display, use a repeatable-read
// transaction; for writes, use LockWrite followed by LoadForWrite. No list
// pagination is involved.
func (s *DependencyService) Load(ctx context.Context, q *db.Queries, ws pgtype.UUID) (*DependencySnapshot, error) {
	nodes, err := q.ListIssueDependencyNodes(ctx, ws)
	if err != nil {
		return nil, err
	}
	edges, err := q.ListIssueDependencyEdges(ctx, ws)
	if err != nil {
		return nil, err
	}
	catalog, err := q.ListIssueStatusEntries(ctx, db.ListIssueStatusEntriesParams{WorkspaceID: ws, IncludeArchived: true})
	if err != nil {
		return nil, err
	}
	model := issuedependency.Model{Issues: make(map[string]issuedependency.Issue, len(nodes)), Edges: make([]issuedependency.Edge, 0, len(edges))}
	resolver := issuestatus.NewResolver(ws)
	for _, n := range nodes {
		id := util.UUIDToString(n.ID)
		model.Issues[id] = issuedependency.Issue{ID: id, ParentID: util.UUIDToString(n.ParentIssueID), Status: n.Status, Category: resolver.Effective(ctx, q, n.Status), Revision: n.Revision, Title: n.Title, Number: n.Number}
	}
	for _, e := range edges {
		model.Edges = append(model.Edges, issuedependency.Edge{ID: util.UUIDToString(e.ID), IssueID: util.UUIDToString(e.IssueID), DependsOnID: util.UUIDToString(e.DependsOnIssueID), Type: e.Type})
	}
	return &DependencySnapshot{WorkspaceID: ws, Model: model, Catalog: catalog, service: s}, nil
}

func (s *DependencyService) Read(ctx context.Context, ws pgtype.UUID, issueID string) (*DependencySnapshot, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"); err != nil {
		return nil, err
	}
	snapshot, err := s.Load(ctx, s.Queries.WithTx(tx), ws)
	if err != nil {
		return nil, err
	}
	if _, ok := snapshot.Model.Issues[issueID]; !ok {
		return nil, dependencyError("not_found", "issue not found")
	}
	if err := snapshot.Model.Validate(); err != nil {
		return nil, dependencyError("dependency_data_unverified", "dependency data must be audited before use")
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func (s *DependencySnapshot) Version(id string) string {
	type catalogEntry struct {
		Key      string
		Category string
	}
	var catalog []catalogEntry
	for _, c := range s.Catalog {
		catalog = append(catalog, catalogEntry{c.Key, c.Category})
	}
	sort.Slice(catalog, func(i, j int) bool { return catalog[i].Key < catalog[j].Key })
	var ancestors, prerequisites []issuedependency.Issue
	for _, a := range s.Model.Ancestors(id) {
		ancestors = append(ancestors, s.Model.Issues[a])
	}
	ps := s.Model.Prerequisites(id)
	for _, p := range ps {
		prerequisites = append(prerequisites, s.Model.Issues[p.IssueID])
	}
	// JSON of these concrete structs cannot fail. HMAC keeps hidden endpoints
	// opaque; revisions invalidate stale edits even after a status changes back.
	payload, _ := json.Marshal(struct {
		Workspace     string
		Ancestors     []issuedependency.Issue
		Prerequisites []issuedependency.Issue
		Sources       []issuedependency.Prerequisite
		Catalog       []catalogEntry
	}{util.UUIDToString(s.WorkspaceID), ancestors, prerequisites, ps, catalog})
	mac := hmac.New(sha256.New, s.service.SigningKey)
	mac.Write([]byte("issue-dependency-v1\x00"))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

type DependencyView struct {
	BlockedBy             []issuedependency.Prerequisite `json:"blocked_by"`
	InheritedBlockedBy    []issuedependency.Prerequisite `json:"inherited_blocked_by"`
	Blocking              []issuedependency.Prerequisite `json:"blocking"`
	Unsatisfied           []issuedependency.Prerequisite `json:"unsatisfied"`
	HasRestrictedBlockers bool                           `json:"has_restricted_blockers"`
	DependencyVersion     string                         `json:"dependency_version"`
}

// View projects the full server decision through the caller's access policy.
// Hidden source paths and their edge IDs are not disclosed. Today's issue
// policy is workspace membership; this callback keeps graph consumers honest
// if narrower issue visibility is introduced later.
func (s *DependencySnapshot) View(id string, visible func(string) bool) DependencyView {
	v := DependencyView{BlockedBy: []issuedependency.Prerequisite{}, InheritedBlockedBy: []issuedependency.Prerequisite{}, Blocking: []issuedependency.Prerequisite{}, Unsatisfied: []issuedependency.Prerequisite{}, DependencyVersion: s.Version(id)}
	direct := map[string]bool{}
	for _, e := range s.Model.Edges {
		if e.Type == "blocked_by" && e.IssueID == id {
			direct[e.DependsOnID] = true
		}
	}
	for _, p := range s.Model.Prerequisites(id) {
		allowed := visible(p.IssueID)
		for _, a := range p.InheritedFrom {
			allowed = allowed && visible(a)
		}
		if !allowed {
			v.HasRestrictedBlockers = v.HasRestrictedBlockers || !p.Satisfied
			continue
		}
		if direct[p.IssueID] {
			v.BlockedBy = append(v.BlockedBy, p)
		} else {
			v.InheritedBlockedBy = append(v.InheritedBlockedBy, p)
		}
		if !p.Satisfied {
			v.Unsatisfied = append(v.Unsatisfied, p)
		}
	}
	descendantCounts := s.Model.DescendantCounts(visible)
	for _, e := range s.Model.Edges {
		if e.Type != "blocked_by" || e.DependsOnID != id || !visible(e.IssueID) {
			continue
		}
		n := s.Model.Issues[e.IssueID]
		p := issuedependency.Prerequisite{IssueID: n.ID, Status: n.Status, StatusCategory: n.Category, Satisfied: n.Category == "done", SourceEdges: []string{e.ID}, InheritedFrom: []string{}, Title: n.Title}
		p.DescendantCount = descendantCounts[n.ID]
		v.Blocking = append(v.Blocking, p)
	}
	sort.Slice(v.Blocking, func(i, j int) bool { return v.Blocking[i].IssueID < v.Blocking[j].IssueID })
	return v
}

func isDependencyHuman(ctx context.Context) bool {
	i, ok := auth.IdentityFromContext(ctx)
	return ok && i.CredentialKind == "jwt" && i.AgentID == "" && i.TaskID == ""
}

type DependencyWrite struct {
	BlockedBy       *[]pgtype.UUID
	ExpectedVersion string
	Creating        bool
	SuppressRun     bool
	IncludeView     bool
}

// Apply validates and persists relations against the proposed final issue row.
// The issue row may already have been written through q; every error must make
// the caller roll back its transaction. It never emits events or invokes a runtime.
func (s *DependencyService) Apply(ctx context.Context, q *db.Queries, before *DependencySnapshot, issue db.Issue, write DependencyWrite) (*DependencySnapshot, bool, error) {
	id := util.UUIDToString(issue.ID)
	if issue.WorkspaceID != before.WorkspaceID {
		return nil, false, dependencyError("not_found", "issue not found")
	}
	if _, exists := before.Model.Issues[id]; !exists && !write.Creating {
		return nil, false, dependencyError("not_found", "issue not found")
	}
	old := before.Model.Issues[id]
	structureChanged := write.Creating || write.BlockedBy != nil || old.ParentID != util.UUIDToString(issue.ParentIssueID)
	if write.BlockedBy != nil && !s.WritesEnabled {
		return nil, false, dependencyError("not_found", "dependency writes are not enabled")
	}
	if write.ExpectedVersion != "" && (write.Creating || !hmac.Equal([]byte(write.ExpectedVersion), []byte(before.Version(id)))) {
		return nil, false, dependencyError("dependency_version_conflict", "dependencies changed; refresh before editing")
	}
	next := *before
	next.Model = before.Model.Clone()
	next.Model.Issues[id] = issuedependency.Issue{ID: id, ParentID: util.UUIDToString(issue.ParentIssueID), Status: issue.Status, Category: issuestatus.Effective(ctx, q, issue.WorkspaceID, issue.Status), Revision: issue.Revision, Title: issue.Title, Number: issue.Number}
	if parent := next.Model.Issues[id].ParentID; parent != "" {
		if _, ok := next.Model.Issues[parent]; !ok {
			return nil, false, dependencyError("not_found", "parent issue not found")
		}
	}
	if write.BlockedBy != nil {
		retained := map[string]bool{}
		for _, uuid := range *write.BlockedBy {
			p := util.UUIDToString(uuid)
			if _, ok := next.Model.Issues[p]; !ok {
				return nil, false, dependencyError("not_found", "prerequisite not found")
			}
			retained[p] = true
		}
		kept := make([]issuedependency.Edge, 0, len(next.Model.Edges)+len(retained))
		for _, e := range next.Model.Edges {
			if e.Type != "blocked_by" || e.IssueID != id {
				kept = append(kept, e)
				continue
			}
			if retained[e.DependsOnID] {
				kept = append(kept, e)
				delete(retained, e.DependsOnID)
			}
		}
		keys := make([]string, 0, len(retained))
		for p := range retained {
			keys = append(keys, p)
		}
		sort.Strings(keys)
		for _, p := range keys {
			kept = append(kept, issuedependency.Edge{ID: util.UUIDToString(dbid.NewV7()), IssueID: id, DependsOnID: p, Type: "blocked_by"})
		}
		next.Model.Edges = kept
	}
	if structureChanged || write.IncludeView {
		if err := before.Model.Validate(); err != nil {
			return nil, false, dependencyError("dependency_data_unverified", "dependency data must be audited before use")
		}
		if err := next.Model.Validate(); err != nil {
			var violation *issuedependency.Violation
			if errors.As(err, &violation) {
				return nil, false, &DependencyError{Code: violation.Code, Message: "the proposed dependency structure is invalid", Violation: violation}
			}
			return nil, false, err
		}
	}
	if structureChanged && !isDependencyHuman(ctx) && before.Model.Weakened(next.Model) {
		return nil, false, dependencyError("dependency_change_not_allowed", "only an authenticated human can remove unfinished constraints")
	}
	changed := relationState(before.Model, id) != relationState(next.Model, id)
	if changed {
		retained := []pgtype.UUID{}
		for _, e := range next.Model.Edges {
			if e.Type != "blocked_by" || e.IssueID != id {
				continue
			}
			p, err := util.ParseUUID(e.DependsOnID)
			if err != nil {
				return nil, false, err
			}
			retained = append(retained, p)
		}
		if err := q.DeleteDirectIssueDependencies(ctx, db.DeleteDirectIssueDependenciesParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, RetainedIds: retained}); err != nil {
			return nil, false, err
		}
		for _, e := range next.Model.Edges {
			if e.Type != "blocked_by" || e.IssueID != id {
				continue
			}
			edgeID, err := util.ParseUUID(e.ID)
			if err != nil {
				return nil, false, err
			}
			p, err := util.ParseUUID(e.DependsOnID)
			if err != nil {
				return nil, false, err
			}
			if err := q.InsertIssueDependency(ctx, db.InsertIssueDependencyParams{ID: edgeID, WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, DependsOnIssueID: p}); err != nil {
				return nil, false, err
			}
		}
		if err := s.audit(ctx, q, issue.WorkspaceID, issue.ID, "write", relationState(before.Model, id), relationState(next.Model, id)); err != nil {
			return nil, false, err
		}
	}
	return &next, changed, nil
}

// CheckWriteAdmission is the pre-mutation decision reused by create/update.
// Actual queue insertion/claim and explicit human overrides belong to OL-41;
// until that integration exists, execution-bearing dependency writes fail closed.
func (s *DependencySnapshot) CheckWriteAdmission(ctx context.Context, issue db.Issue, assignedChanged, runIntent bool) error {
	if !assignedChanged && !runIntent {
		return nil
	}
	if err := s.Model.Validate(); err != nil {
		return dependencyError("dependency_data_unverified", "dependency data must be audited before execution")
	}
	id := util.UUIDToString(issue.ID)
	ps := s.Model.Prerequisites(id)
	if len(ps) == 0 {
		return nil
	}
	for _, p := range ps {
		if !p.Satisfied && ((!isDependencyHuman(ctx) && assignedChanged) || runIntent) {
			v := s.View(id, func(string) bool { return true })
			return &DependencyError{Code: "dependency_unsatisfied", Message: "prerequisites are unfinished; propose a plan or request human help", View: &v}
		}
	}
	if runIntent {
		return dependencyError("dependency_dispatch_unavailable", "dependency execution admission is not enabled yet")
	}
	return nil
}

// DependencyWriteIntent is conservative before runtime availability checks:
// offline runtimes and suppress_run cannot legitimize a new machine assignment.
func DependencyWriteIntent(ctx context.Context, q *db.Queries, previous *db.Issue, next db.Issue, suppress bool) (bool, bool) {
	machine := next.AssigneeID.Valid && (next.AssigneeType.String == "agent" || next.AssigneeType.String == "squad")
	assigned := machine && (previous == nil || previous.AssigneeID != next.AssigneeID || previous.AssigneeType != next.AssigneeType)
	category := issuestatus.Effective(ctx, q, next.WorkspaceID, next.Status)
	run := machine && !suppress && (assigned || previous == nil || previous.Status != next.Status) && category != "backlog" && category != "done" && category != "cancelled"
	return assigned, run
}

func relationState(m issuedependency.Model, id string) string {
	var edges []issuedependency.Edge
	for _, e := range m.Edges {
		if e.IssueID == id || e.DependsOnID == id {
			edges = append(edges, e)
		}
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].ID < edges[j].ID })
	b, _ := json.Marshal(struct {
		Parent string                 `json:"parent_issue_id"`
		Edges  []issuedependency.Edge `json:"edges"`
	}{m.Issues[id].ParentID, edges})
	return string(b)
}

func (s *DependencyService) audit(ctx context.Context, q *db.Queries, ws, id pgtype.UUID, action, before, after string) error {
	identity, _ := auth.IdentityFromContext(ctx)
	var actor pgtype.UUID
	actorID := identity.UserID
	if identity.AgentID != "" {
		actorID = identity.AgentID
	}
	if actorID != "" {
		var err error
		actor, err = util.ParseUUID(actorID)
		if err != nil {
			return err
		}
	}
	return q.RecordIssueDependencyAudit(ctx, db.RecordIssueDependencyAuditParams{ID: dbid.NewV7(), WorkspaceID: ws, IssueID: id, ActorID: actor, CredentialKind: identity.CredentialKind, Action: action, BeforeState: []byte(before), AfterState: []byte(after)})
}

func (s *DependencyService) Delete(ctx context.Context, q *db.Queries, before *DependencySnapshot, ids []pgtype.UUID) error {
	next := before.Model.Clone()
	deleted := map[string]bool{}
	for _, id := range ids {
		key := util.UUIDToString(id)
		if _, exists := before.Model.Issues[key]; !exists {
			return dependencyError("not_found", "issue not found")
		}
		deleted[key] = true
		delete(next.Issues, key)
	}
	for id, n := range next.Issues {
		if deleted[n.ParentID] {
			n.ParentID = ""
			next.Issues[id] = n
		}
	}
	kept := next.Edges[:0]
	for _, e := range next.Edges {
		if !deleted[e.IssueID] && !deleted[e.DependsOnID] {
			kept = append(kept, e)
		}
	}
	next.Edges = kept
	if err := before.Model.Validate(); err != nil {
		return dependencyError("dependency_data_unverified", "dependency data must be audited before deletion")
	}
	if !isDependencyHuman(ctx) && before.Model.Weakened(next) {
		return dependencyError("dependency_change_not_allowed", "only an authenticated human can remove unfinished constraints")
	}
	for _, id := range next.IDs() {
		if before.Model.Issues[id].ParentID == next.Issues[id].ParentID {
			continue
		}
		childID, err := util.ParseUUID(id)
		if err != nil {
			return err
		}
		if err := s.audit(ctx, q, before.WorkspaceID, childID, "detach_on_delete", relationState(before.Model, id), relationState(next, id)); err != nil {
			return fmt.Errorf("audit dependency detachment: %w", err)
		}
	}
	for _, id := range ids {
		key := util.UUIDToString(id)
		if err := s.audit(ctx, q, before.WorkspaceID, id, "delete", relationState(before.Model, key), relationState(next, key)); err != nil {
			return fmt.Errorf("audit dependency deletion: %w", err)
		}
	}
	return q.DeleteIssueDependencies(ctx, db.DeleteIssueDependenciesParams{WorkspaceID: before.WorkspaceID, IssueIds: ids})
}
