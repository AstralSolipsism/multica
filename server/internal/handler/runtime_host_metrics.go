package handler

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"strconv"
	"sync"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// hostMetricsFreshnessSLA bounds how old a stored sample may be before the
// runtime list marks it stale. The daemon samples every 15s, so 30s covers
// one missed cycle; anything older no longer describes the machine's
// current load and the UI must say "stale", distinct from "never reported".
const hostMetricsFreshnessSLA = 30 * time.Second

// hostMetricsMaxFutureSkew bounds how far ahead of the server clock a
// sample's captured_at may be before it is rejected. One wildly-future
// timestamp would otherwise win every set-if-newer comparison and pin the
// key until TTL.
const hostMetricsMaxFutureSkew = 2 * time.Minute

// hostMetricsPublishMinInterval throttles the per-machine telemetry
// broadcast: CPU/memory jitter can flip the rounded percentage on many
// cycles, and each broadcast refetches the runtime list for every connected
// workspace client.
const hostMetricsPublishMinInterval = 15 * time.Second

// hostMetricsMachinePublication is one machine's broadcast bookkeeping: when
// the last telemetry broadcast went out and which rounded content it
// announced.
type hostMetricsMachinePublication struct {
	publishedAt  time.Time
	publishedKey string
}

// hostMetricsPublishTracker coalesces telemetry broadcasts per machine.
type hostMetricsPublishTracker struct {
	mu       sync.Mutex
	machines map[string]hostMetricsMachinePublication
}

func newHostMetricsPublishTracker() *hostMetricsPublishTracker {
	return &hostMetricsPublishTracker{machines: map[string]hostMetricsMachinePublication{}}
}

// hostMetricsContentKey identifies the rounded percentage content of one
// sample — the same comparison the store's set-if-newer script applies when
// it reports Changed vs Refreshed. Nil and a real 0 are deliberately
// distinct ("-" vs "0").
func hostMetricsContentKey(m *protocol.HostMetrics) string {
	return hostMetricsRounded(m.CPUPercent) + "|" + hostMetricsRounded(m.MemoryPercent)
}

func hostMetricsRounded(p *float64) string {
	if p == nil {
		return "-"
	}
	return strconv.Itoa(int(math.Floor(*p + 0.5)))
}

// shouldPublish reports whether a just-stored sample warrants a telemetry
// broadcast now, recording the broadcast when allowed. A sample whose
// rounded content equals the last announced one is never re-announced; a
// changed sample arriving inside the throttle window is deferred, not
// dropped — the next beat re-offers it, so the latest change reaches
// clients at most one heartbeat cadence past the window. Entries idle
// longer than an hour are swept on use so the map stays bounded by the
// number of recently-active machines.
func (t *hostMetricsPublishTracker) shouldPublish(machineKey, contentKey string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, state := range t.machines {
		if now.Sub(state.publishedAt) > time.Hour {
			delete(t.machines, k)
		}
	}
	state := t.machines[machineKey]
	if state.publishedKey == contentKey {
		return false
	}
	if !state.publishedAt.IsZero() && now.Sub(state.publishedAt) < hostMetricsPublishMinInterval {
		return false
	}
	t.machines[machineKey] = hostMetricsMachinePublication{publishedAt: now, publishedKey: contentKey}
	return true
}

// validateHostMetrics checks a heartbeat host-metrics sample. Percentages,
// when present, must be real percentages; a nil pointer means "not sampled"
// and is always acceptable. captured_at must be positive and not
// unreasonably far ahead of the server clock.
func validateHostMetrics(m *protocol.HostMetrics, now time.Time) error {
	if m == nil {
		return errors.New("host metrics: missing body")
	}
	if m.CPUPercent != nil && (*m.CPUPercent < 0 || *m.CPUPercent > 100) {
		return errors.New("host metrics: cpu_percent out of range")
	}
	if m.MemoryPercent != nil && (*m.MemoryPercent < 0 || *m.MemoryPercent > 100) {
		return errors.New("host metrics: memory_percent out of range")
	}
	if m.CapturedAt <= 0 {
		return errors.New("host metrics: captured_at missing")
	}
	if m.CapturedAt > now.Add(hostMetricsMaxFutureSkew).Unix() {
		return errors.New("host metrics: captured_at too far in the future")
	}
	return nil
}

