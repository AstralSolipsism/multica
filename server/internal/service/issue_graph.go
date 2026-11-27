package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type IssueGraphScope struct {
	Type      string  `json:"type"`
	ProjectID *string `json:"project_id"`
}

type IssueGraphAssignee struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type IssueGraphRuns struct {
	Queued                int64     `json:"queued"`
	Dispatched            int64     `json:"dispatched"`
	Running               int64     `json:"running"`
	WaitingLocalDirectory int64     `json:"waiting_local_directory"`
	CapturedAt            time.Time `json:"captured_at"`
}

type IssueGraphDependencySummary struct {
	VisibleUnsatisfiedCount int    `json:"visible_unsatisfied_count"`
	HasRestrictedBlockers   bool   `json:"has_restricted_blockers"`
	DependencyVersion       string `json:"dependency_version"`
}

type IssueGraphNode struct {
	ID                  string                      `json:"id"`
	Identifier          string                      `json:"identifier"`
	Title               string                      `json:"title"`
	Status              string                      `json:"status"`
	StatusCategory      string                      `json:"status_category"`
	Revision            int64                       `json:"revision"`
	ParentIssueID       *string                     `json:"parent_issue_id"`
	HasRestrictedParent bool                        `json:"has_restricted_parent"`
	ProjectID           *string                     `json:"project_id"`
	Stage               *int32                      `json:"stage"`
	Priority            string                      `json:"priority"`
	Assignee            *IssueGraphAssignee         `json:"assignee"`
	Role                string                      `json:"role"`
	RunSummary          IssueGraphRuns              `json:"run_summary"`
	DependencySummary   IssueGraphDependencySummary `json:"dependency_summary"`
}

