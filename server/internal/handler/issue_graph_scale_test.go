package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"sort"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Shapes reproduce OL-38 benchmark.cjs. Its zero-based stage labels become
// 1-based database stages; dates remain unset. Sizes are probes, never limits.
func seedGraphScale(t *testing.T, fx *testutil.Fixture, size int, kind string) (map[string]bool, map[string]service.IssueGraphEdge) {
	t.Helper()
	projects := []string{fx.Project(t, "Account"), fx.Project(t, "Orders")}
	ids := make([]string, size)
	parents := make(map[int]bool)
	for i := range ids {
		cols := testutil.Cols{"number": i + 1, "status": "backlog", "stage": i%5 + 1}
		if i%4 == 0 {
			cols["status"] = "done"
		}
		if i%11 != 0 {
			cols["project_id"] = projects[i%2]
		}
		if kind == "hierarchy" && i > 0 {
			p := (i - 1) / 10
			cols["parent_issue_id"] = ids[p]
			parents[p] = true
		}
		ids[i] = fx.Issue(t, fmt.Sprintf("Reference issue %d", i), cols)
	}
	nodes := make(map[string]bool, size)
	for _, id := range ids {
		nodes[id] = true
	}
	edges := make(map[string]service.IssueGraphEdge)
	add := func(a, b int) {
		id := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": ids[b], "depends_on_issue_id": ids[a], "type": "blocked_by"})
		edges[id] = service.IssueGraphEdge{SourceEdgeID: id, Source: ids[a], Target: ids[b], Type: "blocked_by"}
	}
	switch kind {
	case "chain":
		for i := 1; i < size; i++ {
			add(i-1, i)
		}
	case "wide":
		for i := 10; i < size; i++ {
			add(i-10, i)
		}
	case "dense":
		for i := 10; i < size; i++ {
			for d := 1; d <= 5; d++ {
				add(i-10+(i+d)%10, i)
			}
		}
	case "hierarchy":
		var leaves []int
		for i := range ids {
			if !parents[i] {
				leaves = append(leaves, i)
			}
		}
		for i := 1; i < len(leaves); i++ {
			add(leaves[i-1], leaves[i])
			if i > 10 {
				add(leaves[i-10], leaves[i])
			}
		}
	default:
		t.Fatal("unknown sample")
	}
	return nodes, edges
}

// Include the URL membership middleware's pool read in the measured SQL count.
type graphMembershipCounter struct {
	db.DBTX
	calls *int
}

func (q graphMembershipCounter) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	*q.calls++
	return q.DBTX.QueryRow(ctx, sql, args...)
}

func TestIssueGraphScale(t *testing.T) {
	if os.Getenv("ISSUE_GRAPH_BENCHMARK") != "1" {
		t.Skip("set ISSUE_GRAPH_BENCHMARK=1 for isolated 30-request SQL measurements")
	}
	type measurement struct {
		Sample            string    `json:"sample"`
		Nodes             int       `json:"nodes"`
		Edges             int       `json:"edges"`
		Queries           int       `json:"select_queries"`
		ColdMS            float64   `json:"cold_ms"`
		P95MS             float64   `json:"p95_ms"`
		MaxAllocatedBytes uint64    `json:"max_allocated_bytes"`
		ResponseBytes     int       `json:"response_bytes"`
		Milliseconds      []float64 `json:"milliseconds"`
	}
	results := []measurement{}
	for _, size := range []int{100, 500, 1000, 5000, 10000} {
		for _, kind := range []string{"wide", "chain", "dense", "hierarchy"} {
			if size > 1000 && kind != "dense" {
				continue
			}
			t.Run(fmt.Sprintf("%d-%s", size, kind), func(t *testing.T) {
				h, fx := dependencyFixture(t)
				nodes, edges := seedGraphScale(t, fx, size, kind)
				calls := 0
				h.TxStarter = graphTestStarter{inner: h.TxStarter, queryCount: &calls}
				router := chi.NewRouter()
				queries := db.New(graphMembershipCounter{DBTX: h.DB, calls: &calls})
				router.With(middleware.RequireWorkspaceMemberFromURL(queries, "workspaceId")).
					Get("/api/workspaces/{workspaceId}/issues/graph", h.GetIssueGraph)
				r := measurement{Sample: fmt.Sprintf("%d-%s", size, kind), Nodes: size, Edges: len(edges)}
				for attempt := 0; attempt < 31; attempt++ {
					runtime.GC()
					var before, after runtime.MemStats
					runtime.ReadMemStats(&before)
					calls = 0
					start := time.Now()
					res := testutil.Call(t, router.ServeHTTP, graphRequest(fx, nil)).Want(http.StatusOK)
					elapsed := float64(time.Since(start).Microseconds()) / 1000
					runtime.ReadMemStats(&after)
					var graph service.IssueGraph
					res.JSON(&graph)
					if !graph.Complete || len(graph.Nodes) != size || graph.MatchedCount != size || graph.ContextCount != 0 || len(graph.Edges) != len(edges) {
						t.Fatal("topology differs from seeded database")
					}
					seen := make(map[string]bool, len(nodes))
					for _, n := range graph.Nodes {
						if !nodes[n.ID] || seen[n.ID] {
							t.Fatal("node identity set differs from database")
						}
						seen[n.ID] = true
					}
					seen = make(map[string]bool, len(edges))
					for _, e := range graph.Edges {
						if edges[e.SourceEdgeID] != e || seen[e.SourceEdgeID] {
							t.Fatal("source-edge identity/endpoints differ from database")
						}
						seen[e.SourceEdgeID] = true
					}
					if attempt == 0 {
						r.ColdMS = elapsed
					} else {
						r.Milliseconds = append(r.Milliseconds, elapsed)
					}
					allocated := after.TotalAlloc - before.TotalAlloc
					if allocated > r.MaxAllocatedBytes {
						r.MaxAllocatedBytes = allocated
					}
					r.Queries = calls
					r.ResponseBytes = res.Body.Len()
				}
				sorted := append([]float64(nil), r.Milliseconds...)
				sort.Float64s(sorted)
				r.P95MS = sorted[28]
				results = append(results, r)
				data, _ := json.Marshal(r)
				t.Log(string(data))
			})
		}
	}
	if path := os.Getenv("ISSUE_GRAPH_BENCHMARK_PATH"); path != "" {
		data, err := json.MarshalIndent(results, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(data, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
