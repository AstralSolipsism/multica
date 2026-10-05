package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Run only against a migrated isolated test database. Fixture setup, cleanup,
// authentication and network time are excluded; the real handlers commit writes.
func TestDependencyWriteScale(t *testing.T) {
	if os.Getenv("ISSUE_DEPENDENCY_WRITE_BENCHMARK") != "1" {
		t.Skip("set ISSUE_DEPENDENCY_WRITE_BENCHMARK=1 for 20,000-issue write measurements")
	}
	h, fx := dependencyFixture(t)
	// Fixture writes need no durability waits. Production handlers still use
	// testPool with its normal synchronous commits throughout the measurements.
	seedConfig := testPool.Config()
	seedConfig.MaxConns = 1
	seedConfig.ConnConfig.RuntimeParams["synchronous_commit"] = "off"
	seedPool, err := pgxpool.NewWithConfig(context.Background(), seedConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(seedPool.Close)
	fx = testutil.New(seedPool, fx.WorkspaceID, fx.UserID)
	const size = 20000
	ids := make([]string, size)
	for i := range ids {
		ids[i] = fx.Issue(t, fmt.Sprintf("Write benchmark %d", i), testutil.Cols{"number": i + 1, "status": "backlog"})
	}
	for i := 0; i < 200; i++ {
		fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": ids[1000+i], "depends_on_issue_id": ids[500+i], "type": "blocked_by"})
	}
	fx.Exec(t, "UPDATE workspace SET issue_counter=$2 WHERE id=$1", fx.WorkspaceID, size)
	fx.Exec(t, "ANALYZE issue")
	fx.Exec(t, "ANALYZE issue_dependency")
	// Delete the scale fixture in one transaction before the per-row cleanup
	// callbacks, avoiding 20,000 teardown commits/fsyncs.
	fx.Cleanup(t, "DELETE FROM issue WHERE workspace_id=$1", fx.WorkspaceID)
	type measurement struct {
		Operation string    `json:"operation"`
		Nodes     int       `json:"nodes"`
		Edges     int       `json:"edges"`
		MedianMS  float64   `json:"median_ms"`
		P95MS     float64   `json:"p95_ms"`
		SamplesMS []float64 `json:"samples_ms"`
	}
	var measurements []measurement
	for _, operation := range []string{"reparent", "create_child", "delete"} {
		m := measurement{Operation: operation, Nodes: size, Edges: 200}
		for attempt := 0; attempt < 21; attempt++ {
			var body any
			id, method, status, handler := ids[2], http.MethodPut, http.StatusOK, h.UpdateIssue
			switch operation {
			case "reparent":
				body = map[string]any{"parent_issue_id": ids[attempt%2]}
			case "create_child":
				id, method, status, handler = "", http.MethodPost, http.StatusCreated, h.CreateIssue
				body = map[string]any{"title": fmt.Sprintf("New benchmark child %d", attempt), "parent_issue_id": ids[0], "status": "backlog", "allow_duplicate": true}
			case "delete":
				id, method, status, handler = ids[size-1], http.MethodDelete, http.StatusNoContent, h.DeleteIssue
			}
			r := dependencyRequest(fx, method, id, body, "jwt")
			start := time.Now()
			response := testutil.Call(t, handler, r).Want(status)
			elapsed := float64(time.Since(start).Microseconds()) / 1000
			if attempt > 0 { // One warm-up; retain all 20 measured requests.
				m.SamplesMS = append(m.SamplesMS, elapsed)
			}
			if operation == "create_child" {
				var created IssueResponse
				response.JSON(&created)
				fx.Exec(t, "DELETE FROM issue WHERE id=$1", created.ID)
			}
			if operation == "delete" {
				ids[size-1] = fx.Issue(t, "Replacement deletion target", testutil.Cols{"number": size, "status": "backlog"})
			}
		}
		sorted := slices.Clone(m.SamplesMS)
		slices.Sort(sorted)
		m.MedianMS = (sorted[9] + sorted[10]) / 2
		m.P95MS = sorted[18]
		measurements = append(measurements, m)
	}
	encoded, err := json.MarshalIndent(measurements, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(encoded))
	if path := os.Getenv("ISSUE_DEPENDENCY_WRITE_BENCHMARK_PATH"); path != "" {
		if err := os.WriteFile(path, append(encoded, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
