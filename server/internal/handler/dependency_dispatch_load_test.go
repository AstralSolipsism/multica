package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Opt-in real admission/claim/write load, without running an agent. Latencies
// include transaction commit and pool waits; fixture setup/completion do not.
// Run separately from other DB suites so pg_locks samples belong to this load.
func TestDependencyAdmissionContention(t *testing.T) {
	if os.Getenv("DEPENDENCY_LOAD_TEST") != "1" {
		t.Skip("set DEPENDENCY_LOAD_TEST=1 with an isolated migrated DATABASE_URL")
	}
	if os.Getenv("DATABASE_URL") == "" {
		t.Fatal("set DATABASE_URL explicitly to an isolated migrated database")
	}
	iterations := 100
	if raw := os.Getenv("DEPENDENCY_LOAD_ITERATIONS"); raw != "" {
		var err error
		iterations, err = strconv.Atoi(raw)
		if err != nil || iterations < 10 {
			t.Fatal("DEPENDENCY_LOAD_ITERATIONS must be at least 10")
		}
	}
	var version string
	dbfx.QueryRow(t, "SHOW server_version").Scan(&version)
	t.Logf("postgres=%s go=%s cpus=%d gomaxprocs=%d pool_max_conns=%d iterations_per_worker=%d", version, runtime.Version(), runtime.NumCPU(), runtime.GOMAXPROCS(0), testPool.Config().MaxConns, iterations)
	for _, size := range []int{100, 1000, 5000} {
		t.Run(fmt.Sprintf("nodes=%d", size), func(t *testing.T) {
			h, fx := dependencyFixture(t)
			runtimeID := fx.Runtime(t, "dependency load fake runtime")
			quarter := size / 4
			ids := make([]string, size)
			for i := range ids {
				cols := testutil.Cols{"number": i + 1, "status": "done"}
				if i >= 2*quarter {
					cols["parent_issue_id"] = ids[quarter+i%quarter]
					cols["status"] = "backlog"
				}
				ids[i] = fx.Issue(t, "dependency load fixture", cols)
			}
			for i := 0; i < quarter; i++ {
				for _, prerequisite := range []int{i, (i + 1) % quarter} {
					fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": ids[quarter+i], "depends_on_issue_id": ids[prerequisite], "type": "blocked_by"})
				}
			}
			for _, claimers := range []int{1, 8, 16} {
				for _, writers := range []int{0, 2} {
					t.Run(fmt.Sprintf("claimers=%d/writers=%d", claimers, writers), func(t *testing.T) {
						runDependencyAdmissionLoad(t, h, fx, ids, runtimeID, claimers, writers, iterations)
					})
				}
			}
		})
	}
}