// SourceEdgeID names the effective blocker: "manual:<issue>:<blocker>" for a
// stored issue_blocker row, "stage:<issue>:<blocker>" for same-parent stage
// order. Native blockers do not inherit across parent-child hierarchies.
type IssueGraphEdge struct {
	SourceEdgeID string `json:"source_edge_id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	Type         string `json:"type"`
}

type IssueGraphProject struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type IssueGraph struct {
	SchemaVersion        int                 `json:"schema_version"`
	SnapshotID           string              `json:"snapshot_id"`
	TopologyID           string              `json:"topology_id"`
	CapturedAt           time.Time           `json:"captured_at"`
	Complete             bool                `json:"complete"`
	Scope                IssueGraphScope     `json:"scope"`
	FocusIssueID         *string             `json:"focus_issue_id"`
	MatchedCount         int                 `json:"matched_count"`
	ContextCount         int                 `json:"context_count"`
	Nodes                []IssueGraphNode    `json:"nodes"`
	Edges                []IssueGraphEdge    `json:"edges"`
	Projects             []IssueGraphProject `json:"projects"`
	HasRestrictedContext bool                `json:"has_restricted_context"`
}

// IssueGraphError refuses a graph read by stable code: not_found answers like
// a missing object, dependency_data_unverified means the stored graph is not
// consistent enough to be shown as complete.
type IssueGraphError struct {
	Code    string
	Message string
}

func (e *IssueGraphError) Error() string { return e.Message }

type IssueGraphIssue struct {
	Title     string
	Status    string
	Category  string
	Number    int32
	Revision  int64
	ParentID  string
	ProjectID pgtype.UUID
}

type IssueGraphBlocker struct {
	ID        string
	IssueID   string
	BlockerID string
}

// IssueGraphModel is one snapshot of the rows a graph is built from: every
// issue of the workspace and its effective blockers, sorted by edge ID.
type IssueGraphModel struct {
	Workspace string
	Issues    map[string]IssueGraphIssue
	Blockers  []IssueGraphBlocker
}

// LoadIssueGraph reads the graph inputs on the caller's transaction, so one
// MVCC snapshot answers the whole request. No list pagination is involved.
func LoadIssueGraph(ctx context.Context, q *db.Queries, ws pgtype.UUID) (IssueGraphModel, error) {
	rows, err := q.ListIssueGraphIssues(ctx, ws)
	if err != nil {
		return IssueGraphModel{}, err
	}
	blockers, err := q.ListIssueGraphBlockers(ctx, ws)
	if err != nil {
		return IssueGraphModel{}, err
	}
	resolver := issuestatus.NewResolver(ws)
	model := IssueGraphModel{Workspace: util.UUIDToString(ws), Issues: make(map[string]IssueGraphIssue, len(rows))}
	// Reuse endpoint strings across dense edges instead of allocating two new
	// UUID strings per edge. Missing/foreign endpoints still retain their IDs.
	ids := make(map[pgtype.UUID]string, len(rows))
	for _, row := range rows {
		id := util.UUIDToString(row.ID)
		ids[row.ID] = id
		model.Issues[id] = IssueGraphIssue{
			Title: row.Title, Status: row.Status, Number: row.Number, Revision: row.Revision,
			ParentID:  util.UUIDToString(row.ParentIssueID),
			ProjectID: row.ProjectID,
			Category:  issuestatus.WireCategory(row.Status, resolver.Category(ctx, q, row.Status)),
		}
	}
	if err := resolver.Err(); err != nil {
		return IssueGraphModel{}, err
	}
	endpoint := func(id pgtype.UUID) string {
		if str, ok := ids[id]; ok {
			return str
		}
		return util.UUIDToString(id)
	}
	model.Blockers = make([]IssueGraphBlocker, 0, len(blockers.IssueIds))
	for i := range blockers.IssueIds {
		issueID, blockerID := endpoint(blockers.IssueIds[i]), endpoint(blockers.BlockerIssueIds[i])
		model.Blockers = append(model.Blockers, IssueGraphBlocker{ID: blockers.Vias[i] + ":" + issueID + ":" + blockerID, IssueID: issueID, BlockerID: blockerID})
	}
	// Keep traversal deterministic without sorting full SQL rows, which can
	// spill to temporary files at the default work_mem.
	slices.SortFunc(model.Blockers, func(a, b IssueGraphBlocker) int { return strings.Compare(a.ID, b.ID) })
	return model, nil
}

func (m IssueGraphModel) closed(id string) bool {
	return m.Issues[id].Category == issuestatus.Done || m.Issues[id].Category == issuestatus.Cancelled
}

// Graph projects the snapshot through the caller's access policy. The closure
// walks ancestors and recursive blockers, including hidden paths; only visible
// endpoints and source IDs enter the response.
func (m IssueGraphModel) Graph(nodes []IssueGraphNode, projects []IssueGraphProject, matched map[string]bool, scope IssueGraphScope, focus *string, captured time.Time, visible func(string) bool) (*IssueGraph, error) {
	// A blocker endpoint outside the workspace's issues cannot be placed, so
	// nothing may be shown as complete.
	for _, b := range m.Blockers {
		if _, ok := m.Issues[b.IssueID]; !ok {
			return nil, &IssueGraphError{Code: "dependency_data_unverified", Message: "blocker endpoints must belong to the workspace"}
		}
		if _, ok := m.Issues[b.BlockerID]; !ok {
			return nil, &IssueGraphError{Code: "dependency_data_unverified", Message: "blocker endpoints must belong to the workspace"}
		}
	}
	g := &IssueGraph{SchemaVersion: 1, Scope: scope, FocusIssueID: focus, Nodes: []IssueGraphNode{}, Edges: []IssueGraphEdge{}, Projects: []IssueGraphProject{}}
	parents := make(map[string][]string)
	for id, n := range m.Issues {
		if n.ParentID != "" {
			parents[id] = append(parents[id], n.ParentID)
		}
	}
	blockers := make(map[string][]string)
	for _, b := range m.Blockers {
		parents[b.IssueID] = append(parents[b.IssueID], b.BlockerID)
		blockers[b.IssueID] = append(blockers[b.IssueID], b.BlockerID)
	}
	selected := make(map[string]bool)
	var queue []string
	add := func(id string) {
		if !selected[id] {
			selected[id] = true
			queue = append(queue, id)
		}
	}
	for id := range matched {
		if _, exists := m.Issues[id]; !exists {
			return nil, &IssueGraphError{Code: "dependency_data_unverified", Message: "graph membership is inconsistent"}
		}
		if visible(id) {
			add(id)
		}
	}
	if focus != nil {
		if _, exists := m.Issues[*focus]; !exists || !visible(*focus) {
			return nil, &IssueGraphError{Code: "not_found", Message: "issue not found"}
		}
		add(*focus)
	}
	// The queue grows while it is walked, so the bound is re-read each iteration.
	for i := 0; i < len(queue); i++ {
		for _, id := range parents[queue[i]] {
			add(id)
		}
	}
	for id := range selected {
		if !visible(id) {
			g.HasRestrictedContext = true
		}
	}
	public := make(map[string]bool)
	projectIDs := make(map[string]bool)
	for _, n := range nodes {
		if !selected[n.ID] || !visible(n.ID) {
			continue
		}
		if public[n.ID] {
			return nil, &IssueGraphError{Code: "dependency_data_unverified", Message: "duplicate graph node"}
		}
		public[n.ID] = true
		if n.ProjectID != nil {
			projectIDs[*n.ProjectID] = true
		}
		if n.ParentIssueID != nil && !visible(*n.ParentIssueID) {
			n.ParentIssueID = nil
			n.HasRestrictedParent = true
		}
		n.Role = "context"
		if matched[n.ID] {
			n.Role = "match"
			g.MatchedCount++
		} else {
			g.ContextCount++
		}
		for _, blockerID := range blockers[n.ID] {
			if !m.closed(blockerID) {
				if visible(blockerID) {
					n.DependencySummary.VisibleUnsatisfiedCount++
				} else {
					n.DependencySummary.HasRestrictedBlockers = true
				}
			}
		}
		n.DependencySummary.DependencyVersion = m.dependencyVersion(blockers[n.ID])
		g.Nodes = append(g.Nodes, n)
	}
	// Enforce closed references before advertising complete=true. Missing detail
	// data is an error, not an implicit page boundary or a silently dropped node.
	for id := range selected {
		if visible(id) && !public[id] {
			return nil, &IssueGraphError{Code: "dependency_data_unverified", Message: "graph details are incomplete"}
		}
	}
	for _, n := range g.Nodes {
		if n.ParentIssueID != nil && !public[*n.ParentIssueID] {
			return nil, &IssueGraphError{Code: "dependency_data_unverified", Message: "graph parent context is incomplete"}
		}
	}
	for _, b := range m.Blockers {
		if public[b.IssueID] && public[b.BlockerID] {
			g.Edges = append(g.Edges, IssueGraphEdge{SourceEdgeID: b.ID, Source: b.BlockerID, Target: b.IssueID, Type: "blocked_by"})
		}
	}
	for _, p := range projects {
		if projectIDs[p.ID] {
			g.Projects = append(g.Projects, p)
			delete(projectIDs, p.ID)
		}
	}
	if len(projectIDs) != 0 {
		return nil, &IssueGraphError{Code: "dependency_data_unverified", Message: "graph project context is incomplete"}
	}
	slices.SortFunc(g.Nodes, func(a, b IssueGraphNode) int { return strings.Compare(a.ID, b.ID) })
	slices.SortFunc(g.Projects, func(a, b IssueGraphProject) int { return strings.Compare(a.ID, b.ID) })
	// Content versions exclude collection time. The topology version also
	// excludes status, runs and labels so a content refresh need not relayout.
	type topologyNode struct {
		ID, Role        string
		Parent, Project *string
		Stage           *int32
	}
	topology := make([]topologyNode, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		topology = append(topology, topologyNode{n.ID, n.Role, n.ParentIssueID, n.ProjectID, n.Stage})
	}
	g.TopologyID = graphDigest("topology", struct {
		Nodes []topologyNode
		Edges []IssueGraphEdge
	}{topology, g.Edges})
	g.Complete = true
	g.SnapshotID = graphDigest("snapshot", g)
	g.CapturedAt = captured
	for i := range g.Nodes {
		g.Nodes[i].RunSummary.CapturedAt = captured
	}
	return g, nil
}

// dependencyVersion identifies a node's blocker set; ordinary edits do not
// change it. HMAC keeps hidden endpoints opaque.
func (m IssueGraphModel) dependencyVersion(blockers []string) string {
	payload, _ := json.Marshal(struct {
		Workspace string
		Blockers  []string
	}{m.Workspace, blockers})
	mac := hmac.New(sha256.New, auth.JWTSecret())
	mac.Write([]byte("issue-graph-blockers-v1\x00"))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

func graphDigest(kind string, value any) string {
	// These DTOs contain no custom marshalers or unsupported values.
	payload, _ := json.Marshal(value)
	mac := hmac.New(sha256.New, auth.JWTSecret())
	mac.Write([]byte("issue-graph-v1\x00" + kind + "\x00"))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}
