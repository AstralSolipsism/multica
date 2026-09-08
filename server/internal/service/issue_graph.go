package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
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

// SourceEdgeID is the real stored relation. Inheritance is represented by the
// target's parent chain, never by materializing every descendant execution edge.
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

// Graph projects a validated workspace snapshot through the issue access policy.
// Closure walks ancestors and recursive prerequisites, including hidden paths;
// only visible endpoints and source IDs enter the response. Today's handler
// policy is workspace membership, exactly as on ordinary issue reads.
func (s *DependencySnapshot) Graph(nodes []IssueGraphNode, projects []IssueGraphProject, matched map[string]bool, scope IssueGraphScope, focus *string, captured time.Time, visible func(string) bool) (*IssueGraph, error) {
	if err := s.Model.Validate(); err != nil {
		return nil, dependencyError("dependency_data_unverified", "dependency data must be audited before use")
	}
	g := &IssueGraph{SchemaVersion: 1, Scope: scope, FocusIssueID: focus, Nodes: []IssueGraphNode{}, Edges: []IssueGraphEdge{}, Projects: []IssueGraphProject{}}
	parents := make(map[string][]string)
	for id, n := range s.Model.Issues {
		if n.ParentID != "" {
			parents[id] = append(parents[id], n.ParentID)
		}
	}
	for _, e := range s.Model.Edges {
		if e.Type == "blocked_by" {
			parents[e.IssueID] = append(parents[e.IssueID], e.DependsOnID)
		}
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
		if _, exists := s.Model.Issues[id]; !exists {
			return nil, dependencyError("dependency_data_unverified", "graph membership is inconsistent")
		}
		if visible(id) {
			add(id)
		}
	}
	if focus != nil {
		if _, exists := s.Model.Issues[*focus]; !exists || !visible(*focus) {
			return nil, dependencyError("not_found", "issue not found")
		}
		add(*focus)
	}
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
	prerequisites := s.Model.IndexedPrerequisites()
	for _, n := range nodes {
		if !selected[n.ID] || !visible(n.ID) {
			continue
		}
		if public[n.ID] {
			return nil, dependencyError("dependency_data_unverified", "duplicate graph node")
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
		ps := prerequisites(n.ID)
		n.DependencySummary.DependencyVersion = s.version(n.ID, ps)
		for _, p := range ps {
			allowed := visible(p.IssueID)
			for _, id := range p.InheritedFrom {
				allowed = allowed && visible(id)
			}
			if !p.Satisfied {
				if allowed {
					n.DependencySummary.VisibleUnsatisfiedCount++
				} else {
					n.DependencySummary.HasRestrictedBlockers = true
				}
			}
		}
		g.Nodes = append(g.Nodes, n)
	}
	// Enforce closed references before advertising complete=true. Missing detail
	// data is an error, not an implicit page boundary or a silently dropped node.
	for id := range selected {
		if visible(id) && !public[id] {
			return nil, dependencyError("dependency_data_unverified", "graph details are incomplete")
		}
	}
	for _, n := range g.Nodes {
		if n.ParentIssueID != nil && !public[*n.ParentIssueID] {
			return nil, dependencyError("dependency_data_unverified", "graph parent context is incomplete")
		}
	}
	for _, e := range s.Model.Edges {
		if e.Type == "blocked_by" && public[e.DependsOnID] && public[e.IssueID] {
			g.Edges = append(g.Edges, IssueGraphEdge{SourceEdgeID: e.ID, Source: e.DependsOnID, Target: e.IssueID, Type: "blocked_by"})
		}
	}
	for _, p := range projects {
		if projectIDs[p.ID] {
			g.Projects = append(g.Projects, p)
			delete(projectIDs, p.ID)
		}
	}
	if len(projectIDs) != 0 {
		return nil, dependencyError("dependency_data_unverified", "graph project context is incomplete")
	}
	sort.Slice(g.Nodes, func(i, j int) bool { return g.Nodes[i].ID < g.Nodes[j].ID })
	sort.Slice(g.Edges, func(i, j int) bool { return g.Edges[i].SourceEdgeID < g.Edges[j].SourceEdgeID })
	sort.Slice(g.Projects, func(i, j int) bool { return g.Projects[i].ID < g.Projects[j].ID })
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
	g.TopologyID = s.graphDigest("topology", struct {
		Nodes []topologyNode
		Edges []IssueGraphEdge
	}{topology, g.Edges})
	g.Complete = true
	g.SnapshotID = s.graphDigest("snapshot", g)
	g.CapturedAt = captured
	for i := range g.Nodes {
		g.Nodes[i].RunSummary.CapturedAt = captured
	}
	return g, nil
}

func (s *DependencySnapshot) graphDigest(kind string, value any) string {
	// These DTOs contain no custom marshalers or unsupported values.
	payload, _ := json.Marshal(value)
	mac := hmac.New(sha256.New, s.service.SigningKey)
	mac.Write([]byte("issue-graph-v1\x00" + kind + "\x00"))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}
