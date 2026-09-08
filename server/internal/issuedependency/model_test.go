package issuedependency

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func model(parents map[string]string, edges ...[2]string) Model {
	m := Model{Issues: map[string]Issue{}}
	for id, p := range parents {
		m.Issues[id] = Issue{ID: id, ParentID: p, Category: "todo"}
	}
	for i, e := range edges {
		m.Edges = append(m.Edges, Edge{ID: fmt.Sprint(i), IssueID: e[1], DependsOnID: e[0], Type: "blocked_by"})
	}
	return m
}

func TestDependencyInheritanceAndWeakening(t *testing.T) {
	m := model(map[string]string{"A": "", "A1": "A", "B": "", "B1": "B", "C": ""}, [2]string{"A", "B"}, [2]string{"C", "B1"}, [2]string{"A", "B1"})
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	p := m.Prerequisites("B1")
	if len(p) != 2 || len(p[0].SourceEdges) != 2 || len(p[0].InheritedFrom) != 1 {
		t.Fatalf("lost deduplication or provenance: %+v", p)
	}
	next := m.Clone()
	n := next.Issues["B1"]
	n.ParentID = ""
	next.Issues["B1"] = n
	if m.Weakened(next) {
		t.Fatal("the child's direct A prerequisite still protects it")
	}
	next.Edges = next.Edges[:1]
	if !m.Weakened(next) {
		t.Fatal("removing unfinished prerequisites must weaken constraints")
	}
	n = m.Issues["A"]
	n.Category = "done"
	m.Issues["A"] = n
	if !m.Prerequisites("B")[0].Satisfied {
		t.Fatal("D1 reads the prerequisite's own category")
	}
	if len(m.Prerequisites("A1")) != 0 {
		t.Fatal("parentage alone must never create a prerequisite")
	}
	counts := m.DescendantCounts(func(id string) bool { return id != "A1" })
	if counts["A"] != 0 || counts["B"] != 1 || counts["B1"] != 0 {
		t.Fatalf("descendant counts leaked invisible nodes or lost visible nodes: %v", counts)
	}
}

func TestDependencyInheritedCycleAndReparent(t *testing.T) {
	m := model(map[string]string{"A": "", "A1": "A", "B": "", "B1": ""}, [2]string{"A1", "B"}, [2]string{"B1", "A"})
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	n := m.Issues["B1"]
	n.ParentID = "B"
	n.Category = "done"
	m.Issues["B1"] = n
	var violation *Violation
	if !errors.As(m.Validate(), &violation) || violation.Code != "dependency_cycle" || len(violation.EdgeIDs) != 2 {
		t.Fatalf("expected both original edges in inherited cycle: %+v", violation)
	}
	parentCycle := model(map[string]string{"A": "B", "B": "A"})
	if parentCycle.Validate() == nil {
		t.Fatal("parent forest must be acyclic")
	}
}

func TestDependencyExecutionComponentPreservesCanonicalEvidence(t *testing.T) {
	for _, kind := range []string{"dangling", "duplicate", "missing_parent"} {
		t.Run(kind, func(t *testing.T) {
			m := model(map[string]string{"A": "", "A1": "A", "B": "", "B1": "B", "C": "", "D": "", "bad": "", "other": ""},
				[2]string{"A1", "B"}, [2]string{"C", "B1"}, [2]string{"B1", "D"})
			m.Edges = append(m.Edges,
				Edge{ID: "unknown", IssueID: "B", DependsOnID: "bad", Type: "blocks"},
				Edge{ID: "inert", IssueID: "B1", DependsOnID: "bad", Type: "related"})
			switch kind {
			case "dangling":
				m.Edges = append(m.Edges, Edge{ID: "dangling", IssueID: "bad", DependsOnID: "missing", Type: "blocked_by"})
			case "duplicate":
				m.Edges = append(m.Edges,
					Edge{ID: "first", IssueID: "bad", DependsOnID: "other", Type: "blocked_by"},
					Edge{ID: "second", IssueID: "bad", DependsOnID: "other", Type: "blocked_by"})
			case "missing_parent":
				n := m.Issues["bad"]
				n.ParentID = "missing"
				m.Issues["bad"] = n
			}
			original := m.Clone()
			if m.Validate() == nil {
				t.Fatal("the complete workspace must remain unverified")
			}
			component := m.ExecutionComponent("B1")
			if err := component.Validate(); err != nil {
				t.Fatalf("unrelated history blocked the valid component: %v", err)
			}
			if !reflect.DeepEqual(component.IDs(), []string{"A", "A1", "B", "B1", "C", "D"}) || len(component.Edges) != 3 {
				t.Fatalf("lost an ancestor, prerequisite, or downstream task: %+v", component)
			}
			ps := component.Prerequisites("B1")
			if len(ps) != 2 || ps[0].IssueID != "A1" || ps[1].IssueID != "C" {
				t.Fatalf("component changed inherited readiness: %+v", ps)
			}
			if m.ExecutionComponent("bad").Validate() == nil || m.ExecutionComponent("B1", "bad").Validate() == nil {
				t.Fatal("affected canonical corruption was hidden or normalized")
			}
			if !reflect.DeepEqual(m, original) {
				t.Fatal("component selection changed the original audit evidence")
			}
		})
	}
}

