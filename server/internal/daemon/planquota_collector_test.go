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

func newQuotaLoopTestDaemon() *Daemon {
	return &Daemon{
		cfg:        Config{},
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		workspaces: map[string]*workspaceState{"ws-1": {runtimeIDs: []string{"rt-kimi", "rt-codex"}}},
		runtimeIndex: map[string]Runtime{
			"rt-kimi":  {ID: "rt-kimi", Provider: "kimi"},
			"rt-codex": {ID: "rt-codex", Provider: "codex"},
		},
	}
}

func waitForQuotaCondition(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestRuntimeIDsForProvider(t *testing.T) {
	d := newQuotaLoopTestDaemon()
	got := d.runtimeIDsForProvider("kimi")
	if len(got) != 1 || got[0] != "rt-kimi" {
		t.Fatalf("kimi ids = %v", got)
	}
	if got := d.runtimeIDsForProvider("codex", "kimi"); len(got) != 2 || got[0] != "rt-codex" || got[1] != "rt-kimi" {
		t.Fatalf("sorted ids = %v", got)
	}
	if got := d.runtimeIDsForProvider("hermes"); len(got) != 0 {
		t.Fatalf("hermes ids = %v", got)
	}
}

func TestRunPlanQuotaCollector_RecordsMatchingRuntimes(t *testing.T) {
	d := newQuotaLoopTestDaemon()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls atomic.Int64
	collect := func(context.Context) (*protocol.RuntimePlanQuota, error) {
		calls.Add(1)
		return &protocol.RuntimePlanQuota{
			Provider:   "kimi",
			Status:     protocol.PlanQuotaStatusOK,
			ObservedAt: time.Now().Unix(),
			Source:     protocol.PlanQuotaSourceDaemon,
			Windows:    []protocol.RuntimePlanQuotaWindow{{Name: "primary"}},
		}, nil
	}
	go d.runPlanQuotaCollector(ctx, "kimi", 10*time.Millisecond, []string{"kimi"}, collect)

	waitForQuotaCondition(t, "snapshot cached", func() bool {
		_, ok := d.planQuotaCache.Load("rt-kimi")
		return ok
	})
	cancel()
	if _, ok := d.planQuotaCache.Load("rt-codex"); ok {
		t.Fatal("codex runtime received a kimi snapshot")
	}
}

func TestRunPlanQuotaCollector_NoTargetsSkipsCollection(t *testing.T) {
	d := newQuotaLoopTestDaemon()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls atomic.Int64
	collect := func(context.Context) (*protocol.RuntimePlanQuota, error) {
		calls.Add(1)
		return nil, nil
	}
	done := make(chan struct{})
	go func() {
		d.runPlanQuotaCollector(ctx, "zenmux", 10*time.Millisecond, []string{"hermes"}, collect)
		close(done)
	}()

	// No hermes runtime registered: the source must never be polled.
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done
	if calls.Load() != 0 {
		t.Fatalf("collect called %d times with no target runtimes", calls.Load())
	}
}

func TestRunPlanQuotaCollector_FailureKeepsCache(t *testing.T) {
	d := newQuotaLoopTestDaemon()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	fail := func(context.Context) (*protocol.RuntimePlanQuota, error) {
		return nil, errors.New("source down")
	}
	done := make(chan struct{})
	go func() {
		d.runPlanQuotaCollector(ctx, "kimi", 10*time.Millisecond, []string{"kimi"}, fail)
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done
	if _, ok := d.planQuotaCache.Load("rt-kimi"); ok {
		t.Fatal("failed collection populated the cache")
	}
}

func TestRateLimitBackoff(t *testing.T) {
	base := 2 * time.Minute
	want := []time.Duration{4, 8, 16, 30, 30, 30, 30} // 2m<<4=32m hits the 30m cap
	for streak := 1; streak <= 7; streak++ {
		got := rateLimitBackoff(base, streak)
		if got != want[streak-1]*time.Minute {
			t.Fatalf("streak %d = %v, want %v", streak, got, want[streak-1]*time.Minute)
		}
	}
	if got := rateLimitBackoff(30*time.Minute, 3); got != planQuotaRateLimitMaxBackoff {
		t.Fatalf("cap = %v", got)
	}
	if got := rateLimitBackoff(base, 0); got != 4*time.Minute {
		t.Fatalf("streak 0 = %v", got)
	}
}
