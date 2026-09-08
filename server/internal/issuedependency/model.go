// Package issuedependency models explicit prerequisites and inherited constraints.
// Parentage propagates prerequisites; it never makes a child wait for its parent.
package issuedependency

import (
	"fmt"
	"sort"
)

type Issue struct {
	ID       string `json:"id"`
	ParentID string `json:"parent_issue_id"`
	Status   string `json:"status"`
	Category string `json:"status_category"`
	Revision int64  `json:"revision"`
	Title    string `json:"-"`
	Number   int32  `json:"-"`
}

// Edge is always dependent -> prerequisite in storage. Related edges are inert.
type Edge struct {
	ID          string `json:"id"`
	IssueID     string `json:"issue_id"`
	DependsOnID string `json:"depends_on_issue_id"`
	Type        string `json:"type"`
}

type Model struct {
	Issues map[string]Issue
	Edges  []Edge
}

// Violation contains only original edge IDs and issue IDs, never algorithm nodes.
// Transport callers must project these through their resource access policy.
type Violation struct {
	Code     string   `json:"reason_code"`
	IssueIDs []string `json:"issue_ids,omitempty"`
	EdgeIDs  []string `json:"source_edges,omitempty"`
}

func (e *Violation) Error() string { return fmt.Sprintf("invalid dependency structure: %s", e.Code) }

func (m Model) Clone() Model {
	next := Model{Issues: make(map[string]Issue, len(m.Issues)), Edges: append([]Edge(nil), m.Edges...)}
	for id, issue := range m.Issues {
		next.Issues[id] = issue
	}
	return next
}

