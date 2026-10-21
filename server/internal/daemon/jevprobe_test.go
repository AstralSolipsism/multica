package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// fakeJevProber counts probes and serves a mutable snapshot.
type fakeJevProber struct {
	snap    jev.Snapshot
	probes  int
	probeFn func() error
}

func (f *fakeJevProber) Snapshot() jev.Snapshot { return f.snap }

func (f *fakeJevProber) Probe(_ context.Context) error {
	f.probes++
	if f.probeFn != nil {
		return f.probeFn()
	}
	return nil
}

// TestJevProbeScheduler pins the contract §3 probe rule: probes fire only
// after real adaptive use, only once the engine has been idle for the full
// 10 minutes, and at most once per 10 minutes. A daemon that never used
// adapt never probes.
func TestJevProbeScheduler(t *testing.T) {
	t0 := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	ctx := context.Background()

	t.Run("never used adapt never probes", func(t *testing.T) {
		fake := &fakeJevProber{snap: jev.Snapshot{Status: jev.StatusIdle}}
		s := newJevProbeScheduler(fake)
		s.now = func() time.Time { return t0.Add(2 * time.Hour) }
		for i := 0; i < 3; i++ {
			if s.tick(ctx) {
				t.Fatal("probe fired on a never-used daemon")
			}
		}
		if fake.probes != 0 {
			t.Fatalf("probes = %d, want 0", fake.probes)
		}
	})

	t.Run("probes only after 10 idle minutes, at most once per window", func(t *testing.T) {
		fake := &fakeJevProber{snap: jev.Snapshot{Status: jev.StatusAvailable, DecisionsOK: 1}}
		s := newJevProbeScheduler(fake)
		now := t0
		s.now = func() time.Time { return now }

		// First tick observes the decision; not idle long enough yet.
		if s.tick(ctx) {
			t.Fatal("probe fired before the idle window elapsed")
		}
		now = now.Add(9 * time.Minute)
		if s.tick(ctx) {
			t.Fatal("probe fired at 9 minutes")
		}
		now = now.Add(time.Minute) // 10 minutes idle
		if !s.tick(ctx) || fake.probes != 1 {
			t.Fatalf("probe at 10 minutes: fired=%v probes=%d", fake.probes == 1, fake.probes)
		}
		// Still idle, but inside the one-probe-per-window limit.
		now = now.Add(5 * time.Minute)
		if s.tick(ctx) || fake.probes != 1 {
			t.Fatalf("second probe inside the window: probes=%d", fake.probes)
		}
		now = now.Add(6 * time.Minute) // 11 minutes since the probe
		if !s.tick(ctx) || fake.probes != 2 {
			t.Fatalf("probe after the next window: probes=%d", fake.probes)
		}
	})

	t.Run("a new decision resets the idle clock and itself suppresses probing", func(t *testing.T) {
		fake := &fakeJevProber{snap: jev.Snapshot{Status: jev.StatusAvailable, DecisionsOK: 1}}
		s := newJevProbeScheduler(fake)
		now := t0
		s.now = func() time.Time { return now }
		s.tick(ctx) // observe first decision

		now = now.Add(9 * time.Minute)
		fake.snap.DecisionsOK = 2 // a fresh decision arrived before the window closed
		s.tick(ctx)
		now = now.Add(2 * time.Minute) // only 2 minutes since that decision
		if s.tick(ctx) {
			t.Fatal("probe fired 2 minutes after a fresh decision")
		}
		if fake.probes != 0 {
			t.Fatalf("probes = %d, want 0", fake.probes)
		}
	})
}

