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
			workspaces := []dependencyLoadWorkspace{newDependencyLoadWorkspace(t, size, "sparse")}
			for _, claimers := range []int{1, 8, 16} {
				for _, writers := range []int{0, 2} {
					t.Run(fmt.Sprintf("claimers=%d/writers=%d", claimers, writers), func(t *testing.T) {
						runDependencyAdmissionLoad(t, workspaces, claimers, writers, iterations, 0)
					})
				}
			}
		})
	}
	for _, shape := range []string{"dense", "deep", "multi_workspace", "sustained"} {
		t.Run(shape, func(t *testing.T) {
			workspaces := []dependencyLoadWorkspace{newDependencyLoadWorkspace(t, 5000, shape)}
			if shape == "multi_workspace" {
				for range 3 {
					workspaces = append(workspaces, newDependencyLoadWorkspace(t, 5000, shape))
				}
			}
			var duration time.Duration
			if shape == "sustained" {
				duration = 30 * time.Second
			}
			runDependencyAdmissionLoad(t, workspaces, 16, 2, iterations, duration)
		})
	}
}

type dependencyLoadWorkspace struct {
	h         *Handler
	fx        *testutil.Fixture
	ids       []string
	runtimeID string
	edges     int
}

func newDependencyLoadWorkspace(t *testing.T, size int, shape string) dependencyLoadWorkspace {
	t.Helper()
	h, fx := dependencyFixture(t)
	w := dependencyLoadWorkspace{h: h, fx: fx, runtimeID: fx.Runtime(t, "dependency load fake runtime"), ids: make([]string, size)}
	quarter := size / 4
	for i := range w.ids {
		cols := testutil.Cols{"number": i + 1, "status": "done"}
		if shape == "deep" && i > quarter && i < 2*quarter {
			cols["parent_issue_id"] = w.ids[i-1]
		}
		if i >= 2*quarter {
			parent := quarter + i%quarter
			if shape == "deep" {
				parent = 2*quarter - 1
			}
			cols["parent_issue_id"] = w.ids[parent]
			cols["status"] = "backlog"
		}
		w.ids[i] = fx.Issue(t, "dependency load fixture", cols)
	}
	width := 2
	if shape == "dense" {
		width = 32
	}
	for i := 0; i < quarter; i++ {
		for offset := range width {
			fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": w.ids[quarter+i], "depends_on_issue_id": w.ids[(i+offset)%quarter], "type": "blocked_by"})
			w.edges++
		}
	}
	return w
}

