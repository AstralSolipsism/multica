package service

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/issuedependency"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestDependencyScopedSnapshotRejectsAnotherTarget(t *testing.T) {
	target := util.MustParseUUID("00000000-0000-4000-8000-000000000001")
	other := util.MustParseUUID("00000000-0000-4000-8000-000000000002")
	snapshot := DependencySnapshot{admissionTargets: map[string]bool{util.UUIDToString(target): true}}
	err := snapshot.CheckWriteAdmission(context.Background(), db.Issue{ID: other}, false, true)
	var dep *DependencyError
	if !errors.As(err, &dep) || dep.Code != "dependency_data_unverified" {
		t.Fatalf("snapshot admitted a target whose statuses were not locked: %v", err)
	}
	for _, issue := range []db.Issue{{ID: other}, {}} {
		err := snapshot.CheckRun(context.Background(), issue.ID)
		if !errors.As(err, &dep) || dep.Code != "dependency_data_unverified" {
			t.Fatalf("run bypassed the scoped snapshot: %v", err)
		}
	}
}

func TestDependencyAdmissionProjectionIgnoresEdgeOrder(t *testing.T) {
	snapshot := DependencySnapshot{service: &DependencyService{SigningKey: []byte("test-only-signing-key")}, Model: issuedependency.Model{
		Issues: map[string]issuedependency.Issue{
			"target": {ID: "target", ParentID: "parent"}, "parent": {ID: "parent"},
			"a": {ID: "a", Category: "done"}, "b": {ID: "b", Category: "todo"}, "successor": {ID: "successor"},
		},
		Edges: []issuedependency.Edge{
			{ID: "edge-1", IssueID: "target", DependsOnID: "a", Type: "blocked_by"},
			{ID: "edge-2", IssueID: "parent", DependsOnID: "a", Type: "blocked_by"},
			{ID: "edge-3", IssueID: "parent", DependsOnID: "b", Type: "blocked_by"},
			{ID: "edge-4", IssueID: "successor", DependsOnID: "target", Type: "blocked_by"},
		},
	}}
	var previous string
	for i := 0; i < 2; i++ {
		if err := snapshot.Model.Validate(); err != nil {
			t.Fatal(err)
		}
		view := snapshot.View("target", func(string) bool { return true })
		if len(view.Unsatisfied) != 1 || view.Unsatisfied[0].IssueID != "b" {
			t.Fatalf("unordered snapshot lost the inherited blocker: %+v", view)
		}
		encoded, err := json.Marshal(view)
		if err != nil {
			t.Fatal(err)
		}
		if i > 0 && string(encoded) != previous {
			t.Fatal("edge order changed the dependency view or signed version")
		}
		previous = string(encoded)
		slices.Reverse(snapshot.Model.Edges)
	}
}

func TestDependencyProjectionAndSignedVersion(t *testing.T) {
	s := DependencySnapshot{service: &DependencyService{SigningKey: []byte("test-only-signing-key")}, Model: issuedependency.Model{
		Issues: map[string]issuedependency.Issue{"target": {ID: "target", ParentID: "hidden-parent", Revision: 1}, "hidden-parent": {ID: "hidden-parent"}, "secret": {ID: "secret", Title: "private title", Status: "todo", Category: "todo", Revision: 1}},
		Edges:  []issuedependency.Edge{{ID: "hidden-edge", IssueID: "hidden-parent", DependsOnID: "secret", Type: "blocked_by"}},
	}}
	if err := s.Model.Validate(); err != nil {
		t.Fatal(err)
	}
	v := s.View("target", func(id string) bool { return id == "target" })
	if !v.HasRestrictedBlockers || len(v.Unsatisfied) > 0 || len(v.InheritedBlockedBy) > 0 {
		t.Fatalf("restricted prerequisites must block without disclosure: %+v", v)
	}
	encoded, _ := json.Marshal(v)
	for _, hidden := range []string{"hidden-parent", "hidden-edge", "secret", "private title"} {
		if strings.Contains(string(encoded), hidden) {
			t.Fatalf("leaked %s", hidden)
		}
	}
	version := s.Version("target")
	n := s.Model.Issues["secret"]
	n.Category = "done"
	n.Status = "done"
	n.Revision++
	s.Model.Issues[n.ID] = n
	if version == s.Version("target") {
		t.Fatal("prerequisite completion did not invalidate version")
	}
	if s.View("target", func(id string) bool { return id == "target" }).HasRestrictedBlockers {
		t.Fatal("a hidden completed prerequisite is not a blocker")
	}
	version = s.Version("target")
	s.Catalog = []db.IssueStatus{{Key: "custom", Category: "done"}}
	if version == s.Version("target") {
		t.Fatal("catalog mutation did not invalidate version")
	}
	version = s.Version("target")
	s.service = &DependencyService{SigningKey: []byte("another-test-key")}
	if version == s.Version("target") {
		t.Fatal("dependency version was not keyed")
	}
}
