package issuedependency

import "testing"

func TestDependencyLegacyAuditPreservesUnknownData(t *testing.T) {
	nodes := []AuditNode{{ID: "a", WorkspaceID: "one"}, {ID: "b", WorkspaceID: "one"}, {ID: "c", WorkspaceID: "two"}}
	edges := []Edge{{ID: "1", IssueID: "b", DependsOnID: "a", Type: "blocked_by"}, {ID: "2", IssueID: "b", DependsOnID: "a", Type: "blocked_by"}, {ID: "3", IssueID: "a", DependsOnID: "b", Type: "blocks"}, {ID: "4", IssueID: "a", DependsOnID: "c", Type: "blocked_by"}, {ID: "5", IssueID: "missing", DependsOnID: "missing2", Type: "related"}, {ID: "6", IssueID: "a", DependsOnID: "b", Type: "related"}}
	a := AuditLegacy(nodes, edges)
	if a.Total != 6 || len(a.DuplicateIDs) != 1 || a.DuplicateIDs[0] != "2" || len(a.UnverifiedIDs) != 3 || len(a.Normalized) != 5 || len(a.Original) != 6 {
		t.Fatalf("incorrect audit: %+v", a)
	}
	if a.Normalized[1].Type != "blocks" {
		t.Fatal("unknown historical direction was reinterpreted")
	}
	a = AuditLegacy(nodes, edges[:2])
	if len(a.WorkspaceViolations) != 0 || len(a.UnverifiedIDs) != 0 {
		t.Fatalf("safe exact duplicates should be normalizable: %+v", a)
	}
}