func runDependencyAdmissionLoad(t *testing.T, workspaces []dependencyLoadWorkspace, claimers, writers, iterations int, duration time.Duration) {
	t.Helper()
	if testPool.Config().MaxConns < int32(claimers+writers+1) {
		t.Fatal("set pool_max_conns >= claimers + writers + 1 in DATABASE_URL")
	}
	for _, w := range workspaces {
		// Fake runtime stays healthy through slow baseline cases; no daemon runs.
		w.fx.Exec(t, "UPDATE agent_runtime SET last_seen_at=now()+interval '10 minutes' WHERE id=$1", w.runtimeID)
	}
	agents := make([]string, claimers)
	issues := make([]db.Issue, claimers)
	for i := range agents {
		w := workspaces[i%len(workspaces)]
		agents[i] = w.fx.Agent(t, fmt.Sprintf("dependency load fake agent %d", i), w.runtimeID)
		w.fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE agent_id=$1", agents[i])
		var err error
		issues[i], err = w.h.Queries.GetIssue(context.Background(), parseUUID(w.ids[len(w.ids)/2+i]))
		if err != nil {
			t.Fatal(err)
		}
		issues[i].AssigneeType = pgtype.Text{String: "agent", Valid: true}
		issues[i].AssigneeID = parseUUID(agents[i])
	}
	deadline := time.Now().Add(5 * time.Minute)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	type sample struct {
		op  string
		ms  float64
		err error
	}
	var mu sync.Mutex
	samples := make([]sample, 0, iterations*(2*claimers+writers))
	completed := make([]int, claimers)
	written := make([]int, writers)
	beforeWrites := make([]db.Issue, writers)
	for writer := range beforeWrites {
		w := workspaces[writer%len(workspaces)]
		var err error
		beforeWrites[writer], err = w.h.Queries.GetIssue(ctx, parseUUID(w.ids[len(w.ids)-1-writer]))
		if err != nil {
			t.Fatal(err)
		}
	}
	claimedIDs := make(map[pgtype.UUID]bool)
	record := func(op string, start time.Time, err error) bool {
		ms := float64(time.Since(start)) / float64(time.Millisecond)
		mu.Lock()
		samples = append(samples, sample{op, ms, err})
		mu.Unlock()
		return err == nil
	}
	cycle := func(i int, measure bool) bool {
		h := workspaces[i%len(workspaces)].h
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
		if err == nil {
			mu.Lock()
			if claimedIDs[claimed.ID] {
				err = fmt.Errorf("duplicate execution returned by claim")
			}
			claimedIDs[claimed.ID] = true
			mu.Unlock()
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
		completed[i]++
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
	var started time.Time
	for i := range agents {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-startWork
			for n := 0; n < iterations || time.Since(started) < duration; n++ {
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
			w := workspaces[writer%len(workspaces)]
			for i := 0; i < iterations || time.Since(started) < duration; i++ {
				op := "title_write"
				body := map[string]any{"title": fmt.Sprintf("load edit %d", i)}
				if writer == 1 {
					op = "status_write"
					body = map[string]any{"status": []string{"todo", "done"}[i%2]}
				}
				r := dependencyRequest(w.fx, http.MethodPatch, w.ids[len(w.ids)-1-writer], body, "jwt")
				requestCtx, cancelRequest := context.WithDeadline(r.Context(), deadline)
				r = r.WithContext(requestCtx)
				start := time.Now()
				response := testutil.Call(t, w.h.UpdateIssue, r)
				cancelRequest()
				var err error
				if response.Code != http.StatusOK {
					err = fmt.Errorf("write HTTP %d: %s", response.Code, response.Text())
				}
				if !record(op, start, err) {
					return
				}
				written[writer]++
			}
		}()
	}
	started = time.Now()
	close(startWork)
	wg.Wait()
	elapsed := time.Since(started).Seconds()
	stopMonitor()
	locks := <-monitored
	latencies := map[string][]float64{}
	errors := []string{}
	for _, sample := range samples {
		latencies[sample.op] = append(latencies[sample.op], sample.ms)
		if sample.err != nil {
			errors = append(errors, sample.op+": "+sample.err.Error())
		}
	}
	summary := map[string]any{}
	performancePassed := true
	for op, values := range latencies {
		sort.Float64s(values)
		percentile := func(p int) float64 { return values[(len(values)*p+99)/100-1] }
		maximum := values[len(values)-1]
		performancePassed = performancePassed && percentile(95) <= 500 && percentile(99) <= 1000 && maximum <= 2000
		summary[op] = map[string]any{"count": len(values), "per_second": float64(len(values)) / elapsed, "p50_ms": percentile(50), "p95_ms": percentile(95), "p99_ms": percentile(99), "max_ms": maximum}
	}
	nodes, edges := 0, 0
	for _, w := range workspaces {
		nodes += len(w.ids)
		edges += w.edges
	}
	data, err := json.Marshal(map[string]any{"scenario": t.Name(), "nodes": nodes, "edges": edges, "workspaces": len(workspaces), "claimers": claimers, "writers": writers, "iterations_min": iterations, "duration_min_seconds": duration.Seconds(), "seconds": elapsed, "cycles_per_second": float64(len(latencies["claim"])) / elapsed, "summary": summary, "latency_ms": latencies, "locks": locks, "errors": errors, "performance_passed": performancePassed})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("DEPENDENCY_LOAD_RESULT %s", data)
	if len(errors) != 0 || locks.Error != "" || len(latencies["claim"]) < iterations*claimers || len(latencies["enqueue"]) != len(latencies["claim"]) || (writers > 0 && (len(latencies["title_write"]) < iterations || len(latencies["status_write"]) < iterations)) {
		t.Fatal("load did not finish every operation successfully; see result")
	}
	for i, agent := range agents {
		fx := workspaces[i%len(workspaces)].fx
		if completed[i] < iterations+1 || fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE agent_id=$1", agent) != completed[i] || fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE agent_id=$1 AND status='completed' AND dependency_admission->>'consumed_at' IS NOT NULL", agent) != completed[i] {
			t.Fatal("load lost or duplicated an admitted execution, including warmup")
		}
	}
	for writer, count := range written {
		w := workspaces[writer%len(workspaces)]
		issue, err := w.h.Queries.GetIssue(ctx, parseUUID(w.ids[len(w.ids)-1-writer]))
		if err != nil || issue.Revision != beforeWrites[writer].Revision+int64(count) || (writer == 0 && issue.Title != fmt.Sprintf("load edit %d", count-1)) || (writer == 1 && issue.Status != []string{"todo", "done"}[(count-1)%2]) {
			t.Fatal("load lost an acknowledged issue write")
		}
	}
	if os.Getenv("DEPENDENCY_LOAD_ENFORCE_SLO") == "1" && !performancePassed {
		t.Error("OL-45 latency budget exceeded; see result")
	}
}

type dependencyLoadLocks struct {
	Samples           int                  `json:"samples"`
	WaitingSamples    int                  `json:"waiting_samples"`
	MaxWaiters        int                  `json:"max_waiters"`
	MaxObservedWaitMS float64              `json:"max_observed_wait_ms"`
	Error             string               `json:"error,omitempty"`
	Waits             []dependencyLoadWait `json:"waits"`
}

type dependencyLoadWait struct {
	ElapsedMS float64         `json:"elapsed_ms"`
	Details   json.RawMessage `json:"details"`
}

func sampleDependencyLoadLocks(ctx context.Context) dependencyLoadLocks {
	var result dependencyLoadLocks
	started := time.Now()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return result
		case <-ticker.C:
			var waiters int
			var waitMS float64
			var details []byte
			err := testPool.QueryRow(ctx, `SELECT count(DISTINCT l.pid), COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-l.waitstart)*1000),0)::float8,
				COALESCE(jsonb_agg(jsonb_build_object('pid',l.pid,'locktype',l.locktype,'statement',split_part(a.query,E'\n',1),'wait_ms',EXTRACT(EPOCH FROM clock_timestamp()-l.waitstart)*1000,'blockers',pg_blocking_pids(l.pid))),'[]'::jsonb)
				FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
				WHERE NOT l.granted AND a.datname=current_database() AND l.pid<>pg_backend_pid()`).Scan(&waiters, &waitMS, &details)
			if err != nil {
				if ctx.Err() == nil {
					result.Error = err.Error()
				}
				return result
			}
			result.Samples++
			if waiters > 0 {
				result.WaitingSamples++
				result.Waits = append(result.Waits, dependencyLoadWait{ElapsedMS: float64(time.Since(started)) / float64(time.Millisecond), Details: details})
			}
			result.MaxWaiters = max(result.MaxWaiters, waiters)
			result.MaxObservedWaitMS = max(result.MaxObservedWaitMS, waitMS)
		}
	}
}
