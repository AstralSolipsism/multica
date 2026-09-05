package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemonws"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestValidateHostMetrics(t *testing.T) {
	t.Parallel()
	now := time.Now()

	t.Run("nil percents and real zeros accepted", func(t *testing.T) {
		t.Parallel()
		if err := validateHostMetrics(hostMetricsSample(nil, nil, now.Unix()), now); err != nil {
			t.Fatalf("nil percents: %v", err)
		}
		if err := validateHostMetrics(hostMetricsSample(f64(0), f64(0), now.Unix()), now); err != nil {
			t.Fatalf("real zeros: %v", err)
		}
	})

	t.Run("percentage out of range", func(t *testing.T) {
		t.Parallel()
		if err := validateHostMetrics(hostMetricsSample(f64(-1), nil, now.Unix()), now); err == nil {
			t.Fatal("negative cpu accepted")
		}
		if err := validateHostMetrics(hostMetricsSample(nil, f64(101), now.Unix()), now); err == nil {
			t.Fatal("over-100 memory accepted")
		}
	})

	t.Run("captured_at required and future-bounded", func(t *testing.T) {
		t.Parallel()
		if err := validateHostMetrics(hostMetricsSample(nil, nil, 0), now); err == nil {
			t.Fatal("missing captured_at accepted")
		}
		if err := validateHostMetrics(hostMetricsSample(nil, nil, now.Add(hostMetricsMaxFutureSkew).Unix()), now); err != nil {
			t.Fatalf("boundary skew rejected: %v", err)
		}
		if err := validateHostMetrics(hostMetricsSample(nil, nil, now.Add(hostMetricsMaxFutureSkew+time.Minute).Unix()), now); err == nil {
			t.Fatal("far-future captured_at accepted")
		}
	})
}

func TestHostMetricsPublishThrottle(t *testing.T) {
	t.Parallel()
	throttle := newHostMetricsPublishThrottle()
	now := time.Now()

	if !throttle.allow("ws:d", now) {
		t.Fatal("first publish suppressed")
	}
	if throttle.allow("ws:d", now.Add(hostMetricsPublishMinInterval-time.Second)) {
		t.Fatal("second publish inside the interval allowed")
	}
	if throttle.allow("ws:other", now.Add(time.Second)) {
		// different machine is independent
	} else {
		t.Fatal("other machine suppressed by first machine's publish")
	}
	if !throttle.allow("ws:d", now.Add(hostMetricsPublishMinInterval)) {
		t.Fatal("publish after the interval suppressed")
	}

	// Idle entries are swept on use so the map stays bounded.
	throttle.last["ws:ancient"] = now.Add(-2 * time.Hour)
	throttle.allow("ws:d", now.Add(hostMetricsPublishMinInterval+time.Second))
	if _, ok := throttle.last["ws:ancient"]; ok {
		t.Fatal("idle entry survived a sweep")
	}
}

// fakeMachineMetricsStore records PutIfNewer calls and returns programmed
// results, so handler-level tests can assert write/publish fan-out without a
// Redis round trip.
type fakeMachineMetricsStore struct {
	available bool
	calls     []MachineRef
	results   []MachineMetricsPutResult
	err       error
}

func (f *fakeMachineMetricsStore) Available() bool { return f.available }

func (f *fakeMachineMetricsStore) PutIfNewer(_ context.Context, ref MachineRef, _ *protocol.HostMetrics) (MachineMetricsPutResult, error) {
	f.calls = append(f.calls, ref)
	if f.err != nil {
		return MachineMetricsDropped, f.err
	}
	if len(f.results) == 0 {
		return MachineMetricsChanged, nil
	}
	result := f.results[0]
	f.results = f.results[1:]
	return result, nil
}

func (f *fakeMachineMetricsStore) GetBatch(_ context.Context, _ []MachineRef) map[MachineRef]*protocol.HostMetrics {
	return nil
}

