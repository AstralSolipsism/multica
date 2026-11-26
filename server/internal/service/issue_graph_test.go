package service

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestIssueGraphRestrictedClosure(t *testing.T) {
	parent := "hidden-parent"
	upstream := "visible-upstream"
	m := IssueGraphModel{Workspace: "ws", Issues: map[string]IssueGraphIssue{
		"target": {ParentID: parent},
		parent:   {},
		"secret": {Title: "private title", Category: "todo"},
		upstream: {Category: "done"},
	}, Blockers: []IssueGraphBlocker{
		{ID: "manual:secret:visible-upstream", IssueID: "secret", BlockerID: upstream},
		{ID: "manual:target:secret", IssueID: "target", BlockerID: "secret"},
	}}
	nodes := []IssueGraphNode{{ID: "target", ParentIssueID: &parent}, {ID: parent}, {ID: "secret", Title: "private title"}, {ID: upstream}}
	visible := func(id string) bool { return id == "target" || id == upstream }
	g, err := m.Graph(nodes, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Complete || !g.HasRestrictedContext || g.MatchedCount != 1 || g.ContextCount != 1 || len(g.Edges) != 0 {
		t.Fatalf("bad restricted closure: %+v", g)
	}
	for _, n := range g.Nodes {
		if n.ID == "target" && (!n.HasRestrictedParent || n.ParentIssueID != nil || !n.DependencySummary.HasRestrictedBlockers || n.DependencySummary.VisibleUnsatisfiedCount != 0) {
			t.Fatal("hidden blockers were omitted or counted publicly")
		}
	}
	data, _ := json.Marshal(g)
	for _, hidden := range []string{parent, "secret", "manual:target:secret", "manual:secret:visible-upstream", "private title"} {
		if strings.Contains(string(data), hidden) {
			t.Fatalf("leaked %q", hidden)
		}
	}
	n := m.Issues["secret"]
	n.Category, n.Status = "done", "done"
	n.Revision++
	m.Issues["secret"] = n
	ready, err := m.Graph(nodes, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if ready.SnapshotID == g.SnapshotID || ready.TopologyID != g.TopologyID || !ready.HasRestrictedContext {
		t.Fatal("hidden state change did not preserve topology and opaque versioning")
	}
	for _, n := range ready.Nodes {
		if n.DependencySummary.HasRestrictedBlockers {
			t.Fatal("a completed hidden prerequisite still blocks")
		}
	}
}

// Blockers are the effective_issue_blocker rows: a stored issue_blocker edge
// and the same-parent stage order count alike, and only closed blockers are
// satisfied.
func TestIssueGraphCountsOpenBlockersIncludingStages(t *testing.T) {
	m := IssueGraphModel{Workspace: "ws", Issues: map[string]IssueGraphIssue{
		"parent":  {},
		"target":  {ParentID: "parent"},
		"stage-1": {ParentID: "parent", Category: "todo"},
		"open":    {Category: "custom_in_progress"},
		"done":    {Category: "done"},
	}, Blockers: []IssueGraphBlocker{
		{ID: "manual:target:done", IssueID: "target", BlockerID: "done"},
		{ID: "manual:target:open", IssueID: "target", BlockerID: "open"},
		{ID: "stage:target:stage-1", IssueID: "target", BlockerID: "stage-1"},
	}}
	visible := func(string) bool { return true }
	nodes := []IssueGraphNode{{ID: "target", ParentIssueID: new("parent")}, {ID: "parent"}, {ID: "stage-1"}, {ID: "open"}, {ID: "done"}}
	g, err := m.Graph(nodes, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if g.MatchedCount != 1 || g.ContextCount != 4 || len(g.Edges) != 3 || g.Edges[2] != (IssueGraphEdge{SourceEdgeID: "stage:target:stage-1", Source: "stage-1", Target: "target", Type: "blocked_by"}) {
		t.Fatalf("effective blockers were not projected: %+v", g)
	}
	target := g.Nodes[len(g.Nodes)-1]
	if target.ID != "target" || target.DependencySummary.VisibleUnsatisfiedCount != 2 || target.DependencySummary.HasRestrictedBlockers || target.DependencySummary.DependencyVersion == "" {
		t.Fatalf("open blockers were not counted: %+v", target.DependencySummary)
	}
	m.Issues["open"] = IssueGraphIssue{Category: "cancelled"}
	closed, err := m.Graph(nodes, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if got := closed.Nodes[len(closed.Nodes)-1].DependencySummary; got.VisibleUnsatisfiedCount != 1 || got.DependencyVersion != target.DependencySummary.DependencyVersion {
		t.Fatalf("a closed blocker still blocks or changed the relation version: %+v", got)
	}
	m.Blockers = append(m.Blockers, IssueGraphBlocker{ID: "manual:target:open2", IssueID: "target", BlockerID: "open"})
	added, err := m.Graph(nodes, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if got := added.Nodes[len(added.Nodes)-1].DependencySummary; got.DependencyVersion == target.DependencySummary.DependencyVersion {
		t.Fatal("a new blocker kept the relation version")
	}
}

func TestIssueGraphRefusesUnknownBlockerEndpoints(t *testing.T) {
	m := IssueGraphModel{Workspace: "ws", Issues: map[string]IssueGraphIssue{"target": {}}, Blockers: []IssueGraphBlocker{
		{ID: "manual:target:elsewhere", IssueID: "target", BlockerID: "another-workspace"},
	}}
	_, err := m.Graph([]IssueGraphNode{{ID: "target"}}, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), func(string) bool { return true })
	var refusal *IssueGraphError
	if !errors.As(err, &refusal) || refusal.Code != "dependency_data_unverified" {
		t.Fatalf("foreign blocker endpoint was not refused: %v", err)
	}
}
