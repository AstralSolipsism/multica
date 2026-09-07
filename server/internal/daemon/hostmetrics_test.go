package daemon

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// TestCPUPercentBetween exercises the pure delta math behind the sampler:
// busy share of elapsed CPU time, clamping, and the unusable-delta cases.
// OS-agnostic by construction — no /proc reads involved.
func TestCPUPercentBetween(t *testing.T) {
	t.Parallel()

	prev := cpu.TimesStat{User: 100, System: 50, Idle: 800, Iowait: 50}

	t.Run("half busy", func(t *testing.T) {
		t.Parallel()
		// +100 user, +100 idle over +200 total: 50% busy.
		cur := cpu.TimesStat{User: 200, System: 50, Idle: 900, Iowait: 50}
		got, ok := cpuPercentBetween(prev, cur)
		if !ok {
			t.Fatal("expected usable delta")
		}
		if got != 50 {
			t.Fatalf("percent = %v, want 50", got)
		}
	})

	t.Run("all busy clamps to 100", func(t *testing.T) {
		t.Parallel()
		cur := cpu.TimesStat{User: 300, System: 150, Idle: 800, Iowait: 50}
		got, ok := cpuPercentBetween(prev, cur)
		if !ok {
			t.Fatal("expected usable delta")
		}
		if got != 100 {
			t.Fatalf("percent = %v, want 100", got)
		}
	})

	t.Run("no elapsed time is unusable", func(t *testing.T) {
		t.Parallel()
		if _, ok := cpuPercentBetween(prev, prev); ok {
			t.Fatal("zero delta must be reported unusable")
		}
	})

	t.Run("counter reset is unusable", func(t *testing.T) {
		t.Parallel()
		cur := cpu.TimesStat{User: 1, System: 1, Idle: 1}
		if _, ok := cpuPercentBetween(prev, cur); ok {
			t.Fatal("negative total delta must be reported unusable")
		}
	})

	t.Run("idle regression treated as zero idle", func(t *testing.T) {
		t.Parallel()
		// Idle counter went backwards (should not happen, but stay safe):
		// everything elapsed counts as busy.
		cur := cpu.TimesStat{User: 250, System: 60, Idle: 700, Iowait: 50}
		got, ok := cpuPercentBetween(prev, cur)
		if !ok {
			t.Fatal("expected usable delta")
		}
		if got != 100 {
			t.Fatalf("percent = %v, want 100", got)
		}
	})
}

// TestHostMetricsFreshness pins the attach-only-when-fresh contract: no
// sample, a fresh sample, and an expired sample.
func TestHostMetricsFreshness(t *testing.T) {
	t.Parallel()

	sampler := newHostMetricsSampler(nil)
	if got := sampler.latestFresh(time.Now()); got != nil {
		t.Fatalf("empty sampler returned %+v, want nil", got)
	}

	now := time.Now()
	cpuPercent := 42.0
	memPercent := 68.0
	sampler.latest.Store(&hostMetricsSample{
		metrics: protocol.HostMetrics{
			CPUPercent:    &cpuPercent,
			MemoryPercent: &memPercent,
			CapturedAt:    now.Unix(),
		},
		sampledAt: now,
	})

	fresh := sampler.latestFresh(now.Add(hostMetricsMaxAge - time.Second))
	if fresh == nil {
		t.Fatal("fresh sample withheld")
	}
	if fresh.CPUPercent == nil || *fresh.CPUPercent != 42.0 {
		t.Fatalf("cpu_percent = %v, want 42", fresh.CPUPercent)
	}
	if fresh.MemoryPercent == nil || *fresh.MemoryPercent != 68.0 {
		t.Fatalf("memory_percent = %v, want 68", fresh.MemoryPercent)
	}

	if got := sampler.latestFresh(now.Add(hostMetricsMaxAge)); got != nil {
		t.Fatalf("stale sample returned %+v, want nil", got)
	}
}

// TestPlanQuotaCacheLifecycle pins the daemon-side quota cache: the snapshot
// recorded at task completion rides the next heartbeat, and removing the
// runtime drops the entry so a re-registered runtime starts clean.
func TestPlanQuotaCacheLifecycle(t *testing.T) {
	t.Parallel()

	d := &Daemon{}
	observed := &protocol.RuntimePlanQuota{
		Provider:   "codex",
		Status:     protocol.PlanQuotaStatusOK,
		ObservedAt: time.Now().Unix(),
		Source:     protocol.PlanQuotaSourceDaemon,
	}
	d.recordRuntimePlanQuota("runtime-1", observed)

	extras := d.heartbeatExtrasFor("runtime-1")
	if extras.PlanQuota != observed {
		t.Fatalf("PlanQuota = %+v, want the cached snapshot", extras.PlanQuota)
	}

	// Unknown runtimes carry no quota.
	if got := d.heartbeatExtrasFor("runtime-other").PlanQuota; got != nil {
		t.Fatalf("unknown runtime PlanQuota = %+v, want nil", got)
	}

	// Empty inputs are ignored rather than cached.
	d.recordRuntimePlanQuota("", observed)
	d.recordRuntimePlanQuota("runtime-1", nil)
	if got := d.heartbeatExtrasFor("runtime-1").PlanQuota; got != observed {
		t.Fatalf("nil overwrite changed the cache: %+v", got)
	}

	d.planQuotaCache.Delete("runtime-1")
	if got := d.heartbeatExtrasFor("runtime-1").PlanQuota; got != nil {
		t.Fatalf("deleted runtime PlanQuota = %+v, want nil", got)
	}
}

// TestHostMetricsSamplerConstructedBeforeReaders pins the R3 regression: the
// sampler must exist the moment New returns — before Run launches the
// heartbeat readers that call heartbeatExtrasFor — so no reader can ever
// observe an unassigned d.hostMetrics. The concurrent read loop below is the
// part that trips `go test -race` if the field ever moves back to a late
// assignment inside Run.
func TestHostMetricsSamplerConstructedBeforeReaders(t *testing.T) {
	t.Parallel()

	d := New(Config{WorkspacesRoot: t.TempDir()}, slog.Default())
	if d.hostMetrics == nil {
		t.Fatal("New returned a daemon without a host metrics sampler")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.hostMetrics.run(ctx)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				_ = d.heartbeatExtrasFor("runtime-x")
			}
		}()
	}
	wg.Wait()
}