func runDependencyAdmissionLoad(t *testing.T, h *Handler, fx *testutil.Fixture, ids []string, runtimeID string, claimers, writers, iterations int) {
	t.Helper()
	size := len(ids)
	quarter := size / 4
	if testPool.Config().MaxConns < int32(claimers+writers+1) {
		t.Fatal("set pool_max_conns >= claimers + writers + 1 in DATABASE_URL")
	}
	fx.Exec(t, "UPDATE agent_runtime SET last_seen_at=now() WHERE id=$1", runtimeID)
	agents := make([]string, claimers)
	issues := make([]db.Issue, claimers)
	for i := range agents {
		agents[i] = fx.Agent(t, fmt.Sprintf("dependency load fake agent %d", i), runtimeID)
		fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE agent_id=$1", agents[i])
		var err error
		issues[i], err = h.Queries.GetIssue(context.Background(), parseUUID(ids[2*quarter+i]))
		if err != nil {
			t.Fatal(err)
		}
		issues[i].AssigneeType = pgtype.Text{String: "agent", Valid: true}
		issues[i].AssigneeID = parseUUID(agents[i])
	}
	deadline := time.Now().Add(2 * time.Minute)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	type sample struct {
		op  string
		ms  float64
		err error
	}
	samples := make(chan sample, iterations*(2*claimers+writers))
	record := func(op string, start time.Time, err error) bool {
		samples <- sample{op, float64(time.Since(start)) / float64(time.Millisecond), err}
		return err == nil
	}
	cycle := func(i int, measure bool) bool {
		start := time.Now()
		queued, err := h.TaskService.EnqueueTaskForIssue(ctx, issues[i])
		if measure {
			record("enqueue", start, err)
		}
		if err != nil {
			if !measure {
				t.Error(err)
			}
			return false
		}
		start = time.Now()
		claimed, err := h.TaskService.ClaimTask(ctx, parseUUID(agents[i]))
		if err == nil && (claimed == nil || claimed.ID != queued.ID || claimed.Status != "dispatched" || len(claimed.DependencyAdmission) == 0) {
			err = fmt.Errorf("claim did not admit exactly the newly enqueued task")
		}
		if measure {
			record("claim", start, err)
		}
		if err != nil {
			if !measure {
				t.Error(err)
			}
			return false
		}
		// Simulate completion outside the measurement; no daemon or CLI runs.
		if _, err := testPool.Exec(ctx, "UPDATE agent_task_queue SET status='completed', completed_at=now() WHERE id=$1", queued.ID); err != nil {
			t.Error(err)
			return false
		}
		return true
	}
	for i := range agents {
		if !cycle(i, false) {
			t.Fatal("load warmup failed")
		}
	}
	monitorCtx, stopMonitor := context.WithCancel(ctx)
	monitored := make(chan dependencyLoadLocks, 1)
	go func() { monitored <- sampleDependencyLoadLocks(monitorCtx) }()
	var wg sync.WaitGroup
	startWork := make(chan struct{})
	for i := range agents {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-startWork
			for range iterations {
				if !cycle(i, true) {
					return
				}
			}
		}()
	}
	for writer := 0; writer < writers; writer++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-startWork
			for i := 0; i < iterations; i++ {
				op := "title_write"
				body := map[string]any{"title": fmt.Sprintf("load edit %d", i)}
				if writer == 1 {
					op = "status_write"
					body = map[string]any{"status": []string{"todo", "done"}[i%2]}
				}
				r := dependencyRequest(fx, http.MethodPatch, ids[size-1-writer], body, "jwt")
				requestCtx, cancelRequest := context.WithDeadline(r.Context(), deadline)
				r = r.WithContext(requestCtx)
				start := time.Now()
				response := testutil.Call(t, h.UpdateIssue, r)
				cancelRequest()
				var err error
				if response.Code != http.StatusOK {
					err = fmt.Errorf("write HTTP %d: %s", response.Code, response.Text())
				}
				if !record(op, start, err) {
					return
				}
			}
		}()
	}
	started := time.Now()
	close(startWork)
	wg.Wait()
	elapsed := time.Since(started).Seconds()
	stopMonitor()
	locks := <-monitored
	close(samples)
	latencies := map[string][]float64{}
	errors := []string{}
	for sample := range samples {
		latencies[sample.op] = append(latencies[sample.op], sample.ms)
		if sample.err != nil {
			errors = append(errors, sample.op+": "+sample.err.Error())
		}
	}
	summary := map[string]any{}
	for op, values := range latencies {
		sort.Float64s(values)
		percentile := func(p int) float64 { return values[(len(values)*p+99)/100-1] }
		summary[op] = map[string]any{"count": len(values), "p50_ms": percentile(50), "p95_ms": percentile(95), "p99_ms": percentile(99), "max_ms": values[len(values)-1]}
	}
	data, err := json.Marshal(map[string]any{"nodes": size, "edges": 2 * quarter, "claimers": claimers, "writers": writers, "seconds": elapsed, "cycles_per_second": float64(len(latencies["claim"])) / elapsed, "summary": summary, "latency_ms": latencies, "locks": locks, "errors": errors})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("DEPENDENCY_LOAD_RESULT %s", data)
	if len(errors) != 0 || locks.Error != "" || len(latencies["claim"]) != iterations*claimers || len(latencies["enqueue"]) != iterations*claimers || (writers > 0 && (len(latencies["title_write"]) != iterations || len(latencies["status_write"]) != iterations)) {
		t.Fatal("load did not finish every operation successfully; see result")
	}
	for _, agent := range agents {
		if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE agent_id=$1 AND status='completed' AND dependency_admission->>'consumed_at' IS NOT NULL", agent) != iterations+1 {
			t.Fatal("load lost or duplicated an admitted execution, including warmup")
		}
	}
	if writers > 0 {
		if fx.Count(t, "SELECT count(*) FROM issue WHERE (id=$1 AND title=$2) OR (id=$3 AND status=$4)", ids[size-1], fmt.Sprintf("load edit %d", iterations-1), ids[size-2], []string{"todo", "done"}[(iterations-1)%2]) != 2 {
			t.Fatal("load lost an acknowledged issue write")
		}
	}
}

type dependencyLoadLocks struct {
	Samples           int     `json:"samples"`
	WaitingSamples    int     `json:"waiting_samples"`
	MaxWaiters        int     `json:"max_waiters"`
	MaxObservedWaitMS float64 `json:"max_observed_wait_ms"`
	Error             string  `json:"error,omitempty"`
}

func sampleDependencyLoadLocks(ctx context.Context) dependencyLoadLocks {
	var result dependencyLoadLocks
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return result
		case <-ticker.C:
			var waiters int
			var waitMS float64
			err := testPool.QueryRow(ctx, `SELECT count(DISTINCT l.pid), COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-l.waitstart)*1000),0)::float8
				FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
				WHERE NOT l.granted AND a.datname=current_database() AND l.pid<>pg_backend_pid()`).Scan(&waiters, &waitMS)
			if err != nil {
				if ctx.Err() == nil {
					result.Error = err.Error()
				}
				return result
			}
			result.Samples++
			if waiters > 0 {
				result.WaitingSamples++
			}
			result.MaxWaiters = max(result.MaxWaiters, waiters)
			result.MaxObservedWaitMS = max(result.MaxObservedWaitMS, waitMS)
		}
	}
}