func (m Model) IDs() []string {
	ids := make([]string, 0, len(m.Issues))
	for id := range m.Issues {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Validate checks the proposed final structure regardless of completion status.
// g(v)->d(v), g(parent)->g(child), d(prerequisite)->g(dependent) is a linear
// representation of the fully inherited execution graph (OL-38 contract v2).
func (m Model) Validate() error {
	ids := m.IDs()
	index := make(map[string]int, len(ids))
	children := make(map[string][]string)
	for i, id := range ids {
		index[id] = i
	}
	for _, id := range ids {
		p := m.Issues[id].ParentID
		if p == "" {
			continue
		}
		if _, ok := m.Issues[p]; !ok {
			return &Violation{Code: "dependency_data_unverified", IssueIDs: []string{id}}
		}
		children[p] = append(children[p], id)
	}
	// DFS intervals make ancestor checks O(1), including arbitrarily deep trees.
	state, enter, leave := map[string]int{}, map[string]int{}, map[string]int{}
	clock := 0
	var visitTree func(string) error
	visitTree = func(id string) error {
		if state[id] == 1 {
			return &Violation{Code: "dependency_cycle", IssueIDs: []string{id}}
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		clock++
		enter[id] = clock
		for _, child := range children[id] {
			if err := visitTree(child); err != nil {
				return err
			}
		}
		clock++
		leave[id] = clock
		state[id] = 2
		return nil
	}
	for _, id := range ids {
		if m.Issues[id].ParentID == "" {
			if err := visitTree(id); err != nil {
				return err
			}
		}
	}
	for _, id := range ids {
		if err := visitTree(id); err != nil {
			return err
		}
	}
	ancestor := func(a, b string) bool { return enter[a] <= enter[b] && leave[b] <= leave[a] }
	type arc struct {
		to     int
		edgeID string
	}
	adj := make([][]arc, 2*len(ids))
	for _, id := range ids {
		i := index[id]
		adj[2*i] = append(adj[2*i], arc{to: 2*i + 1})
		if p := m.Issues[id].ParentID; p != "" {
			adj[2*index[p]] = append(adj[2*index[p]], arc{to: 2 * i})
		}
	}
	seen := make(map[[2]string]bool)
	for _, e := range m.Edges {
		_, aOK := m.Issues[e.DependsOnID]
		_, bOK := m.Issues[e.IssueID]
		if !aOK || !bOK {
			return &Violation{Code: "dependency_data_unverified", EdgeIDs: []string{e.ID}}
		}
		if e.Type == "related" {
			continue
		}
		if e.Type != "blocked_by" {
			return &Violation{Code: "dependency_data_unverified", EdgeIDs: []string{e.ID}}
		}
		key := [2]string{e.IssueID, e.DependsOnID}
		if seen[key] {
			return &Violation{Code: "dependency_data_unverified", EdgeIDs: []string{e.ID}}
		}
		seen[key] = true
		if ancestor(e.DependsOnID, e.IssueID) || ancestor(e.IssueID, e.DependsOnID) {
			return &Violation{Code: "dependency_ancestor_conflict", IssueIDs: []string{e.DependsOnID, e.IssueID}, EdgeIDs: []string{e.ID}}
		}
		adj[2*index[e.DependsOnID]+1] = append(adj[2*index[e.DependsOnID]+1], arc{to: 2 * index[e.IssueID], edgeID: e.ID})
	}
	colors := make([]int, len(adj))
	positions := make([]int, len(adj))
	var path []int
	var pathEdges []string
	var visit func(int) error
	visit = func(v int) error {
		colors[v] = 1
		positions[v] = len(path)
		path = append(path, v)
		for _, a := range adj[v] {
			if colors[a.to] == 1 {
				violation := &Violation{Code: "dependency_cycle"}
				for _, n := range path[positions[a.to]:] {
					violation.IssueIDs = append(violation.IssueIDs, ids[n/2])
				}
				for _, eid := range append(append([]string(nil), pathEdges[positions[a.to]:]...), a.edgeID) {
					if eid != "" {
						violation.EdgeIDs = append(violation.EdgeIDs, eid)
					}
				}
				violation.IssueIDs = unique(violation.IssueIDs)
				violation.EdgeIDs = unique(violation.EdgeIDs)
				return violation
			}
			if colors[a.to] == 0 {
				pathEdges = append(pathEdges, a.edgeID)
				if err := visit(a.to); err != nil {
					return err
				}
				pathEdges = pathEdges[:len(pathEdges)-1]
			}
		}
		path = path[:len(path)-1]
		colors[v] = 2
		return nil
	}
	for v := range adj {
		if colors[v] == 0 {
			if err := visit(v); err != nil {
				return err
			}
		}
	}
	return nil
}

type Prerequisite struct {
	IssueID         string   `json:"issue_id"`
	Status          string   `json:"status"`
	StatusCategory  string   `json:"status_category"`
	Satisfied       bool     `json:"satisfied"`
	SourceEdges     []string `json:"source_edges"`
	InheritedFrom   []string `json:"inherited_from"`
	Title           string   `json:"title,omitempty"`
	Identifier      string   `json:"identifier,omitempty"`
	DescendantCount int      `json:"descendant_count,omitempty"`
}

// Ancestors includes the target, in target-to-root order. Validate before use.
func (m Model) Ancestors(id string) []string {
	var out []string
	seen := map[string]bool{}
	for id != "" && !seen[id] {
		seen[id] = true
		out = append(out, id)
		id = m.Issues[id].ParentID
	}
	return out
}

// DescendantCounts counts only visible descendants, including those below an
// invisible parent. Validate first. Each tree node is visited once.
func (m Model) DescendantCounts(visible func(string) bool) map[string]int {
	children := map[string][]string{}
	for id, n := range m.Issues {
		children[n.ParentID] = append(children[n.ParentID], id)
	}
	counts := make(map[string]int, len(m.Issues))
	var visit func(string) int
	visit = func(id string) int {
		total := 0
		for _, child := range children[id] {
			total += visit(child)
			if visible(child) {
				total++
			}
		}
		counts[id] = total
		return total
	}
	for _, root := range children[""] {
		visit(root)
	}
	return counts
}

func (m Model) Prerequisites(id string) []Prerequisite {
	ancestors := map[string]bool{}
	for _, a := range m.Ancestors(id) {
		ancestors[a] = true
	}
	byID := map[string]*Prerequisite{}
	for _, e := range m.Edges {
		if e.Type != "blocked_by" || !ancestors[e.IssueID] {
			continue
		}
		p := byID[e.DependsOnID]
		if p == nil {
			n := m.Issues[e.DependsOnID]
			p = &Prerequisite{IssueID: n.ID, Status: n.Status, StatusCategory: n.Category, Satisfied: n.Category == "done", SourceEdges: []string{}, InheritedFrom: []string{}, Title: n.Title}
			byID[e.DependsOnID] = p
		}
		p.SourceEdges = append(p.SourceEdges, e.ID)
		if e.IssueID != id {
			p.InheritedFrom = append(p.InheritedFrom, e.IssueID)
		}
	}
	out := make([]Prerequisite, 0, len(byID))
	for _, p := range byID {
		p.SourceEdges = unique(p.SourceEdges)
		p.InheritedFrom = unique(p.InheritedFrom)
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].IssueID < out[j].IssueID })
	return out
}

// Weakened reports removal of an unfinished direct edge or loss of any
// inherited unfinished prerequisite on a surviving issue. Completion writes
// themselves remain governed by the existing status policy.
func (m Model) Weakened(next Model) bool {
	remaining := map[[2]string]bool{}
	for _, e := range next.Edges {
		if e.Type == "blocked_by" {
			remaining[[2]string{e.IssueID, e.DependsOnID}] = true
		}
	}
	for _, e := range m.Edges {
		if _, survives := next.Issues[e.IssueID]; !survives {
			continue
		}
		if e.Type == "blocked_by" && m.Issues[e.DependsOnID].Category != "done" && !remaining[[2]string{e.IssueID, e.DependsOnID}] {
			return true
		}
	}
	for id, node := range next.Issues {
		old, existed := m.Issues[id]
		if !existed || old.ParentID == node.ParentID {
			continue
		}
		// Only a moved subtree root can lose inherited constraints. If it
		// retains every prerequisite, so do all its unchanged descendants.
		retained := map[string]bool{}
		for _, p := range next.Prerequisites(id) {
			retained[p.IssueID] = true
		}
		for _, p := range m.Prerequisites(id) {
			if !p.Satisfied && !retained[p.IssueID] {
				return true
			}
		}
	}
	return false
}

func unique(values []string) []string {
	sort.Strings(values)
	out := values[:0]
	for _, v := range values {
		if len(out) == 0 || out[len(out)-1] != v {
			out = append(out, v)
		}
	}
	return out
}
