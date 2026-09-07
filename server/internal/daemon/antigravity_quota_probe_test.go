package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// newQuotaProbeFixture builds a daemon with the antigravity CLI discovered and
// version-detected, plus one antigravity and one codex runtime locally
// tracked — the state a steady-state daemon has when the probe loop runs.
func newQuotaProbeFixture(t *testing.T) *Daemon {
	t.Helper()
	d := &Daemon{
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		workspaces:   make(map[string]*workspaceState),
		runtimeIndex: make(map[string]Runtime),
		agentVersions: map[string]string{
			"antigravity": "1.1.11",
		},
	}
	d.cfg.Agents = map[string]AgentEntry{
		"antigravity": {Path: "/fake/agy"},
		"codex":       {Path: "/fake/codex"},
	}
	d.runtimeIndex["rt-agy"] = Runtime{ID: "rt-agy", Provider: "antigravity"}
	d.runtimeIndex["rt-codex"] = Runtime{ID: "rt-codex", Provider: "codex"}
	return d
}

// quotaProbeStub records what the loop asked the probe to do.
type quotaProbeStub struct {
	calls int32
	quota *protocol.RuntimePlanQuota
	err   error
}

// stubAntigravityQuotaProbe pins the probe function to a canned result.
func stubAntigravityQuotaProbe(t *testing.T, quota *protocol.RuntimePlanQuota, err error) *quotaProbeStub {
	t.Helper()
	orig := antigravityQuotaProbe
	stub := &quotaProbeStub{quota: quota, err: err}
	antigravityQuotaProbe = func(ctx context.Context, execPath, version string, now time.Time) (*protocol.RuntimePlanQuota, error) {
		atomic.AddInt32(&stub.calls, 1)
		return stub.quota, stub.err
	}
	t.Cleanup(func() { antigravityQuotaProbe = orig })
	return stub
}

func TestRunAntigravityQuotaProbeRecordsSnapshotForProviderRuntimes(t *testing.T) {
	d := newQuotaProbeFixture(t)
	snapshot := &protocol.RuntimePlanQuota{Provider: "antigravity", ObservedAt: 1234}
	stub := stubAntigravityQuotaProbe(t, snapshot, nil)

	d.runAntigravityQuotaProbe(context.Background())

	if got := atomic.LoadInt32(&stub.calls); got != 1 {
		t.Fatalf("probe ran %d time(s), want 1", got)
	}
	if _, ok := d.planQuotaCache.Load("rt-agy"); !ok {
		t.Error("antigravity runtime has no cached snapshot; its next heartbeat would carry nothing")
	}
	if _, ok := d.planQuotaCache.Load("rt-codex"); ok {
		t.Error("codex runtime received the antigravity snapshot; the probe must stay provider-scoped")
	}
}

func TestRunAntigravityQuotaProbeFailureWritesNothing(t *testing.T) {
	d := newQuotaProbeFixture(t)
	stub := stubAntigravityQuotaProbe(t, nil, errors.New("no running agy process"))

	d.runAntigravityQuotaProbe(context.Background())

	if got := atomic.LoadInt32(&stub.calls); got != 1 {
		t.Fatalf("probe ran %d time(s), want 1", got)
	}
	if _, ok := d.planQuotaCache.Load("rt-agy"); ok {
		t.Error("failed probe left a snapshot behind; a degraded round must report nothing")
	}
}

func TestRunAntigravityQuotaProbeSkipsWhenNoProviderRuntime(t *testing.T) {
	d := newQuotaProbeFixture(t)
	delete(d.runtimeIndex, "rt-agy")
	stub := stubAntigravityQuotaProbe(t, nil, nil)

	d.runAntigravityQuotaProbe(context.Background())

	if got := atomic.LoadInt32(&stub.calls); got != 0 {
		t.Fatalf("probe ran %d time(s) with no antigravity runtime; process scans must not start", got)
	}
}

func TestRunAntigravityQuotaProbeSkipsWhenVersionUnknown(t *testing.T) {
	d := newQuotaProbeFixture(t)
	d.agentVersions = map[string]string{"antigravity": ""}
	stub := stubAntigravityQuotaProbe(t, nil, nil)

	d.runAntigravityQuotaProbe(context.Background())

	if got := atomic.LoadInt32(&stub.calls); got != 0 {
		t.Fatalf("probe ran %d time(s) with an undetected version; the gate must be fail-closed", got)
	}
}

func TestRunAntigravityQuotaProbeSkipsWhenCLINotDiscovered(t *testing.T) {
	d := newQuotaProbeFixture(t)
	delete(d.cfg.Agents, "antigravity")
	stub := stubAntigravityQuotaProbe(t, nil, nil)

	d.runAntigravityQuotaProbe(context.Background())

	if got := atomic.LoadInt32(&stub.calls); got != 0 {
		t.Fatalf("probe ran %d time(s) with the CLI undiscovered", got)
	}
}

func TestAntigravityQuotaLoopStopsOnContextCancel(t *testing.T) {
	d := newQuotaProbeFixture(t)
	origInterval := antigravityQuotaProbeInterval
	antigravityQuotaProbeInterval = 5 * time.Millisecond
	t.Cleanup(func() { antigravityQuotaProbeInterval = origInterval })
	stub := stubAntigravityQuotaProbe(t, &protocol.RuntimePlanQuota{Provider: "antigravity"}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		d.antigravityQuotaLoop(ctx)
		close(done)
	}()
	// Wait until at least one round ran, then stop the loop and confirm it
	// exits rather than leaking.
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&stub.calls) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("antigravityQuotaLoop did not exit after context cancellation")
	}
}
