package daemon

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// hostMetricsSampleInterval is how often the daemon samples host CPU/memory.
// It matches the default heartbeat cadence so every beat can attach a sample
// that is at most one interval old.
const hostMetricsSampleInterval = 15 * time.Second

// hostMetricsMaxAge is the freshness bound for attaching a sample to a
// heartbeat. Older samples describe a machine state that no longer holds
// (or a sampler that has stopped), so the beat omits the field instead.
const hostMetricsMaxAge = 60 * time.Second

// hostMetricsSample is the sampler's internal snapshot: the wire shape plus
// the wall-clock time it was taken, used for the freshness check.
type hostMetricsSample struct {
	metrics   protocol.HostMetrics
	sampledAt time.Time
}

// hostMetricsSampler periodically records the host's CPU and memory
// utilization. CPU percentage is computed from the delta between successive
// cpu.Times samples kept in the sampler, which avoids the
// first-call-since-boot skew a naive instantaneous read would report. A
// failed sample keeps the previous one; if no sample ever succeeds the
// heartbeat omits the field entirely.
type hostMetricsSampler struct {
	logger *slog.Logger

	latest atomic.Pointer[hostMetricsSample]

	// prevCPU carries the last raw counters between ticks. Only the sampler
	// goroutine touches it, so it needs no synchronization.
	prevCPU    cpu.TimesStat
	prevCPUSet bool
}

func newHostMetricsSampler(logger *slog.Logger) *hostMetricsSampler {
	return &hostMetricsSampler{logger: logger}
}

// cpuPercentBetween computes aggregate CPU utilization between two raw
// counter snapshots: the share of elapsed CPU time that was NOT idle (idle +
// iowait), clamped to [0, 100]. ok=false when the delta is unusable
// (counter reset, no elapsed time) — the caller keeps the previous sample.
func cpuPercentBetween(prev, cur cpu.TimesStat) (percent float64, ok bool) {
	idleDelta := (cur.Idle + cur.Iowait) - (prev.Idle + prev.Iowait)
	totalDelta := cur.Total() - prev.Total()
	if totalDelta <= 0 {
		return 0, false
	}
	if idleDelta < 0 {
		idleDelta = 0
	}
	busy := totalDelta - idleDelta
	if busy < 0 {
		busy = 0
	}
	percent = busy / totalDelta * 100
	if percent > 100 {
		percent = 100
	}
	return percent, true
}

// sampleOnce takes one CPU+memory reading and, on success, publishes it as
// the latest sample. Failures are logged at debug and leave the previous
// sample in place.
func (s *hostMetricsSampler) sampleOnce(ctx context.Context) {
	now := time.Now()
	out := protocol.HostMetrics{CapturedAt: now.Unix()}

	times, err := cpu.TimesWithContext(ctx, false)
	if err != nil {
		s.logger.Debug("host metrics: cpu sample failed", "error", err)
	} else if len(times) > 0 {
		cur := times[0]
		if s.prevCPUSet {
			if percent, ok := cpuPercentBetween(s.prevCPU, cur); ok {
				out.CPUPercent = &percent
			}
		}
		// The first tick only establishes the baseline: reporting a
		// since-boot average as "current load" would skew the first sample.
		s.prevCPU = cur
		s.prevCPUSet = true
	}

	vm, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		s.logger.Debug("host metrics: memory sample failed", "error", err)
	} else {
		percent := vm.UsedPercent
		out.MemoryPercent = &percent
	}

	if out.CPUPercent == nil && out.MemoryPercent == nil {
		// Nothing sampled at all: keep whatever we had (possibly nothing).
		return
	}
	s.latest.Store(&hostMetricsSample{metrics: out, sampledAt: now})
}

// latestFresh returns the current sample when it is younger than
// hostMetricsMaxAge, else nil — callers omit stale data rather than report
// the machine's past.
func (s *hostMetricsSampler) latestFresh(now time.Time) *protocol.HostMetrics {
	sample := s.latest.Load()
	if sample == nil || now.Sub(sample.sampledAt) >= hostMetricsMaxAge {
		return nil
	}
	metrics := sample.metrics
	return &metrics
}

// run ticks the sampler until ctx is done. The first tick fires immediately
// so the baseline is established well before the first heartbeat needs it.
func (s *hostMetricsSampler) run(ctx context.Context) {
	s.sampleOnce(ctx)
	ticker := time.NewTicker(hostMetricsSampleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sampleOnce(ctx)
		}
	}
}

// latestHostMetrics returns the daemon's fresh host sample, or nil when the
// sampler has none. Nil-receiver safe so tests and partial constructions
// behave like "no data".
func (d *Daemon) latestHostMetrics() *protocol.HostMetrics {
	if d.hostMetrics == nil {
		return nil
	}
	return d.hostMetrics.latestFresh(time.Now())
}
