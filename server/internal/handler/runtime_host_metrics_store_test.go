package handler

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
	"github.com/redis/go-redis/v9"
)

func TestRedisMachineMetricsStoreAcrossClusterSlots(t *testing.T) {
	addrs := os.Getenv("REDIS_TEST_CLUSTER_ADDRS")
	if addrs == "" {
		t.Skip("REDIS_TEST_CLUSTER_ADDRS is not set")
	}
	rdb := redis.NewClusterClient(&redis.ClusterOptions{Addrs: strings.Split(addrs, ",")})
	t.Cleanup(func() { _ = rdb.Close() })
	ctx := context.Background()
	store := NewRedisMachineMetricsStore(rdb)
	workspace := t.Name() + time.Now().Format("150405.000000000")
	refs := []MachineRef{{WorkspaceID: workspace, DaemonID: "{machine-a}"}, {WorkspaceID: workspace, DaemonID: "{machine-b}"}}
	var firstSlot int64
	for i, ref := range refs {
		key := machineMetricsKey(ref)
		slot, err := rdb.ClusterKeySlot(ctx, key).Result()
		if err != nil {
			t.Fatal(err)
		}
		if i > 0 && slot == firstSlot {
			t.Fatal("fixture keys must occupy different Redis cluster slots")
		}
		firstSlot = slot
		t.Cleanup(func() { _ = rdb.Del(context.Background(), key).Err() })
		if _, _, err := store.PutIfNewer(ctx, ref, hostMetricsSample(f64(float64(i+1)), nil, 1000)); err != nil {
			t.Fatal(err)
		}
	}
	got := store.GetBatch(ctx, append(refs, MachineRef{WorkspaceID: workspace, DaemonID: "missing"}))
	if len(got) != 2 {
		t.Fatalf("cross-slot batch lost samples: %+v", got)
	}
	for i, ref := range refs {
		if got[ref] == nil || got[ref].CPUPercent == nil || *got[ref].CPUPercent != float64(i+1) {
			t.Fatalf("wrong sample for %v: %+v", ref, got[ref])
		}
	}
}

func hostMetricsSample(cpu, mem *float64, capturedAt int64) *protocol.HostMetrics {
	return &protocol.HostMetrics{CPUPercent: cpu, MemoryPercent: mem, CapturedAt: capturedAt}
}

func f64(v float64) *float64 { return &v }