// TestStoreHeartbeatMetrics pins the non-fatal contract and the broadcast
// rule: invalid input, missing daemon id, unavailable store, and backend
// errors are all swallowed; a broadcast fires only on a content change and
// is throttled per machine.
func TestStoreHeartbeatMetrics(t *testing.T) {
	t.Parallel()
	now := time.Now()

	newHandler := func(store MachineMetricsStore) (*Handler, *[]string) {
		bus := events.New()
		var published []string
		bus.SubscribeAll(func(event events.Event) { published = append(published, event.Type) })
		return &Handler{
			Bus:                 bus,
			MachineMetricsStore: store,
			hostMetricsPublish:  newHostMetricsPublishThrottle(),
		}, &published
	}

	t.Run("nil metrics and empty daemon id skip the store", func(t *testing.T) {
		store := &fakeMachineMetricsStore{available: true}
		h, _ := newHandler(store)
		h.storeHeartbeatMetrics(context.Background(), "ws", "d", nil)
		h.storeHeartbeatMetrics(context.Background(), "ws", "", hostMetricsSample(f64(1), nil, now.Unix()))
		if len(store.calls) != 0 {
			t.Fatalf("store calls = %v, want none", store.calls)
		}
	})

	t.Run("unavailable store skips silently", func(t *testing.T) {
		store := &fakeMachineMetricsStore{available: false}
		h, published := newHandler(store)
		h.storeHeartbeatMetrics(context.Background(), "ws", "d", hostMetricsSample(f64(1), nil, now.Unix()))
		if len(store.calls) != 0 || len(*published) != 0 {
			t.Fatalf("calls = %v, published = %v; want none", store.calls, *published)
		}
	})

	t.Run("invalid sample dropped", func(t *testing.T) {
		store := &fakeMachineMetricsStore{available: true}
		h, published := newHandler(store)
		h.storeHeartbeatMetrics(context.Background(), "ws", "d", hostMetricsSample(f64(101), nil, now.Unix()))
		h.storeHeartbeatMetrics(context.Background(), "ws", "d", hostMetricsSample(f64(1), nil, 0))
		h.storeHeartbeatMetrics(context.Background(), "ws", "d", hostMetricsSample(f64(1), nil, now.Add(time.Hour).Unix()))
		if len(store.calls) != 0 || len(*published) != 0 {
			t.Fatalf("calls = %v, published = %v; want none", store.calls, *published)
		}
	})

	t.Run("content change broadcasts once per interval", func(t *testing.T) {
		store := &fakeMachineMetricsStore{available: true, results: []MachineMetricsPutResult{
			MachineMetricsChanged, MachineMetricsChanged, MachineMetricsRefreshed, MachineMetricsDropped,
		}}
		h, published := newHandler(store)
		for i := 0; i < 4; i++ {
			h.storeHeartbeatMetrics(context.Background(), "ws", "d", hostMetricsSample(f64(float64(i)), nil, now.Unix()+int64(i)))
		}
		if len(store.calls) != 4 {
			t.Fatalf("store calls = %v, want 4", store.calls)
		}
		if len(*published) != 1 || (*published)[0] != protocol.EventRuntimeTelemetryUpdated {
			t.Fatalf("published = %v, want one %s", *published, protocol.EventRuntimeTelemetryUpdated)
		}
	})

	t.Run("store error is swallowed", func(t *testing.T) {
		store := &fakeMachineMetricsStore{available: true, err: fmt.Errorf("redis down")}
		h, published := newHandler(store)
		h.storeHeartbeatMetrics(context.Background(), "ws", "d", hostMetricsSample(f64(1), nil, now.Unix()))
		if len(*published) != 0 {
			t.Fatalf("published = %v, want none", *published)
		}
	})
}

