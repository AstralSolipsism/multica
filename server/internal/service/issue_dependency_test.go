package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/issuedependency"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

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