// TestHeartbeatExtrasForThinkingAdapt pins the attachment rule: the Jev
// snapshot rides the heartbeat only of runtimes whose provider has thinking
// control at all (agent.ThinkingControlSupported), and a disabled engine
// reports unavailable while a never-called one reports idle.
func TestHeartbeatExtrasForThinkingAdapt(t *testing.T) {
	newTestDaemon := func(opts jev.Options) *Daemon {
		d := &Daemon{
			workspaces:   map[string]*workspaceState{},
			runtimeIndex: map[string]Runtime{},
		}
		d.jevClient = jev.New(opts)
		return d
	}

	t.Run("attached on thinking-capable provider, absent otherwise", func(t *testing.T) {
		d := newTestDaemon(jev.Options{})
		d.runtimeIndex["rt-claude"] = Runtime{ID: "rt-claude", Provider: "claude"}
		d.runtimeIndex["rt-copilot"] = Runtime{ID: "rt-copilot", Provider: "copilot"}

		claude := d.heartbeatExtrasFor("rt-claude")
		if claude.ThinkingAdapt == nil {
			t.Fatal("thinking-capable runtime heartbeat carries no snapshot")
		}
		if claude.ThinkingAdapt.Status != jev.StatusIdle {
			t.Fatalf("never-called engine status = %q, want idle", claude.ThinkingAdapt.Status)
		}
		if copilot := d.heartbeatExtrasFor("rt-copilot"); copilot.ThinkingAdapt != nil {
			t.Fatalf("non-thinking runtime heartbeat carries a snapshot: %+v", copilot.ThinkingAdapt)
		}
	})

	t.Run("disabled engine reports unavailable", func(t *testing.T) {
		d := newTestDaemon(jev.Options{Disabled: true})
		d.runtimeIndex["rt-claude"] = Runtime{ID: "rt-claude", Provider: "claude"}
		if snap := d.heartbeatExtrasFor("rt-claude").ThinkingAdapt; snap == nil || snap.Status != jev.StatusUnavailable {
			t.Fatalf("disabled engine snapshot = %+v, want status=unavailable", snap)
		}
	})

	t.Run("unknown runtime id omits the field", func(t *testing.T) {
		d := newTestDaemon(jev.Options{})
		if snap := d.heartbeatExtrasFor("rt-missing").ThinkingAdapt; snap != nil {
			t.Fatalf("unknown runtime carries a snapshot: %+v", snap)
		}
	})
}

// TestSendWSHeartbeatsCarriesThinkingAdapt pins the WS wire (issue「要做 1」):
// the daemon:heartbeat frame assembled by sendWSHeartbeats carries the Jev
// snapshot for a thinking-capable runtime and omits it otherwise.
func TestSendWSHeartbeatsCarriesThinkingAdapt(t *testing.T) {
	d := &Daemon{
		workspaces:   map[string]*workspaceState{},
		runtimeIndex: map[string]Runtime{},
		logger:       slog.Default(),
	}
	d.jevClient = jev.New(jev.Options{})
	d.runtimeIndex["rt-claude"] = Runtime{ID: "rt-claude", Provider: "claude"}
	d.runtimeIndex["rt-copilot"] = Runtime{ID: "rt-copilot", Provider: "copilot"}

	writes := make(chan *wsOutbound, 4)
	d.sendWSHeartbeats(context.Background(), []string{"rt-claude", "rt-copilot"}, writes)
	close(writes)

	frames := map[string]protocol.DaemonHeartbeatRequestPayload{}
	for item := range writes {
		var msg protocol.Message
		if err := json.Unmarshal(item.data, &msg); err != nil {
			t.Fatalf("unmarshal frame: %v", err)
		}
		var payload protocol.DaemonHeartbeatRequestPayload
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		frames[payload.RuntimeID] = payload
	}
	if len(frames) != 2 {
		t.Fatalf("frames = %v, want one per runtime", frames)
	}
	claude := frames["rt-claude"]
	if claude.ThinkingAdapt == nil || claude.ThinkingAdapt.Status != jev.StatusIdle {
		t.Fatalf("thinking-capable runtime WS heartbeat = %+v, want snapshot with idle", claude.ThinkingAdapt)
	}
	if copilot := frames["rt-copilot"]; copilot.ThinkingAdapt != nil {
		t.Fatalf("non-thinking runtime WS heartbeat carries a snapshot: %+v", copilot.ThinkingAdapt)
	}
}