// storeHeartbeatMetrics hands a heartbeat host-metrics sample to the
// metrics store and, when the machine's rounded content differs from the
// last broadcast, publishes runtime:telemetry_updated (throttled per
// machine) so workspace clients refetch the runtime list. Same non-fatal
// contract as storeHeartbeatPlanQuota: validation and store failures are
// logged and swallowed — the beat is acked regardless. The workspaceID and
// daemonID always come from the server-resolved runtime row / connection
// lease, never from the request payload.
func (h *Handler) storeHeartbeatMetrics(ctx context.Context, workspaceID, daemonID string, metrics *protocol.HostMetrics) {
	h.storeHeartbeatMetricsAt(ctx, workspaceID, daemonID, metrics, time.Now())
}

// storeHeartbeatMetricsAt is storeHeartbeatMetrics with an explicit clock,
// so tests can exercise the throttle window's exact boundary.
func (h *Handler) storeHeartbeatMetricsAt(ctx context.Context, workspaceID, daemonID string, metrics *protocol.HostMetrics, now time.Time) {
	if metrics == nil {
		return
	}
	if daemonID == "" {
		slog.Debug("heartbeat metrics dropped: runtime has no daemon id", "workspace_id", workspaceID)
		return
	}
	if !h.MachineMetricsStore.Available() {
		return
	}
	if err := validateHostMetrics(metrics, now); err != nil {
		slog.Debug("heartbeat metrics dropped: invalid",
			"workspace_id", workspaceID, "daemon_id", daemonID, "error", err)
		return
	}
	result, err := h.MachineMetricsStore.PutIfNewer(ctx, MachineRef{WorkspaceID: workspaceID, DaemonID: daemonID}, metrics)
	if err != nil {
		slog.Warn("heartbeat metrics store failed",
			"workspace_id", workspaceID, "daemon_id", daemonID, "error", err)
		return
	}
	if result == MachineMetricsDropped {
		// An out-of-order beat older than the stored sample: the store holds
		// something newer than this payload, so the payload must not drive
		// the broadcast bookkeeping.
		return
	}
	// Changed or Refreshed: the store now holds this sample. A change that
	// lands inside the throttle window is deferred — the next beat re-offers
	// it and shouldPublish fires once the window has passed, so the latest
	// content is never lost, only delayed by one heartbeat cadence.
	if h.hostMetricsPublish == nil || !h.hostMetricsPublish.shouldPublish(workspaceID+":"+daemonID, hostMetricsContentKey(metrics), now) {
		return
	}
	h.publish(protocol.EventRuntimeTelemetryUpdated, workspaceID, "system", "", map[string]any{
		"daemon_id": daemonID,
	})
}

// hostMetricsStale reports whether a stored sample is older than the
// freshness SLA at read time. The comparison uses the server clock: the
// ingress validation already bounded how far the daemon clock may run
// ahead, so one consistent authority decides "stale" for every client.
func hostMetricsStale(sample *protocol.HostMetrics, now time.Time) bool {
	return now.Unix()-sample.CapturedAt > int64(hostMetricsFreshnessSLA/time.Second)
}

// systemStatsForRuntimes reads the latest host metrics samples for the
// machines behind runtimes and indexes them by daemon id. Every runtime row
// is already workspace-scoped by the caller's query, so all refs share the
// request's workspace; the map is keyed by daemon id for the per-row
// assembly that follows.
func (h *Handler) systemStatsForRuntimes(ctx context.Context, workspaceID string, runtimes []db.AgentRuntime) map[string]*protocol.HostMetrics {
	out := map[string]*protocol.HostMetrics{}
	if !h.MachineMetricsStore.Available() || len(runtimes) == 0 {
		return out
	}
	seen := map[string]bool{}
	refs := make([]MachineRef, 0, len(runtimes))
	for _, rt := range runtimes {
		if !rt.DaemonID.Valid || rt.DaemonID.String == "" || seen[rt.DaemonID.String] {
			continue
		}
		seen[rt.DaemonID.String] = true
		refs = append(refs, MachineRef{WorkspaceID: workspaceID, DaemonID: rt.DaemonID.String})
	}
	for ref, sample := range h.MachineMetricsStore.GetBatch(ctx, refs) {
		out[ref.DaemonID] = sample
	}
	return out
}

// formatSystemStats renders the wire shape for one stored sample, including
// the server-computed stale flag the UI uses to tell "数据过期" apart from
// "未上报" (absent field).
func formatSystemStats(sample *protocol.HostMetrics, now time.Time) *RuntimeSystemStatsResponse {
	if sample == nil {
		return nil
	}
	return &RuntimeSystemStatsResponse{
		CPUPercent:    sample.CPUPercent,
		MemoryPercent: sample.MemoryPercent,
		CapturedAt:    sample.CapturedAt,
		Stale:         hostMetricsStale(sample, now),
	}
}