// TestRedisMachineMetricsStorePutIfNewer pins the one-write-per-cycle
// contract: the daemon's N runtime heartbeats all carry the same sample,
// and only the first one (strictly newer captured_at) may write.
func TestRedisMachineMetricsStorePutIfNewer(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()
	ref := MachineRef{WorkspaceID: "ws-1", DaemonID: "daemon-a"}

	if !store.Available() {
		t.Fatal("store with a live client reports unavailable")
	}

	// First write lands and counts as a content change.
	result, key, err := store.PutIfNewer(ctx, ref, hostMetricsSample(f64(42.1), f64(68), 1000))
	if err != nil || result != MachineMetricsChanged {
		t.Fatalf("first put = %v, %v; want changed", result, err)
	}
	if key != "42|68" {
		t.Fatalf("first put key = %q, want 42|68", key)
	}

	// Same captured_at (the other N-1 heartbeats of the cycle): no write.
	result, key, err = store.PutIfNewer(ctx, ref, hostMetricsSample(f64(42.1), f64(68), 1000))
	if err != nil || result != MachineMetricsDropped {
		t.Fatalf("same captured_at put = %v, %v; want dropped", result, err)
	}
	// A no-op beat still reports the stored content key so a deferred
	// broadcast can be re-offered against the stored truth.
	if key != "42|68" {
		t.Fatalf("dropped put key = %q, want stored 42|68", key)
	}

	// Older captured_at (out-of-order beat): no write.
	result, key, err = store.PutIfNewer(ctx, ref, hostMetricsSample(f64(99), f64(99), 999))
	if err != nil || result != MachineMetricsDropped {
		t.Fatalf("older put = %v, %v; want dropped", result, err)
	}
	// An out-of-order beat must not report its own (older) content.
	if key != "42|68" {
		t.Fatalf("out-of-order put key = %q, want stored 42|68", key)
	}

	// Newer sample whose rounded content matches: freshness refresh only.
	result, key, err = store.PutIfNewer(ctx, ref, hostMetricsSample(f64(42.4), f64(68.2), 1015))
	if err != nil || result != MachineMetricsRefreshed {
		t.Fatalf("same-content put = %v, %v; want refreshed", result, err)
	}
	if key != "42|68" {
		t.Fatalf("refreshed put key = %q, want 42|68", key)
	}

	// Newer sample with a changed rounded percentage: content change.
	result, key, err = store.PutIfNewer(ctx, ref, hostMetricsSample(f64(43.6), f64(68.2), 1030))
	if err != nil || result != MachineMetricsChanged {
		t.Fatalf("changed put = %v, %v; want changed", result, err)
	}
	if key != "44|68" {
		t.Fatalf("changed put key = %q, want 44|68", key)
	}

	// A metric appearing/disappearing (nil <-> value) is a content change.
	result, key, err = store.PutIfNewer(ctx, ref, hostMetricsSample(nil, f64(68), 1045))
	if err != nil || result != MachineMetricsChanged {
		t.Fatalf("cpu->nil put = %v, %v; want changed", result, err)
	}
	if key != "-|68" {
		t.Fatalf("cpu->nil put key = %q, want -|68", key)
	}

	// The stored value is the newest sample, with a real TTL.
	got := store.GetBatch(ctx, []MachineRef{ref})
	sample := got[ref]
	if sample == nil || sample.CapturedAt != 1045 || sample.CPUPercent != nil ||
		sample.MemoryPercent == nil || *sample.MemoryPercent != 68 {
		t.Fatalf("stored sample = %+v", sample)
	}
	ttl, err := rdb.TTL(ctx, machineMetricsKey(ref)).Result()
	if err != nil || ttl <= 0 || ttl > machineMetricsTTL {
		t.Fatalf("ttl = %v, %v; want within (0, %v]", ttl, err, machineMetricsTTL)
	}
}

// TestRedisMachineMetricsStoreWorkspaceIsolation pins the review red line:
// daemon ids are machine-provided strings that can collide across
// workspaces, so the same daemon id in two workspaces must never share a
// sample.
func TestRedisMachineMetricsStoreWorkspaceIsolation(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()

	ws1 := MachineRef{WorkspaceID: "ws-1", DaemonID: "shared-daemon-id"}
	ws2 := MachineRef{WorkspaceID: "ws-2", DaemonID: "shared-daemon-id"}

	if _, _, err := store.PutIfNewer(ctx, ws1, hostMetricsSample(f64(42), nil, 1000)); err != nil {
		t.Fatalf("put ws1: %v", err)
	}
	if _, _, err := store.PutIfNewer(ctx, ws2, hostMetricsSample(f64(7), nil, 1000)); err != nil {
		t.Fatalf("put ws2: %v", err)
	}

	got := store.GetBatch(ctx, []MachineRef{ws1, ws2, {WorkspaceID: "ws-3", DaemonID: "shared-daemon-id"}})
	if len(got) != 2 {
		t.Fatalf("GetBatch returned %d entries, want 2: %v", len(got), got)
	}
	if got[ws1].CPUPercent == nil || *got[ws1].CPUPercent != 42 {
		t.Fatalf("ws1 sample = %+v, want cpu 42", got[ws1])
	}
	if got[ws2].CPUPercent == nil || *got[ws2].CPUPercent != 7 {
		t.Fatalf("ws2 sample = %+v, want cpu 7", got[ws2])
	}

	// A newer sample in ws2 must not disturb ws1's value.
	if _, _, err := store.PutIfNewer(ctx, ws2, hostMetricsSample(f64(8), nil, 1015)); err != nil {
		t.Fatalf("put ws2 newer: %v", err)
	}
	got = store.GetBatch(ctx, []MachineRef{ws1})
	if got[ws1].CPUPercent == nil || *got[ws1].CPUPercent != 42 {
		t.Fatalf("ws1 sample after ws2 write = %+v, want cpu 42", got[ws1])
	}
}

