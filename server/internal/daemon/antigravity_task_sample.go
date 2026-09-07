package daemon

import (
	"context"
	"errors"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// Task-window sampling for the Antigravity plan-quota probe.
//
// The 5-minute antigravityQuotaLoop only records a snapshot when a tick lands
// inside an agy process's lifetime. Daemon-spawned antigravity sessions are
// `agy -p` one-shot subprocesses that live exactly as long as one turn, so a
// machine that runs only short tasks routinely falls entirely between ticks:
// no snapshot is ever recorded and the runtime pages render "not reported"
// forever even though the account is actively in use. This sampler closes
// that gap — runTask starts it around the backend execution window, when the
// task's agy process is (or is about to be) alive, and the first successful
// round is recorded the moment agy's loopback service answers.
//
// It inherits the probe's fail-soft contract and adds its own stops: first
// success, the task window ending (context cancel, or the process exiting
// for good), and a bounded discovery window — so an agy build whose print
// mode never serves the quota protocol (the one unverified assumption of the
// whole feature) costs a fixed handful of cheap failed rounds per task and
// never a task-long busy loop.

// Stable skip reasons for the plan-quota probe, surfaced on /health. Every
// probe failure is silent in the daemon's main flows by contract, so these
// codes are the only place that answers "why does my antigravity runtime
// show no quota" without daemon debug logs.
const (
	antigravityQuotaSkipNotRegistered      = "not_registered"
	antigravityQuotaSkipNoVersion          = "no_version"
	antigravityQuotaSkipVersionUnsupported = "version_unsupported"
	antigravityQuotaSkipNotRunning         = "agy_not_running"
	antigravityQuotaSkipNoListener         = "no_quota_listener"
)

// Sampler tunables are vars so tests can shrink them.
var (
	// antigravityTaskSampleWindow bounds one task's sampling. agy's loopback
	// service is expected within seconds of spawn; a full window of failed
	// rounds means this agy build does not serve the quota protocol in the
	// mode the daemon launches, and more retrying within the task cannot
	// change that.
	antigravityTaskSampleWindow = 60 * time.Second
	// antigravityTaskSampleRetry is the gap between rounds. Early rounds are
	// cheap — before agy spawns the process scan fails fast — and once the
	// listener answers, the sampler exits on its first success.
	antigravityTaskSampleRetry = 2 * time.Second
	// antigravityTaskSampleSpawnGrace is how long "no agy process" is
	// tolerated before the first sighting: the sampler starts a moment before
	// the backend spawns agy, so the first round or two can lose that race.
	antigravityTaskSampleSpawnGrace = 15 * time.Second
	// antigravityTaskSampleExitMisses is how many consecutive "no agy
	// process" rounds end sampling once a round has seen the process: agy
	// has exited, and nothing more can be observed for this task.
	antigravityTaskSampleExitMisses = 2
)

// antigravityQuotaDiagnostics is the probe's rolling last-attempt record:
// when it last ran, whether it produced a snapshot, and — when it did not —
// the stable reason it produced nothing.
type antigravityQuotaDiagnostics struct {
	attemptAt  time.Time
	successAt  time.Time
	skipReason string
}

// recordAntigravityQuotaSkip notes a probe attempt that recorded nothing.
func (d *Daemon) recordAntigravityQuotaSkip(reason string) {
	d.antigravityQuotaDiagMu.Lock()
	defer d.antigravityQuotaDiagMu.Unlock()
	d.antigravityQuotaDiag.attemptAt = time.Now()
	d.antigravityQuotaDiag.skipReason = reason
}

// recordAntigravityQuotaSuccess notes an attempt that recorded a snapshot.
func (d *Daemon) recordAntigravityQuotaSuccess() {
	d.antigravityQuotaDiagMu.Lock()
	defer d.antigravityQuotaDiagMu.Unlock()
	now := time.Now()
	d.antigravityQuotaDiag.attemptAt = now
	d.antigravityQuotaDiag.successAt = now
	d.antigravityQuotaDiag.skipReason = ""
}

// antigravityQuotaDiagSnapshot copies the diagnostics for /health. Nil until
// the first attempt, so a daemon that never probes antigravity changes the
// response not at all.
func (d *Daemon) antigravityQuotaDiagSnapshot() *healthAntigravityQuota {
	d.antigravityQuotaDiagMu.Lock()
	defer d.antigravityQuotaDiagMu.Unlock()
	if d.antigravityQuotaDiag.attemptAt.IsZero() {
		return nil
	}
	out := &healthAntigravityQuota{
		LastAttemptAt:  d.antigravityQuotaDiag.attemptAt.UTC().Format(time.RFC3339),
		LastSkipReason: d.antigravityQuotaDiag.skipReason,
	}
	if !d.antigravityQuotaDiag.successAt.IsZero() {
		out.LastSuccessAt = d.antigravityQuotaDiag.successAt.UTC().Format(time.RFC3339)
	}
	return out
}

// antigravityQuotaSkipReasonFor maps a probe failure onto its stable /health
// reason. The default bucket is the probe's aggregate "reached nothing that
// speaks the protocol" case, which covers undiscovered ports, rejected or
// timed-out calls, and unrecognized payloads alike.
func antigravityQuotaSkipReasonFor(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, agent.ErrAntigravityNotRunning):
		return antigravityQuotaSkipNotRunning
	case errors.Is(err, agent.ErrAntigravityVersionUnsupported):
		return antigravityQuotaSkipVersionUnsupported
	default:
		return antigravityQuotaSkipNoListener
	}
}

