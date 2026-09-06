package handler

import (
	"context"
	"errors"
	"log/slog"
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
// the last telemetry broadcast went out, which rounded content it announced,
// and when the last metrics-carrying beat was accepted.
type hostMetricsMachinePublication struct {
	publishedAt  time.Time
	publishedKey string
	lastBeatAt   time.Time
}

// hostMetricsPublishTracker coalesces telemetry broadcasts per machine.
type hostMetricsPublishTracker struct {
	mu       sync.Mutex
	machines map[string]hostMetricsMachinePublication
}

func newHostMetricsPublishTracker() *hostMetricsPublishTracker {
	return &hostMetricsPublishTracker{machines: map[string]hostMetricsMachinePublication{}}
}

// shouldPublish reports whether the just-stored sample warrants a telemetry
// broadcast now, recording the broadcast when allowed. A sample whose
// rounded content equals the last announced one is never re-announced; a
// changed sample arriving inside the throttle window is deferred, not
// dropped — the next beat re-offers it, so the latest change reaches
// clients at most one heartbeat cadence past the window.
//
// Recovery: the Redis entry lives machineMetricsTTL (90s) past the last
// accepted beat. When no metrics-carrying beat has arrived for longer than
// that, the stored sample — and with it the clients' knowledge — has
// expired, so the first resumed sample is announced even if its content
// equals what was last broadcast: clients currently render "not reported"
// and must be told the machine's metrics are back.
//
// Entries idle longer than an hour are swept on use so the map stays
// bounded by the number of recently-active machines.
func (t *hostMetricsPublishTracker) shouldPublish(machineKey, contentKey string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, state := range t.machines {
		if now.Sub(state.publishedAt) > time.Hour && now.Sub(state.lastBeatAt) > time.Hour {
			delete(t.machines, k)
		}
	}
	state := t.machines[machineKey]
	// Expiry is judged against the PREVIOUS accepted beat: the Redis entry
	// lives machineMetricsTTL past it, so a longer gap means the stored
	// sample is gone and clients currently render "not reported".
	expired := !state.lastBeatAt.IsZero() && now.Sub(state.lastBeatAt) > machineMetricsTTL
	if state.publishedKey == contentKey && !expired {
		state.lastBeatAt = now
		t.machines[machineKey] = state
		return false
	}
	if !expired && !state.publishedAt.IsZero() && now.Sub(state.publishedAt) < hostMetricsPublishMinInterval {
		state.lastBeatAt = now
		t.machines[machineKey] = state
		return false
	}
	t.machines[machineKey] = hostMetricsMachinePublication{publishedAt: now, publishedKey: contentKey, lastBeatAt: now}
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
	// The publish decision runs off the STORED content key on every accepted
	// beat — including no-op (same/older captured_at) ones — so a
	// throttle-deferred change is re-offered by the next heartbeat even when
	// the daemon's sampler has stopped producing new samples and beats keep
	// re-sending the last sample. The write outcome itself is the store
	// contract's concern and is pinned by the store tests.
	_, storedKey, err := h.MachineMetricsStore.PutIfNewer(ctx, MachineRef{WorkspaceID: workspaceID, DaemonID: daemonID}, metrics)
	if err != nil {
		slog.Warn("heartbeat metrics store failed",
			"workspace_id", workspaceID, "daemon_id", daemonID, "error", err)
		return
	}
	if storedKey == "" {
		return
	}
	// Announce when the stored rounded content differs from the last
	// broadcast and the per-machine throttle window has passed. A change
	// landing inside the window is deferred, not dropped: each subsequent
	// beat re-offers the stored content, so the latest change reaches
	// clients at most one heartbeat cadence past the window.
	if h.hostMetricsPublish == nil || !h.hostMetricsPublish.shouldPublish(workspaceID+":"+daemonID, storedKey, now) {
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