// TestRedisMachineMetricsStoreCorruptValue: one malformed payload must not
// wedge the key until TTL — the next put treats it as absent.
func TestRedisMachineMetricsStoreCorruptValue(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()
	ref := MachineRef{WorkspaceID: "ws-1", DaemonID: "daemon-a"}

	if err := rdb.Set(ctx, machineMetricsKey(ref), "not-json", machineMetricsTTL).Err(); err != nil {
		t.Fatalf("seed corrupt value: %v", err)
	}
	result, key, err := store.PutIfNewer(ctx, ref, hostMetricsSample(f64(42), nil, 1000))
	if err != nil || result != MachineMetricsChanged {
		t.Fatalf("put over corrupt = %v, %v; want changed", result, err)
	}
	// A corrupt stored value is treated as absent and overwritten.
	if key != "42|-" {
		t.Fatalf("put over corrupt key = %q, want 42|-", key)
	}
	if got := store.GetBatch(ctx, []MachineRef{ref})[ref]; got == nil || got.CapturedAt != 1000 {
		t.Fatalf("sample after overwrite = %+v", got)
	}
}

// TestRedisMachineMetricsStoreDegradesOnError: a backend failure degrades to
// "no data" — GetBatch returns an empty map rather than failing the list.
func TestRedisMachineMetricsStoreDegradesOnError(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ref := MachineRef{WorkspaceID: "ws-1", DaemonID: "daemon-a"}
	if _, _, err := store.PutIfNewer(context.Background(), ref, hostMetricsSample(f64(42), nil, 1000)); err != nil {
		t.Fatalf("put: %v", err)
	}
	rdb.Close()

	if got := store.GetBatch(context.Background(), []MachineRef{ref}); len(got) != 0 {
		t.Fatalf("GetBatch on dead backend returned %v, want empty", got)
	}
}

func TestMachineMetricsStoreInputValidation(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()

	if _, _, err := store.PutIfNewer(ctx, MachineRef{WorkspaceID: "", DaemonID: "d"}, hostMetricsSample(nil, nil, 1)); err == nil {
		t.Fatal("empty workspace id accepted")
	}
	if _, _, err := store.PutIfNewer(ctx, MachineRef{WorkspaceID: "w", DaemonID: ""}, hostMetricsSample(nil, nil, 1)); err == nil {
		t.Fatal("empty daemon id accepted")
	}
	if _, _, err := store.PutIfNewer(ctx, MachineRef{WorkspaceID: "w", DaemonID: "d"}, nil); err == nil {
		t.Fatal("nil metrics accepted")
	}
}

func TestNoopMachineMetricsStore(t *testing.T) {
	t.Parallel()
	store := NewNoopMachineMetricsStore()
	if store.Available() {
		t.Fatal("noop store reports available")
	}
	result, key, err := store.PutIfNewer(context.Background(), MachineRef{WorkspaceID: "w", DaemonID: "d"}, hostMetricsSample(f64(1), nil, 1))
	if err != nil || result != MachineMetricsDropped || key != "" {
		t.Fatalf("noop put = %v, %q, %v; want dropped, \"\", nil", result, key, err)
	}
	if got := store.GetBatch(context.Background(), []MachineRef{{WorkspaceID: "w", DaemonID: "d"}}); got != nil {
		t.Fatalf("noop get = %v, want nil", got)
	}
}
