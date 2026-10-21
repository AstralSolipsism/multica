package daemon

import (
	"context"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
)

// Jev health probing (contract §3): after this daemon has made at least one
// real adaptive decision, one business-content-free Probe when 10 minutes
// pass without a new decision, at most one probe per 10 minutes. A daemon
// that never used adapt never probes — its snapshot stays idle.
const (
	jevProbeIdleInterval = 10 * time.Minute
	jevProbeTickInterval = time.Minute
)

// jevProber is the slice of jev.Client the scheduler needs; tests substitute
// a fake that counts probes.
type jevProber interface {
	Snapshot() jev.Snapshot
	Probe(ctx context.Context) error
}

// jevProbeScheduler keeps the Jev health snapshot fresh on daemons that use
// adaptive thinking. It discovers real decisions by polling the snapshot's
// cumulative counters: a sum that grew since the last tick means a Decide
// ran, so the run path (OL-1005) can call the client directly with no
// scheduler wiring. Polling granularity is one tick, well inside the
// 10-minute idle window the contract cares about.
type jevProbeScheduler struct {
	client jevProber
	now    func() time.Time

	lastCounters int64
	lastDecideAt time.Time
	lastProbeAt  time.Time
}

func newJevProbeScheduler(client jevProber) *jevProbeScheduler {
	return &jevProbeScheduler{client: client, now: time.Now}
}

// tick runs one scheduling step and reports whether a probe was sent.
func (s *jevProbeScheduler) tick(ctx context.Context) bool {
	snap := s.client.Snapshot()
	used := snap.DecisionsOK + snap.DecisionsFallback
	if used > s.lastCounters {
		s.lastCounters = used
		s.lastDecideAt = s.now()
	}
	if s.lastDecideAt.IsZero() {
		return false // never used adapt: stay idle, never probe
	}
	now := s.now()
	if now.Sub(s.lastDecideAt) < jevProbeIdleInterval {
		return false
	}
	if !s.lastProbeAt.IsZero() && now.Sub(s.lastProbeAt) < jevProbeIdleInterval {
		return false // at most one probe per interval
	}
	s.lastProbeAt = now
	// Fail-open: Probe already recorded its own outcome in the snapshot.
	_ = s.client.Probe(ctx)
	return true
}

// jevProbeLoop drives the scheduler until ctx is done. Nil-safe for Daemon
// literals built without the Jev wiring.
func (d *Daemon) jevProbeLoop(ctx context.Context) {
	if d.jevProbe == nil {
		return
	}
	ticker := time.NewTicker(jevProbeTickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.jevProbe.tick(ctx)
		}
	}
}