// maybeStartAntigravityTaskSampler launches the per-task quota sampler around
// a task's backend execution window, for the one provider whose quota the
// daemon must chase (every other provider reports quota in its result stream
// or through its own collector). It returns the sampler's cancel function —
// a no-op for other providers, so the call site can defer unconditionally.
func (d *Daemon) maybeStartAntigravityTaskSampler(ctx context.Context, provider string) context.CancelFunc {
	if provider != antigravityQuotaProvider {
		return func() {}
	}
	samplerCtx, cancel := context.WithCancel(ctx)
	go d.runAntigravityTaskSampler(samplerCtx)
	return cancel
}

// runAntigravityTaskSampler probes in a tight loop while the task's agy
// process should be alive and records the first successful snapshot for
// every local antigravity runtime — account-level fan-out, the same set the
// periodic loop feeds.
func (d *Daemon) runAntigravityTaskSampler(ctx context.Context) {
	entry, ok := d.agents()[antigravityQuotaProvider]
	if !ok || entry.Path == "" {
		d.recordAntigravityQuotaSkip(antigravityQuotaSkipNotRegistered)
		return
	}
	version := d.agentVersion(antigravityQuotaProvider)
	if version == "" {
		// Fail-closed version gate, same reasoning as the periodic loop: an
		// undetected version means the binary was never verified.
		d.recordAntigravityQuotaSkip(antigravityQuotaSkipNoVersion)
		return
	}
	if len(d.providerRuntimeIDs(antigravityQuotaProvider)) == 0 {
		return
	}

	startedAt := time.Now()
	deadline := startedAt.Add(antigravityTaskSampleWindow)
	processSeen := false
	processMisses := 0
	var lastErr error
loop:
	for {
		quota, err := antigravityQuotaProbe(ctx, entry.Path, version, time.Now())
		if err == nil {
			for _, runtimeID := range d.providerRuntimeIDs(antigravityQuotaProvider) {
				d.recordRuntimePlanQuota(runtimeID, quota)
			}
			d.recordAntigravityQuotaSuccess()
			return
		}
		lastErr = err
		if errors.Is(err, agent.ErrAntigravityNotRunning) {
			if processSeen {
				processMisses++
				if processMisses >= antigravityTaskSampleExitMisses {
					break
				}
			} else if time.Since(startedAt) >= antigravityTaskSampleSpawnGrace {
				// agy never appeared (the launch failed fast, most likely):
				// nothing to sample this task.
				break
			}
		} else {
			// Any other failure implies the round reached a live process.
			processSeen = true
			processMisses = 0
		}
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			break
		}
		timer := time.NewTimer(antigravityTaskSampleRetry)
		select {
		case <-ctx.Done():
			timer.Stop()
			break loop
		case <-timer.C:
		}
	}
	d.recordAntigravityQuotaSkip(antigravityQuotaSkipReasonFor(lastErr))
}
