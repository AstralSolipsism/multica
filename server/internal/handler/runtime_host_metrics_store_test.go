package handler

import (
	"context"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Redis-backed MachineMetricsStore tests. Gated on REDIS_TEST_URL with the
// same FlushDB-per-test isolation as the other Redis store suites.

func TestRedisMachineMetricsStorePutGetBatch(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()

	if !store.Available() {
		t.Fatal("store with a live client reports unavailable")
	}

	cpuPercent := 42.0
	memPercent := 68.0
	sample := &protocol.HostMetrics{
		CPUPercent:    &cpuPercent,
		MemoryPercent: &memPercent,
		CapturedAt:    1757000100,
	}
	if err := store.Put(ctx, "daemon-a", sample); err != nil {
		t.Fatalf("Put: %v", err)
	}
	// A second daemon with a distinct sample proves keys are per-daemon.
	otherCPU := 1.0
	if err := store.Put(ctx, "daemon-b", &protocol.HostMetrics{CPUPercent: &otherCPU, CapturedAt: 1757000200}); err != nil {
		t.Fatalf("Put daemon-b: %v", err)
	}

	got := store.GetBatch(ctx, []string{"daemon-a", "daemon-b", "daemon-missing"})
	if len(got) != 2 {
		t.Fatalf("GetBatch returned %d entries, want 2: %v", len(got), got)
	}
	a := got["daemon-a"]
	if a == nil || a.CPUPercent == nil || *a.CPUPercent != 42.0 ||
		a.MemoryPercent == nil || *a.MemoryPercent != 68.0 || a.CapturedAt != 1757000100 {
		t.Fatalf("daemon-a sample = %+v", a)
	}
	b := got["daemon-b"]
	if b == nil || b.CPUPercent == nil || *b.CPUPercent != 1.0 || b.MemoryPercent != nil {
		t.Fatalf("daemon-b sample = %+v", b)
	}
	if _, present := got["daemon-missing"]; present {
		t.Fatal("missing daemon produced an entry")
	}
}

func TestRedisMachineMetricsStoreTTL(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()

	if err := store.Put(ctx, "daemon-ttl", &protocol.HostMetrics{CapturedAt: 1757000100}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	ttl, err := rdb.TTL(ctx, machineMetricsKey("daemon-ttl")).Result()
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	// The key must expire on its own (the daemon may die between beats) —
	// accept anything in (0, machineMetricsTTL].
	if ttl <= 0 || ttl > machineMetricsTTL {
		t.Fatalf("key TTL = %v, want within (0, %v]", ttl, machineMetricsTTL)
	}
}

func TestRedisMachineMetricsStoreSkipsUndecodableValues(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()

	// A corrupt value under a real key must be skipped, not fail the batch.
	if err := rdb.Set(ctx, machineMetricsKey("daemon-corrupt"), "not-json", time.Minute).Err(); err != nil {
		t.Fatalf("seed corrupt value: %v", err)
	}
	if err := store.Put(ctx, "daemon-good", &protocol.HostMetrics{CapturedAt: 1757000100}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got := store.GetBatch(ctx, []string{"daemon-corrupt", "daemon-good"})
	if len(got) != 1 || got["daemon-good"] == nil {
		t.Fatalf("GetBatch = %v, want only daemon-good", got)
	}
}

func TestRedisMachineMetricsStoreGuards(t *testing.T) {
	rdb := newRedisTestClient(t)
	store := NewRedisMachineMetricsStore(rdb)
	ctx := context.Background()

	if err := store.Put(ctx, "", &protocol.HostMetrics{}); err == nil {
		t.Fatal("empty daemon id accepted")
	}
	if err := store.Put(ctx, "daemon-1", nil); err == nil {
		t.Fatal("nil metrics accepted")
	}
	var nilStore *RedisMachineMetricsStore
	if nilStore.Available() {
		t.Fatal("nil store reports available")
	}
	if got := nilStore.GetBatch(ctx, []string{"daemon-1"}); len(got) != 0 {
		t.Fatalf("nil store GetBatch = %v, want empty", got)
	}
}
