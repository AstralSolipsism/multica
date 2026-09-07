package daemon

import (
	"context"
	"math/rand"
	"sort"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Plan-quota collectors: daemon-integrated pollers that turn official
// programmatic provider APIs (Kimi Code's local Server API, ZenMux's
// Management API) into protocol.RuntimePlanQuota snapshots. Snapshots flow
// through the existing planQuotaCache -> heartbeat plan_quota channel; no
// new wire surface is added. Credentials (Kimi's local server token,
// ZenMux's Management API key) are read from daemon-local configuration and
// never leave this machine — the snapshot shape carries no account ids,
// plan names, credit balances, or tokens by construction.
//
// Failure semantics are fail-soft everywhere: a collector that cannot reach
// its data source simply stops refreshing the cache, so the runtime renders
// "not reported" (never observed) or "stale" (last success ages past 24h).
// Collector problems must never block or crash the daemon's main loops.

const (
	// defaultPlanQuotaPollInterval is how often each collector re-observes
	// its source. ZenMux rate-limits the Management API per endpoint, so
	// this stays in the 1-3 minute band the platform documents; the same
	// cadence keeps Kimi's loopback probe from hammering the account
	// service it proxies.
	defaultPlanQuotaPollInterval = 2 * time.Minute
	// planQuotaRateLimitMaxBackoff caps the exponential backoff a collector
	// applies after the source asks it to slow down (ZenMux answers 422).
	planQuotaRateLimitMaxBackoff = 30 * time.Minute
	// planQuotaFailureLogStride throttles repeated failure logs: the first
	// failure logs a warning, then every Nth consecutive one does.
	planQuotaFailureLogStride = 5
)

// planQuotaCollectFunc observes one source once and returns the normalized
// snapshot, or an error when the source is unreachable / drifted / unhappy.
type planQuotaCollectFunc func(ctx context.Context) (*protocol.RuntimePlanQuota, error)

// planQuotaTargetFunc resolves the runtime ids a snapshot applies to at each
// tick. Kimi targets every local kimi runtime; ZenMux targets only the
// hermes runtimes the operator explicitly linked to the configured account.
type planQuotaTargetFunc func() []string

// rateLimitError marks "the source asked us to back off" (HTTP 422/429) so
// the loop can stretch its next delay instead of keeping the base cadence.
type rateLimitError struct{ err error }

func (e *rateLimitError) Error() string { return e.err.Error() }
func (e *rateLimitError) Unwrap() error { return e.err }

// rateLimitBackoff computes the delay after the streak-th consecutive
// rate-limit answer: 2x the base interval, doubling to a 32x ceiling, capped
// at planQuotaRateLimitMaxBackoff.
func rateLimitBackoff(base time.Duration, streak int) time.Duration {
	if streak < 1 {
		streak = 1
	}
	if streak > 5 {
		streak = 5
	}
	d := base << streak
	if d > planQuotaRateLimitMaxBackoff {
		return planQuotaRateLimitMaxBackoff
	}
	return d
}

// runPlanQuotaCollector drives one collector on a jittered ticker. Each tick
// resolves the current target runtimes (providers may register or leave at
// any time), collects once — one observation per machine per cycle no matter
// how many runtimes share the account — and stores the snapshot for every
// target so their next heartbeats carry it. rateLimitError stretches the
// following delay exponentially (capped); every other failure keeps the base
// cadence and only logs.
func (d *Daemon) runPlanQuotaCollector(
	ctx context.Context,
	name string,
	interval time.Duration,
	targetsOf planQuotaTargetFunc,
	collect planQuotaCollectFunc,
) {
	if interval <= 0 {
		interval = defaultPlanQuotaPollInterval
	}
	delay := time.Duration(rand.Int63n(int64(interval))) // startup jitter: de-herd multi-daemon fleets
	consecutiveFailures := 0
	rateLimitStreak := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = interval

		targets := targetsOf()
		if len(targets) == 0 {
			// No runtime on this daemon is backed by this source — skip the
			// observation entirely (also keeps unused sources off their rate
			// limiter) and reset the failure streaks: nothing is wrong.
			consecutiveFailures = 0
			rateLimitStreak = 0
			continue
		}

		quota, err := collect(ctx)
		if err != nil {
			consecutiveFailures++
			if _, limited := err.(*rateLimitError); limited {
				rateLimitStreak++
				delay = rateLimitBackoff(interval, rateLimitStreak)
			}
			if consecutiveFailures == 1 || consecutiveFailures%planQuotaFailureLogStride == 0 {
				d.logger.Warn("plan quota collector failed; snapshot stops refreshing",
					"collector", name, "consecutive_failures", consecutiveFailures, "error", err)
			} else {
				d.logger.Debug("plan quota collector failed",
					"collector", name, "consecutive_failures", consecutiveFailures, "error", err)
			}
			continue
		}
		if quota == nil {
			// The source answered but carried nothing reportable (e.g. an
			// account with no limit rows): not an error, nothing to store.
			consecutiveFailures = 0
			rateLimitStreak = 0
			continue
		}
		if consecutiveFailures > 0 {
			d.logger.Info("plan quota collector recovered", "collector", name, "after_failures", consecutiveFailures)
		}
		consecutiveFailures = 0
		rateLimitStreak = 0
		for _, runtimeID := range targets {
			d.recordRuntimePlanQuota(runtimeID, quota)
		}
		d.logger.Debug("plan quota snapshot recorded",
			"collector", name, "runtimes", len(targets), "windows", len(quota.Windows))
	}
}

// runtimeIDsForProvider returns the sorted ids of this daemon's registered
// runtimes whose provider matches one of the given providers.
func (d *Daemon) runtimeIDsForProvider(providers ...string) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var ids []string
	for _, ws := range d.workspaces {
		for _, rid := range ws.runtimeIDs {
			rt, ok := d.runtimeIndex[rid]
			if !ok {
				continue
			}
			for _, provider := range providers {
				if rt.Provider == provider {
					ids = append(ids, rid)
					break
				}
			}
		}
	}
	sort.Strings(ids)
	return ids
}
