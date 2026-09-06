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

func TestHostMetricsPublishTracker(t *testing.T) {
	t.Parallel()
	tracker := newHostMetricsPublishTracker()
	now := time.Now()

	// First content for a machine publishes immediately.
	if !tracker.shouldPublish("ws:d", "10|68", now) {
		t.Fatal("first publish suppressed")
	}
	// Same content is never re-announced.
	if tracker.shouldPublish("ws:d", "10|68", now.Add(time.Hour)) {
		t.Fatal("unchanged content re-announced")
	}
	// A change inside the window is deferred (not dropped — see below).
	if tracker.shouldPublish("ws:d", "95|68", now.Add(hostMetricsPublishMinInterval-time.Second)) {
		t.Fatal("change inside the interval allowed")
	}
	// A different machine is independent.
	if !tracker.shouldPublish("ws:other", "95|68", now.Add(time.Second)) {
		t.Fatal("other machine suppressed by first machine's publish")
	}
	// The deferred change is re-offered by the next beat after the window
	// and publishes then — the latest content is never lost. The boundary
	// itself counts as past the window (jitter at exactly 15s must fire).
	if !tracker.shouldPublish("ws:d", "95|68", now.Add(hostMetricsPublishMinInterval)) {
		t.Fatal("deferred change not re-published at the window boundary")
	}
	// After the re-publish, the tracker holds the new content.
	if tracker.shouldPublish("ws:d", "95|68", now.Add(time.Hour)) {
		t.Fatal("content re-announced after the deferred publish")
	}

	// Idle entries are swept on use so the map stays bounded.
	tracker.machines["ws:ancient"] = hostMetricsMachinePublication{publishedAt: now.Add(-2 * time.Hour), publishedKey: "1|1"}
	tracker.shouldPublish("ws:d", "95|68", now.Add(time.Hour))
	if _, ok := tracker.machines["ws:ancient"]; ok {
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
	// keys carries the stored-content key returned alongside each result;
	// when shorter than results (or empty), the key is derived from the
	// beat's own sample, mirroring the real store's contract.
	keys []string
	err  error
}

func (f *fakeMachineMetricsStore) Available() bool { return f.available }

func (f *fakeMachineMetricsStore) PutIfNewer(_ context.Context, ref MachineRef, m *protocol.HostMetrics) (MachineMetricsPutResult, string, error) {
	f.calls = append(f.calls, ref)
	if f.err != nil {
		return MachineMetricsDropped, "", f.err
	}
	key := fakeStoreContentKey(m)
	if len(f.keys) > 0 {
		key = f.keys[0]
		f.keys = f.keys[1:]
	}
	if len(f.results) == 0 {
		return MachineMetricsChanged, key, nil
	}
	result := f.results[0]
	f.results = f.results[1:]
	return result, key, nil
}

// fakeStoreContentKey derives the rounded content key the real store would
// report for a sample it holds.
func fakeStoreContentKey(m *protocol.HostMetrics) string {
	round := func(p *float64) string {
		if p == nil {
			return "-"
		}
		return fmt.Sprintf("%d", int(*p+0.5))
	}
	return round(m.CPUPercent) + "|" + round(m.MemoryPercent)
}

func (f *fakeMachineMetricsStore) GetBatch(_ context.Context, _ []MachineRef) map[MachineRef]*protocol.HostMetrics {
	return nil
}

// TestStoreHeartbeatMetrics pins the non-fatal contract and the broadcast
// rule: invalid input, missing daemon id, unavailable store, and backend
// errors are all swallowed; a broadcast fires when the machine's rounded
// content differs from the last announcement, throttled per machine with
// deferred re-delivery of the latest change.
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
			hostMetricsPublish:  newHostMetricsPublishTracker(),
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

	// The S1a regression: CPU 10% publishes at t0; CPU 95% lands at t0+14.9s
	// (inside the throttle window) and must NOT be lost — and the sampler
	// then stops, so the beats at t0+30s / t0+45s re-send the SAME last
	// sample (same captured_at; the store reports Dropped with the stored
	// key). The deferred change must be delivered on the first of those
	// re-send beats, without any new sample ever being produced.
	t.Run("throttled change is redelivered on re-sent last sample", func(t *testing.T) {
		last := hostMetricsSample(f64(95), f64(68), now.Unix()+14) // the final sample, captured at t0+14.9s
		store := &fakeMachineMetricsStore{available: true, results: []MachineMetricsPutResult{
			MachineMetricsChanged, // t0: 10% stored
			MachineMetricsChanged, // t0+14.9s: 95% stored, publish throttled
			MachineMetricsDropped, // t0+30s: same captured_at re-send — no write
			MachineMetricsDropped, // t0+45s: same again
		}}
		h, published := newHandler(store)
		ctx := context.Background()

		h.storeHeartbeatMetricsAt(ctx, "ws", "d", hostMetricsSample(f64(10), f64(68), now.Unix()), now)
		h.storeHeartbeatMetricsAt(ctx, "ws", "d", last, now.Add(14*time.Second+900*time.Millisecond))
		if len(*published) != 1 {
			t.Fatalf("published after throttled change = %v, want only the first", *published)
		}
		// The sampler has stopped: the same last sample rides the next beats.
		h.storeHeartbeatMetricsAt(ctx, "ws", "d", last, now.Add(30*time.Second))
		if len(*published) != 2 {
			t.Fatalf("deferred change not redelivered on the re-sent beat: published = %v", *published)
		}
		h.storeHeartbeatMetricsAt(ctx, "ws", "d", last, now.Add(45*time.Second))
		if len(*published) != 2 {
			t.Fatalf("published after second re-send = %v, want still two", *published)
		}
		for _, eventType := range *published {
			if eventType != protocol.EventRuntimeTelemetryUpdated {
				t.Fatalf("published event = %v, want %s", eventType, protocol.EventRuntimeTelemetryUpdated)
			}
		}
	})

	// Out-of-order protection: an older beat arriving after a newer sample
	// was stored and announced must not re-announce the stored content (it
	// equals the last broadcast) nor publish the beat's own stale content.
	t.Run("out-of-order beat never drives the broadcast", func(t *testing.T) {
		store := &fakeMachineMetricsStore{available: true, results: []MachineMetricsPutResult{
			MachineMetricsChanged, // t0: 95% stored and published
			MachineMetricsDropped, // t0+20s: delayed 10% beat (older captured_at)
		}, keys: []string{
			"", // first call derives the key from the sample itself: 95|68
			"95|68", // Dropped beat reports the stored (newer) content
		}}
		h, published := newHandler(store)
		ctx := context.Background()

		h.storeHeartbeatMetricsAt(ctx, "ws", "d", hostMetricsSample(f64(95), f64(68), now.Unix()), now)
		h.storeHeartbeatMetricsAt(ctx, "ws", "d", hostMetricsSample(f64(10), f64(68), now.Unix()-60), now.Add(20*time.Second))
		if len(*published) != 1 {
			t.Fatalf("published = %v, want only the initial broadcast", *published)
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

// hostMetricsRuntime inserts a runtime row on a specific daemon id so one
// daemon can host several runtimes in a test. The provider varies per call
// because (workspace_id, daemon_id, provider) is unique.
func hostMetricsRuntime(t *testing.T, daemonID, name string) string {
	t.Helper()
	return dbfx.Runtime(t, name, testutil.Cols{
		"daemon_id":    daemonID,
		"runtime_mode": "local",
		"provider":     fmt.Sprintf("metrics-provider-%d", time.Now().UnixNano()),
		"device_info":  "Host Metrics Test",
	})
}

// newHostMetricsTestHandler returns a shallow copy of the shared test
// handler wired to a real Redis machine-metrics store plus an event capture.
func newHostMetricsTestHandler(t *testing.T) (*Handler, *[]string) {
	t.Helper()
	rdb := newRedisTestClient(t)
	h := *testHandler
	h.MachineMetricsStore = NewRedisMachineMetricsStore(rdb)
	h.hostMetricsPublish = newHostMetricsPublishTracker()
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
		runtimeID := hostMetricsRuntime(t, daemonID, "metrics-runtime-a")

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
			runtimeIDs[i] = hostMetricsRuntime(t, daemonID, fmt.Sprintf("metrics-runtime-%c", 'a'+i))
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
		runtimeID := hostMetricsRuntime(t, daemonID, "metrics-runtime-bad")

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
	runtimeID := hostMetricsRuntime(t, daemonID, "metrics-ws-runtime")
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
	freshRuntime := hostMetricsRuntime(t, freshDaemon, "metrics-list-fresh")
	staleRuntime := hostMetricsRuntime(t, staleDaemon, "metrics-list-stale")
	quietRuntime := hostMetricsRuntime(t, quietDaemon, "metrics-list-quiet")

	// Fresh and stale samples land directly in the store; a foreign
	// workspace's sample on a colliding daemon id must not leak in.
	if _, _, err := h.MachineMetricsStore.PutIfNewer(context.Background(),
		MachineRef{WorkspaceID: testWorkspaceID, DaemonID: freshDaemon},
		hostMetricsSample(f64(42), f64(68), now.Unix())); err != nil {
		t.Fatalf("seed fresh: %v", err)
	}
	if _, _, err := h.MachineMetricsStore.PutIfNewer(context.Background(),
		MachineRef{WorkspaceID: testWorkspaceID, DaemonID: staleDaemon},
		hostMetricsSample(f64(7), nil, now.Add(-time.Minute).Unix())); err != nil {
		t.Fatalf("seed stale: %v", err)
	}
	if _, _, err := h.MachineMetricsStore.PutIfNewer(context.Background(),
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
