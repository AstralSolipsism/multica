package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"sort"
	"strings"

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
	Violation *issuedependency.Violation
}

func (e *DependencyError) Error() string { return e.Message }

func dependencyError(code, message string) *DependencyError {
	return &DependencyError{Code: code, Message: message}
}

// DependencyService owns graph validation and transaction-scoped relation writes.
// WritesEnabled controls compound relation edits; execution does not consult it.
type DependencyService struct {
	Queries       *db.Queries
	TxStarter     TxStarter
	SigningKey    []byte
	WritesEnabled bool
}

func NewDependencyService(q *db.Queries, tx TxStarter) *DependencyService {
	return &DependencyService{Queries: q, TxStarter: tx, SigningKey: auth.JWTSecret(), WritesEnabled: true}
}

type DependencySnapshot struct {
	WorkspaceID pgtype.UUID
	Model       issuedependency.Model
	Catalog     []db.IssueStatus
	service     *DependencyService
}

// LockWrite serializes structural relation writes; graph reads use MVCC.
// Workspace ownership -> catalog -> structure -> attachments (if any)
// -> affected issue rows. The catalog lock preserves the order for compound
// edits that also set a custom status. Create takes its counter lock first.
// Ordinary content/status writes do not need the structure lock.
func (s *DependencyService) LockWrite(ctx context.Context, q *db.Queries, ws pgtype.UUID) error {
	if _, err := q.LockWorkspaceForDependencyStructure(ctx, ws); err != nil {
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

// LoadForWrite follows LockWrite. The advisory lock protects structural inputs;
// informational status/title projections need no workspace-wide row locks.
func (s *DependencyService) LoadForWrite(ctx context.Context, q *db.Queries, ws pgtype.UUID) (*DependencySnapshot, error) {
	return s.Load(ctx, q, ws)
}

// Load uses the caller's transaction. For display, use a repeatable-read
// transaction; for writes, use LockWrite followed by LoadForWrite. No list
// pagination is involved.
func (s *DependencyService) Load(ctx context.Context, q *db.Queries, ws pgtype.UUID) (*DependencySnapshot, error) {
	snapshot, err := s.load(ctx, q, ws)
	if err != nil {
		return nil, err
	}
	// Keep read/edit traversal deterministic without sorting full SQL rows,
	// which can spill to temporary files at the default work_mem.
	slices.SortFunc(snapshot.Model.Edges, func(a, b issuedependency.Edge) int { return strings.Compare(a.ID, b.ID) })
	return snapshot, nil
}

// Graph validation does not depend on edge traversal order. Prerequisite projections,
// versions and audit states already sort their own output at the boundary.
func (s *DependencyService) load(ctx context.Context, q *db.Queries, ws pgtype.UUID) (*DependencySnapshot, error) {
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
	model := issuedependency.Model{Issues: make(map[string]issuedependency.Issue, len(nodes)), Edges: make([]issuedependency.Edge, 0, len(edges.Ids))}
	// Reuse endpoint strings across dense edges instead of allocating two new
	// UUID strings per edge. Missing/foreign endpoints still retain their IDs.
	ids := make(map[pgtype.UUID]string, len(nodes))
	resolver := issuestatus.NewResolver(ws)
	for _, n := range nodes {
		id := util.UUIDToString(n.ID)
		ids[n.ID] = id
		model.Issues[id] = issuedependency.Issue{ID: id, ParentID: util.UUIDToString(n.ParentIssueID), Status: n.Status, Category: issuestatus.WireCategory(n.Status, resolver.Category(ctx, q, n.Status)), Revision: n.Revision, Title: n.Title, Number: n.Number}
	}
	endpoint := func(id pgtype.UUID) string {
		if str, ok := ids[id]; ok {
			return str
		}
		return util.UUIDToString(id)
	}
	for i, id := range edges.Ids {
		model.Edges = append(model.Edges, issuedependency.Edge{ID: util.UUIDToString(id), IssueID: endpoint(edges.IssueIds[i]), DependsOnID: endpoint(edges.DependsOnIds[i]), Type: edges.Types[i]})
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
	return s.version(id, s.Model.Prerequisites(id))
}

func (s *DependencySnapshot) version(id string, ps []issuedependency.Prerequisite) string {
	type relationSource struct {
		IssueID       string
		SourceEdges   []string
		InheritedFrom []string
	}
	sources := make([]relationSource, 0, len(ps))
	for _, p := range ps {
		sources = append(sources, relationSource{p.IssueID, p.SourceEdges, p.InheritedFrom})
	}
	// Prerequisite projections sort their structural sources at the boundary.
	// Keep display fields and revisions out: ordinary edits do not change the
	// relations being replaced. HMAC keeps hidden endpoints and sources opaque.
	payload, _ := json.Marshal(struct {
		Workspace string
		Ancestors []string
		Sources   []relationSource
	}{util.UUIDToString(s.WorkspaceID), s.Model.Ancestors(id), sources})
	mac := hmac.New(sha256.New, s.service.SigningKey)
	mac.Write([]byte("issue-dependency-v2\x00"))
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

type DependencyWrite struct {
	BlockedBy       *[]pgtype.UUID
	ExpectedVersion string
	Creating        bool
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
	if write.BlockedBy != nil && !s.WritesEnabled {
		return nil, false, dependencyError("not_found", "dependency writes are not enabled")
	}
	if write.ExpectedVersion != "" && (write.Creating || !hmac.Equal([]byte(write.ExpectedVersion), []byte(before.Version(id)))) {
		return nil, false, dependencyError("dependency_version_conflict", "dependencies changed; refresh before editing")
	}
	proposed := issuedependency.Issue{ID: id, ParentID: util.UUIDToString(issue.ParentIssueID), Status: issue.Status, Category: issuestatus.WireCategory(issue.Status, issuestatus.NewResolver(issue.WorkspaceID).Category(ctx, q, issue.Status)), Revision: issue.Revision, Title: issue.Title, Number: issue.Number}
	change, err := planRelationChange(before.Model, proposed, replacementDependencyEdges(id, write.BlockedBy))
	if err != nil {
		return nil, false, err
	}
	if err := validationScopeFor(old, proposed, write).validate(before.Model, change.Next, id); err != nil {
		return nil, false, err
	}
	if err := s.persistRelationChange(ctx, q, issue, change); err != nil {
		return nil, false, err
	}
	next := *before
	next.Model = change.Next
	return &next, change.changed(), nil
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
