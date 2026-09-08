package daemon

import (
	"context"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// antigravityQuotaProbeInterval is how often the daemon probes agy's local
// quota service for its runtime pages. The quota moves on human timescales
// (a five-hour and a weekly pool), the server already throttles unchanged
// snapshots, and the probe forks a process scan plus up to a handful of
// loopback calls per round — so it cadences far below the 15s heartbeat that
// carries its result. Overridable for tests.
var antigravityQuotaProbeInterval = 5 * time.Minute

// antigravityQuotaProbe is the probe entry point, indirected so tests can
// stub the live agy discovery.
var antigravityQuotaProbe = agent.ProbeAntigravityQuota

// antigravityQuotaLoop periodically refreshes the Antigravity plan-quota
// snapshot from agy's loopback service (see pkg/agent for why every failure
// in there is silent by contract). The probe is account-level: one round per
// daemon, its result recorded for every local antigravity runtime, because
// the agy CLI it observes is one install signed into one account.
//
// Everything here is additive to the daemon's main flow: a skipped or failed
// round simply leaves the previous snapshot (which the UI ages out) — it
// never blocks tasks, heartbeats, or registration.
func (d *Daemon) antigravityQuotaLoop(ctx context.Context) {
	ticker := time.NewTicker(antigravityQuotaProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.runAntigravityQuotaProbe(ctx)
		}
	}
}

// runAntigravityQuotaProbe runs one probe round and records the snapshot into
// the plan-quota cache, so each affected runtime's next heartbeat carries it.
// Rounds with nothing to do (no antigravity runtime registered, undetected
// version) exit before any process scan.
func (d *Daemon) runAntigravityQuotaProbe(ctx context.Context) {
	runtimeIDs := d.providerRuntimeIDs(antigravityQuotaProvider)
	if len(runtimeIDs) == 0 {
		// No local antigravity runtime to feed: there is no sampling need
		// here, and this must stay invisible — recording a skip reason from
		// the periodic loop would put the /health field on every machine that
		// merely lacks the CLI. Gate first, record after.
		return
	}
	entry, ok := d.agents()[antigravityQuotaProvider]
	if !ok || entry.Path == "" {
		// A runtime exists but its CLI is gone (undiscovered or demoted):
		// this machine DOES have an antigravity page, so the reason the
		// probe cannot feed it is worth surfacing.
		d.recordAntigravityQuotaSkip(antigravityQuotaSkipNotRegistered)
		return
	}
	version := d.agentVersion(antigravityQuotaProvider)
	if version == "" {
		// The version gate is fail-closed on purpose: registration detects
		// the version for every provider it registers, so an empty string
		// means "never verified this binary" — exactly what the probe must
		// not question on its own.
		d.recordAntigravityQuotaSkip(antigravityQuotaSkipNoVersion)
		return
	}
	quota, err := antigravityQuotaProbe(ctx, entry.Path, version, time.Now())
	if err != nil {
		// agy not running, version outside the probed range, no reachable
		// listener, unrecognized payload: all the same "not reported" the
		// issue's acceptance criteria demand — logged quietly, nothing
		// written. The reason is still surfaced on /health, since these
		// logs are the only other trace of a silent degradation.
		d.logger.Debug("antigravity quota probe skipped", "error", err)
		d.recordAntigravityQuotaSkip(antigravityQuotaSkipReasonFor(err))
		return
	}
	for _, runtimeID := range runtimeIDs {
		d.recordRuntimePlanQuota(runtimeID, quota)
	}
	d.recordAntigravityQuotaSuccess()
}

// antigravityQuotaProvider names the builtin provider whose runtime pages the
// probe feeds. It mirrors agent.Antigravity's provider id.
const antigravityQuotaProvider = "antigravity"

// providerRuntimeIDs returns the IDs of locally tracked runtimes for one
// provider, in the index's iteration order. The runtime index only holds the
// local set, so a runtime that left the daemon is automatically excluded.
func (d *Daemon) providerRuntimeIDs(provider string) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var ids []string
	for id, rt := range d.runtimeIndex {
		if rt.Provider == provider {
			ids = append(ids, id)
		}
	}
	return ids
}