// createHostMetricsTestRuntime inserts a runtime row on a specific daemon id
// so one daemon can host several runtimes in a test. The provider varies per
// call because (workspace_id, daemon_id, provider) is unique.
func createHostMetricsTestRuntime(t *testing.T, ownerID, daemonID, name string) string {
	t.Helper()
	var runtimeID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent_runtime (
			workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, owner_id, last_seen_at
		)
		VALUES ($1, $2, $3, 'local', $5, 'online', 'Host Metrics Test', '{}'::jsonb, $4, now())
		RETURNING id
	`, testWorkspaceID, daemonID, name, ownerID, fmt.Sprintf("provider-%d", time.Now().UnixNano())).Scan(&runtimeID); err != nil {
		t.Fatalf("create host metrics runtime: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
	})
	return runtimeID
}

// newHostMetricsTestHandler returns a shallow copy of the shared test
// handler wired to a real Redis machine-metrics store plus an event capture.
func newHostMetricsTestHandler(t *testing.T) (*Handler, *[]string) {
	t.Helper()
	rdb := newRedisTestClient(t)
	h := *testHandler
	h.MachineMetricsStore = NewRedisMachineMetricsStore(rdb)
	h.hostMetricsPublish = newHostMetricsPublishThrottle()
	bus := events.New()
	var published []string
	bus.SubscribeAll(func(event events.Event) { published = append(published, event.Type) })
	h.Bus = bus
	return &h, &published
}

func heartbeatMetricsBody(runtimeID string, cpu float64, capturedAt int64) map[string]any {
	return map[string]any{
		"runtime_id": runtimeID,
		"metrics": map[string]any{
			"cpu_percent":    cpu,
			"memory_percent": 68,
			"captured_at":    capturedAt,
		},
	}
}

// TestDaemonHeartbeatMetrics covers the HTTP heartbeat path: the sample is
// stored under (workspace, daemon) from the runtime row, N runtimes of one
// daemon produce exactly one write and one broadcast per cycle, and a bad
// payload drops the field while the beat is still acked.
func TestDaemonHeartbeatMetrics(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	now := time.Now().Unix()

	t.Run("stored under the runtime row's workspace and daemon", func(t *testing.T) {
		h, published := newHostMetricsTestHandler(t)
		daemonID := fmt.Sprintf("metrics-daemon-%d", time.Now().UnixNano())
		runtimeID := createHostMetricsTestRuntime(t, testUserID, daemonID, "metrics-runtime-a")

		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat",
			heartbeatMetricsBody(runtimeID, 42, now), testWorkspaceID, daemonID)
		testutil.Call(t, h.DaemonHeartbeat, req).Want(http.StatusOK)

		got := h.MachineMetricsStore.GetBatch(context.Background(),
			[]MachineRef{{WorkspaceID: testWorkspaceID, DaemonID: daemonID}})
		sample := got[MachineRef{WorkspaceID: testWorkspaceID, DaemonID: daemonID}]
		if sample == nil || sample.CPUPercent == nil || *sample.CPUPercent != 42 {
			t.Fatalf("stored sample = %+v", sample)
		}
		if len(*published) != 1 || (*published)[0] != protocol.EventRuntimeTelemetryUpdated {
			t.Fatalf("published = %v, want one %s", *published, protocol.EventRuntimeTelemetryUpdated)
		}
	})

	t.Run("three runtimes of one daemon write once per cycle", func(t *testing.T) {
		h, published := newHostMetricsTestHandler(t)
		daemonID := fmt.Sprintf("metrics-daemon-%d", time.Now().UnixNano())
		runtimeIDs := make([]string, 3)
		for i := range runtimeIDs {
			runtimeIDs[i] = createHostMetricsTestRuntime(t, testUserID, daemonID, fmt.Sprintf("metrics-runtime-%c", 'a'+i))
		}

		// Every runtime heartbeats with the same sampler output (same
		// captured_at): the first beat writes, the rest are no-ops.
		for _, runtimeID := range runtimeIDs {
			req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat",
				heartbeatMetricsBody(runtimeID, 42, now), testWorkspaceID, daemonID)
			testutil.Call(t, h.DaemonHeartbeat, req).Want(http.StatusOK)
		}
		if len(*published) != 1 {
			t.Fatalf("published = %v, want exactly one broadcast for the cycle", *published)
		}

		// Next cycle with unchanged rounded content: still no broadcast.
		for _, runtimeID := range runtimeIDs {
			req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat",
				heartbeatMetricsBody(runtimeID, 42.4, now+15), testWorkspaceID, daemonID)
			testutil.Call(t, h.DaemonHeartbeat, req).Want(http.StatusOK)
		}
		got := h.MachineMetricsStore.GetBatch(context.Background(),
			[]MachineRef{{WorkspaceID: testWorkspaceID, DaemonID: daemonID}})
		if sample := got[MachineRef{WorkspaceID: testWorkspaceID, DaemonID: daemonID}]; sample == nil || sample.CapturedAt != now+15 {
			t.Fatalf("sample after refresh = %+v, want captured_at %d", sample, now+15)
		}
		if len(*published) != 1 {
			t.Fatalf("published after freshness refresh = %v, want still one", *published)
		}
	})

	t.Run("invalid metrics dropped, beat still acked", func(t *testing.T) {
		h, _ := newHostMetricsTestHandler(t)
		daemonID := fmt.Sprintf("metrics-daemon-%d", time.Now().UnixNano())
		runtimeID := createHostMetricsTestRuntime(t, testUserID, daemonID, "metrics-runtime-bad")

		for _, metrics := range []map[string]any{
			{"cpu_percent": 101, "captured_at": now},
			{"cpu_percent": 42},                            // missing captured_at
			{"cpu_percent": 42, "captured_at": now + 7200}, // far future
		} {
			req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat",
				map[string]any{"runtime_id": runtimeID, "metrics": metrics}, testWorkspaceID, daemonID)
			testutil.Call(t, h.DaemonHeartbeat, req).Want(http.StatusOK)
		}
		got := h.MachineMetricsStore.GetBatch(context.Background(),
			[]MachineRef{{WorkspaceID: testWorkspaceID, DaemonID: daemonID}})
		if len(got) != 0 {
			t.Fatalf("invalid metrics stored: %v", got)
		}
	})
}

// TestHandleDaemonWSHeartbeatMetrics covers the WebSocket twin: the machine
// is keyed by the lease's workspace plus the runtime row's daemon id — the
// connection's authenticated identity carries no daemon id when the daemon
// heartbeats with a user PAT, which is the common case.
func TestHandleDaemonWSHeartbeatMetrics(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h, published := newHostMetricsTestHandler(t)

	daemonID := fmt.Sprintf("metrics-ws-daemon-%d", time.Now().UnixNano())
	runtimeID := createHostMetricsTestRuntime(t, testUserID, daemonID, "metrics-ws-runtime")
	identity := daemonws.ClientIdentity{
		WorkspaceID: testWorkspaceID,
		// DaemonID intentionally empty: user-PAT daemon connections.
		RuntimeLeases: map[string]*daemonws.RuntimeLease{
			runtimeID: daemonws.NewRuntimeLease(testWorkspaceID, "online", time.Now(), true).WithDaemonID(daemonID),
		},
	}
	cpu := 55.0
	payload := protocol.DaemonHeartbeatRequestPayload{
		RuntimeID: runtimeID,
		Metrics:   hostMetricsSample(&cpu, nil, time.Now().Unix()),
	}
	ack, err := h.HandleDaemonWSHeartbeat(context.Background(), identity, payload)
	if err != nil {
		t.Fatalf("HandleDaemonWSHeartbeat: %v", err)
	}
	if ack == nil || ack.Status != "ok" {
		t.Fatalf("ack = %+v", ack)
	}

	got := h.MachineMetricsStore.GetBatch(context.Background(),
		[]MachineRef{{WorkspaceID: testWorkspaceID, DaemonID: daemonID}})
	sample := got[MachineRef{WorkspaceID: testWorkspaceID, DaemonID: daemonID}]
	if sample == nil || sample.CPUPercent == nil || *sample.CPUPercent != 55 {
		t.Fatalf("stored sample = %+v", sample)
	}
	if len(*published) != 1 || (*published)[0] != protocol.EventRuntimeTelemetryUpdated {
		t.Fatalf("published = %v, want one %s", *published, protocol.EventRuntimeTelemetryUpdated)
	}
}

// TestListAgentRuntimesSystemStats covers the read side: fresh vs stale
// samples, runtimes without a daemon id, and machines with nothing
// reported.
func TestListAgentRuntimesSystemStats(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h, _ := newHostMetricsTestHandler(t)
	now := time.Now()

	freshDaemon := fmt.Sprintf("metrics-list-fresh-%d", now.UnixNano())
	staleDaemon := fmt.Sprintf("metrics-list-stale-%d", now.UnixNano())
	quietDaemon := fmt.Sprintf("metrics-list-quiet-%d", now.UnixNano())
	freshRuntime := createHostMetricsTestRuntime(t, testUserID, freshDaemon, "metrics-list-fresh")
	staleRuntime := createHostMetricsTestRuntime(t, testUserID, staleDaemon, "metrics-list-stale")
	quietRuntime := createHostMetricsTestRuntime(t, testUserID, quietDaemon, "metrics-list-quiet")

	// Fresh and stale samples land directly in the store; a foreign
	// workspace's sample on a colliding daemon id must not leak in.
	if _, err := h.MachineMetricsStore.PutIfNewer(context.Background(),
		MachineRef{WorkspaceID: testWorkspaceID, DaemonID: freshDaemon},
		hostMetricsSample(f64(42), f64(68), now.Unix())); err != nil {
		t.Fatalf("seed fresh: %v", err)
	}
	if _, err := h.MachineMetricsStore.PutIfNewer(context.Background(),
		MachineRef{WorkspaceID: testWorkspaceID, DaemonID: staleDaemon},
		hostMetricsSample(f64(7), nil, now.Add(-time.Minute).Unix())); err != nil {
		t.Fatalf("seed stale: %v", err)
	}
	if _, err := h.MachineMetricsStore.PutIfNewer(context.Background(),
		MachineRef{WorkspaceID: "00000000-0000-0000-0000-000000000000", DaemonID: quietDaemon},
		hostMetricsSample(f64(99), nil, now.Unix())); err != nil {
		t.Fatalf("seed foreign: %v", err)
	}

	w := testutil.Call(t, h.ListAgentRuntimes,
		newRequestAs(testUserID, http.MethodGet, "/api/runtimes", nil),
	).Want(http.StatusOK)
	var runtimes []AgentRuntimeResponse
	w.JSON(&runtimes)

	byID := map[string]AgentRuntimeResponse{}
	for _, rt := range runtimes {
		byID[rt.ID] = rt
	}

	fresh := byID[freshRuntime].SystemStats
	if fresh == nil || fresh.CPUPercent == nil || *fresh.CPUPercent != 42 || fresh.Stale {
		t.Fatalf("fresh runtime system_stats = %+v", fresh)
	}
	stale := byID[staleRuntime].SystemStats
	if stale == nil || !stale.Stale {
		t.Fatalf("stale runtime system_stats = %+v, want stale=true", stale)
	}
	if quiet := byID[quietRuntime].SystemStats; quiet != nil {
		t.Fatalf("quiet runtime system_stats = %+v, want nil (foreign workspace sample must not leak)", quiet)
	}
}
