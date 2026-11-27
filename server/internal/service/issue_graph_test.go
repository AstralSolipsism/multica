package service

import (
	"encoding/json"
	"errors"
	"reflect"
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

// Weak edges are an induced subgraph of the public nodes: an edge with a
// hidden or unknown endpoint is dropped without widening the closure, counting
// as a blocker or reporting restricted context.
func TestIssueGraphWeakEdgesJoinPublicNodesOnly(t *testing.T) {
	m := IssueGraphModel{Workspace: "ws", Issues: map[string]IssueGraphIssue{"a": {}, "b": {}, "secret": {}}, WeakEdges: []IssueGraphWeakEdge{
		{Kind: "mention", From: "a", To: "b"},
		{Kind: "mention", From: "b", To: "a"},
		{Kind: "wakeup", From: "a", To: "b", UntilState: "in_review"},
		{Kind: "mention", From: "a", To: "secret"},
		{Kind: "wakeup", From: "secret", To: "b", UntilState: "done"},
		{Kind: "mention", From: "a", To: "unknown"},
	}}
	nodes := []IssueGraphNode{{ID: "a"}, {ID: "b"}, {ID: "secret"}}
	visible := func(id string) bool { return id != "secret" }
	matched := map[string]bool{"a": true, "b": true}
	g, err := m.Graph(nodes, nil, matched, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	// A <-> B and a wakeup on the same pair are all kept.
	want := []IssueGraphWeakEdge{{"a", "b", "mention", ""}, {"b", "a", "mention", ""}, {"a", "b", "wakeup", "in_review"}}
	if !reflect.DeepEqual(g.WeakEdges, want) || g.HasRestrictedContext || len(g.Edges) != 0 || g.MatchedCount != 2 || g.ContextCount != 0 {
		t.Fatalf("public weak edges differ: %+v", g)
	}
	for _, n := range g.Nodes {
		if n.DependencySummary.VisibleUnsatisfiedCount != 0 || n.DependencySummary.HasRestrictedBlockers {
			t.Fatal("a weak edge was counted as a blocker")
		}
	}
	data, _ := json.Marshal(g)
	if strings.Contains(string(data), "secret") {
		t.Fatal("a weak edge disclosed a hidden endpoint")
	}
	// b is only weakly related to a, so a focus on a does not pull it in.
	alone, err := m.Graph(nodes, nil, map[string]bool{"a": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if len(alone.WeakEdges) != 0 || alone.ContextCount != 0 || alone.HasRestrictedContext {
		t.Fatalf("weak edges widened the closure: %+v", alone)
	}
	// Weak edges are content: they change the snapshot, not the layout identity.
	m.WeakEdges = nil
	without, err := m.Graph(nodes, nil, matched, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if without.TopologyID != g.TopologyID || without.SnapshotID == g.SnapshotID || without.WeakEdges == nil || len(without.WeakEdges) != 0 {
		t.Fatal("weak edges must change the snapshot, not the topology")
	}
}