// Independent oracle explicitly expands every dependency onto the target's
// descendants, then computes transitive closure. It shares no graph algorithm
// with Validate. 24 forests * 4096 directed graphs = 98,304 comparisons.
func TestDependencyCompressedGraphMatchesExpansion(t *testing.T) {
	count := 0
	for b := -1; b < 1; b++ {
		for c := -1; c < 2; c++ {
			for d := -1; d < 3; d++ {
				parents := []int{-1, b, c, d}
				ancestor := func(a, n int) bool {
					for n >= 0 {
						if a == n {
							return true
						}
						n = parents[n]
					}
					return false
				}
				pairs := [][2]int{}
				for a := 0; a < 4; a++ {
					for b := 0; b < 4; b++ {
						if a != b {
							pairs = append(pairs, [2]int{a, b})
						}
					}
				}
				for mask := 0; mask < 1<<len(pairs); mask++ {
					m := Model{Issues: map[string]Issue{}}
					for i, p := range parents {
						parent := ""
						if p >= 0 {
							parent = fmt.Sprint(p)
						}
						id := fmt.Sprint(i)
						m.Issues[id] = Issue{ID: id, ParentID: parent}
					}
					var reach [4][4]bool
					valid := true
					for bit, e := range pairs {
						if mask&(1<<bit) == 0 {
							continue
						}
						a, b := e[0], e[1]
						m.Edges = append(m.Edges, Edge{ID: fmt.Sprint(bit), DependsOnID: fmt.Sprint(a), IssueID: fmt.Sprint(b), Type: "blocked_by"})
						if ancestor(a, b) || ancestor(b, a) {
							valid = false
						}
						for x := 0; x < 4; x++ {
							if ancestor(b, x) {
								reach[a][x] = true
							}
						}
					}
					for k := 0; k < 4; k++ {
						for i := 0; i < 4; i++ {
							for j := 0; j < 4; j++ {
								reach[i][j] = reach[i][j] || (reach[i][k] && reach[k][j])
							}
						}
					}
					for i := 0; i < 4; i++ {
						if reach[i][i] {
							valid = false
						}
					}
					if got := m.Validate() == nil; got != valid {
						t.Fatalf("parents=%v mask=%d compressed=%v expanded=%v", parents, mask, got, valid)
					}
					count++
				}
			}
		}
	}
	if count != 98304 {
		t.Fatalf("unexpected coverage %d", count)
	}
}

func TestDependencyLegacyAndAncestorData(t *testing.T) {
	for _, kind := range []string{"blocks", "unexpected"} {
		m := model(map[string]string{"A": "", "B": ""}, [2]string{"A", "B"})
		m.Edges[0].Type = kind
		if m.Validate() == nil {
			t.Fatalf("unverified %s was accepted", kind)
		}
	}
	m := model(map[string]string{"A": "", "B": "A"}, [2]string{"B", "A"})
	if m.Validate() == nil {
		t.Fatal("ancestor conflict accepted")
	}
	m.Edges[0].Type = "related"
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(m.Prerequisites("A")) != 0 {
		t.Fatal("related became an execution prerequisite")
	}
}
