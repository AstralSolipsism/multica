package service

import (
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuedependency"
)

func TestDependencyPlanPreservesInputAndCanonicalEdges(t *testing.T) {
	before := issuedependency.Model{
		Issues: map[string]issuedependency.Issue{
			"target": {ID: "target"}, "old": {ID: "old"}, "kept": {ID: "kept"}, "new": {ID: "new"},
		},
		Edges: []issuedependency.Edge{
			{ID: "removed", IssueID: "target", DependsOnID: "old", Type: "blocked_by"},
			{ID: "canonical", IssueID: "target", DependsOnID: "kept", Type: "blocked_by"},
			{ID: "historical", IssueID: "old", DependsOnID: "missing", Type: "blocks"},
		},
	}
	original := before.Clone()
	replacement := []issuedependency.Edge{
		{ID: "unused", IssueID: "target", DependsOnID: "kept", Type: "blocked_by"},
		{ID: "added", IssueID: "target", DependsOnID: "new", Type: "blocked_by"},
	}
	proposed := before.Issues["target"]
	proposed.Title = "Changed display"
	change, err := planRelationChange(before, proposed, &replacement)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, original) {
		t.Fatal("planning mutated the original snapshot")
	}
	wantEdges := []issuedependency.Edge{before.Edges[1], before.Edges[2], replacement[1]}
	if !reflect.DeepEqual(change.Next.Edges, wantEdges) || !reflect.DeepEqual(change.Added, replacement[1:]) || !reflect.DeepEqual(change.Removed, before.Edges[:1]) {
		t.Fatalf("replacement lost edge identity, history, or diff: %+v", change)
	}
	again, err := planRelationChange(before, proposed, &replacement)
	if err != nil || !reflect.DeepEqual(change, again) {
		t.Fatalf("planning the same input is not deterministic: %v", err)
	}
	noOp, err := planRelationChange(change.Next, proposed, &replacement)
	if err != nil || noOp.changed() || len(noOp.Added)+len(noOp.Removed) != 0 {
		t.Fatalf("replacing the same edges was not a no-op: %+v, %v", noOp, err)
	}
	detached := proposed
	detached.ParentID = "old"
	reparent, err := planRelationChange(before, detached, nil)
	if err != nil || !reparent.changed() || len(reparent.Added)+len(reparent.Removed) != 0 || !reflect.DeepEqual(reparent.Next.Edges, before.Edges) {
		t.Fatalf("ordinary reparenting rewrote historical relations: %+v, %v", reparent, err)
	}
	clear := []issuedependency.Edge{}
	cleared, err := planRelationChange(before, proposed, &clear)
	if err != nil || !reflect.DeepEqual(cleared.Next.Edges, before.Edges[2:]) {
		t.Fatalf("explicit empty replacement failed to clear direct prerequisites: %+v, %v", cleared, err)
	}
}

func TestDependencyValidationScopesPreserveAffectedEvidence(t *testing.T) {
	before := issuedependency.Model{Issues: map[string]issuedependency.Issue{
		"target": {ID: "target", ParentID: "old"}, "old": {ID: "old"}, "new": {ID: "new"}, "bad": {ID: "bad"},
	}, Edges: []issuedependency.Edge{{ID: "bad-cycle", IssueID: "bad", DependsOnID: "bad", Type: "blocked_by"}}}
	proposed := before.Issues["target"]
	proposed.ParentID = "new"
	change, err := planRelationChange(before, proposed, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		write DependencyWrite
		valid bool
	}{
		{name: "ordinary hierarchy edit", valid: true},
		{name: "compound response", write: DependencyWrite{IncludeView: true}},
		{name: "versioned edit", write: DependencyWrite{ExpectedVersion: "checked-before-planning"}},
		{name: "explicit replacement", write: DependencyWrite{BlockedBy: &[]pgtype.UUID{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validationScopeFor(before.Issues["target"], proposed, tc.write).validate(before, change.Next, "target")
			if (err == nil) != tc.valid {
				t.Fatalf("scope validation = %v, want valid=%v", err, tc.valid)
			}
		})
	}
	// Detaching must still check the former component, and joining must check
	// the destination component; neither can hide corrupt canonical evidence.
	for _, endpoint := range []string{"old", "new"} {
		t.Run("corrupt "+endpoint+" component", func(t *testing.T) {
			invalid := before.Clone()
			invalid.Edges = append(invalid.Edges, issuedependency.Edge{ID: "affected-cycle", IssueID: endpoint, DependsOnID: endpoint, Type: "blocked_by"})
			change, err := planRelationChange(invalid, proposed, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateAffectedRelations.validate(invalid, change.Next, "target"); err == nil {
				t.Fatal("hierarchy edit hid corrupt affected relations")
			}
		})
	}
}
