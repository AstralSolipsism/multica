package service

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/issuedependency"
)

func TestIssueGraphRestrictedClosure(t *testing.T) {
	parent := "hidden-parent"
	s := DependencySnapshot{service: &DependencyService{SigningKey: []byte("test")}, Model: issuedependency.Model{
		Issues: map[string]issuedependency.Issue{
			"target":           {ID: "target", ParentID: parent},
			parent:             {ID: parent},
			"secret":           {ID: "secret", Title: "private title", Category: "todo"},
			"visible-upstream": {ID: "visible-upstream", Category: "done"},
		},
		Edges: []issuedependency.Edge{{ID: "hidden-edge", IssueID: parent, DependsOnID: "secret", Type: "blocked_by"}, {ID: "hidden-path", IssueID: "secret", DependsOnID: "visible-upstream", Type: "blocked_by"}},
	}}
	nodes := []IssueGraphNode{{ID: "target", ParentIssueID: &parent}, {ID: parent}, {ID: "secret", Title: "private title"}, {ID: "visible-upstream"}}
	visible := func(id string) bool { return id == "target" || id == "visible-upstream" }
	g, err := s.Graph(nodes, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
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
	for _, hidden := range []string{parent, "secret", "hidden-edge", "hidden-path", "private title"} {
		if strings.Contains(string(data), hidden) {
			t.Fatalf("leaked %q", hidden)
		}
	}
	version := g.SnapshotID
	n := s.Model.Issues["secret"]
	n.Category = "done"
	n.Status = "done"
	n.Revision++
	s.Model.Issues[n.ID] = n
	ready, err := s.Graph(nodes, nil, map[string]bool{"target": true}, IssueGraphScope{Type: "workspace"}, nil, time.Now(), visible)
	if err != nil {
		t.Fatal(err)
	}
	if ready.SnapshotID == version || ready.TopologyID != g.TopologyID || !ready.HasRestrictedContext {
		t.Fatal("hidden state change did not preserve topology and opaque versioning")
	}
	for _, n := range ready.Nodes {
		if n.DependencySummary.HasRestrictedBlockers {
			t.Fatal("a completed hidden prerequisite still blocks")
		}
	}
}
