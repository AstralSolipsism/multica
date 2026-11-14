package daemon

// Labrastro fork addition: the plan-quota cache and heartbeat attachment
// assembly. Moved verbatim out of daemon.go (upstream high-churn file) so the
// fork footprint there stays minimal. The loopback same-UID peer-proof
// security boundary in planquota_kimi.go is untouched and unrelated.

import (
	"sort"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// planQuotaCacheEntry is one cached plan-quota value (the zenmux clear
// marker was retired with the daemon-side collector in OL-1205 scenario 3).
type planQuotaCacheEntry struct {
	quota *protocol.RuntimePlanQuota
}

// recordRuntimePlanQuota caches a runtime's latest plan/rate-limit snapshot
// (reported by an agent backend at task completion) so the next heartbeat
// for that runtime carries it. The entry lives until the runtime leaves the
// local set — a snapshot stays the "latest known" even across daemon-side
// quiet periods, matching the server column's last-write-wins semantics.
func (d *Daemon) recordRuntimePlanQuota(runtimeID string, quota *protocol.RuntimePlanQuota) {
	if runtimeID == "" || quota == nil {
		return
	}
	// Validation normalizes status. Copy the snapshot so concurrent readers
	// of an already-cached observation never see an in-place mutation.
	normalized := *quota
	if err := protocol.ValidateRuntimePlanQuota(&normalized, time.Now()); err != nil {
		d.logger.Warn("runtime plan quota rejected", "runtime_id", runtimeID,
			"provider", quota.Provider, "error", err)
		return
	}
	if normalized.Status != quota.Status {
		quota = &normalized
	}
	entry := planQuotaCacheEntry{quota: quota}
	for {
		previous, loaded := d.planQuotaCache.LoadOrStore(runtimeID, entry)
		if !loaded {
			return
		}
		current := previous.(planQuotaCacheEntry)
		if current.quota != nil && current.quota.ObservedAt > quota.ObservedAt {
			return // An older run can finish after a newer live observation.
		}
		if d.planQuotaCache.CompareAndSwap(runtimeID, previous, entry) {
			return
		}
	}
}

// recordTaskPlanQuota caches a task-reported snapshot (Claude, Codex) for the
// reporting runtime AND every other same-source runtime this daemon hosts:
// same provider AND same profile_id means the same local agent installation,
// so the balance is that runtime's too, whatever workspace registered it
// (OL-1205). Each runtime's own heartbeat then forwards the snapshot, so the
// server-side update stays per-runtime — no cross-workspace channel needed.
// Timed collectors keep runtimeIDsForProvider: their target set is decided by
// the collector, not by which runtime reported.
func (d *Daemon) recordTaskPlanQuota(runtimeID string, quota *protocol.RuntimePlanQuota) {
	if runtimeID == "" || quota == nil {
		return
	}
	for _, id := range d.runtimeIDsForQuotaSource(runtimeID) {
		d.recordRuntimePlanQuota(id, quota)
	}
}

// runtimeIDsForQuotaSource returns the sorted ids of this daemon's runtimes
// that share the given runtime's quota source (provider + profile_id pair).
// Always includes the reporting runtime itself when still registered.
func (d *Daemon) runtimeIDsForQuotaSource(runtimeID string) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	source, ok := d.runtimeIndex[runtimeID]
	if !ok {
		return []string{runtimeID}
	}
	var ids []string
	for _, ws := range d.workspaces {
		for _, rid := range ws.runtimeIDs {
			rt, found := d.runtimeIndex[rid]
			if found && rt.Provider == source.Provider && rt.ProfileID == source.ProfileID {
				ids = append(ids, rid)
			}
		}
	}
	sort.Strings(ids)
	return ids
}

// heartbeatExtrasFor assembles the optional heartbeat attachments for one
// runtime: its cached plan-quota snapshot (nil when the provider reported
// nothing) and the latest fresh host metrics sample (nil when the sampler
// has none). ThinkingAdapt carries the Jev health snapshot, but only for
// providers Multica can deliver a reasoning effort to at all
// (agent.ThinkingControlSupported, contract §8): on anything else the field
// would describe a dial the runtime does not have.
func (d *Daemon) heartbeatExtrasFor(runtimeID string) HeartbeatExtras {
	extras := HeartbeatExtras{Metrics: d.latestHostMetrics()}
	if d.jevClient != nil {
		if rt := d.findRuntime(runtimeID); rt != nil && agent.ThinkingControlSupported(rt.Provider) {
			snap := d.jevClient.Snapshot()
			extras.ThinkingAdapt = &snap
		}
	}
	if cached, ok := d.planQuotaCache.Load(runtimeID); ok {
		if entry, ok := cached.(planQuotaCacheEntry); ok {
			extras.PlanQuota = entry.quota
		}
	}
	return extras
}
