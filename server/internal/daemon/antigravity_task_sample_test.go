package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// stubAntigravityQuotaFunc pins the probe to a per-round script: round N
// (1-based) calls fn with N. Returns the round counter.
func stubAntigravityQuotaFunc(t *testing.T, fn func(round int32) (*protocol.RuntimePlanQuota, error)) *int32 {
	t.Helper()
	orig := antigravityQuotaProbe
	var rounds int32
	antigravityQuotaProbe = func(_ context.Context, _, _ string, _ time.Time) (*protocol.RuntimePlanQuota, error) {
		return fn(atomic.AddInt32(&rounds, 1))
	}
	t.Cleanup(func() { antigravityQuotaProbe = orig })
	return &rounds
}

// setAntigravitySampleTunables shrinks the sampler tunables for one test and
// restores them on cleanup.
func setAntigravitySampleTunables(t *testing.T, window, retry, spawnGrace time.Duration) {
	t.Helper()
	origWindow, origRetry, origGrace := antigravityTaskSampleWindow, antigravityTaskSampleRetry, antigravityTaskSampleSpawnGrace
	antigravityTaskSampleWindow, antigravityTaskSampleRetry, antigravityTaskSampleSpawnGrace = window, retry, spawnGrace
	t.Cleanup(func() {
		antigravityTaskSampleWindow, antigravityTaskSampleRetry, antigravityTaskSampleSpawnGrace = origWindow, origRetry, origGrace
	})
}

// assertAntigravitySkip checks that the diagnostics carry exactly one skip
// reason.
func assertAntigravitySkip(t *testing.T, d *Daemon, want string) {
	t.Helper()
	diag := d.antigravityQuotaDiagSnapshot()
	if diag == nil {
		t.Fatal("no probe diagnostics recorded")
	}
	if diag.LastSkipReason != want {
		t.Fatalf("skip reason = %q, want %q", diag.LastSkipReason, want)
	}
}

func TestAntigravityTaskSamplerRecordsFirstSuccess(t *testing.T) {
	d := newQuotaProbeFixture(t)
	setAntigravitySampleTunables(t, time.Hour, time.Millisecond, time.Hour)
	snapshot := &protocol.RuntimePlanQuota{Provider: "antigravity", ObservedAt: 77}
	rounds := stubAntigravityQuotaFunc(t, func(round int32) (*protocol.RuntimePlanQuota, error) {
		if round == 1 {
			// The sampler can lose the race with the agy spawn on round 1.
			return nil, agent.ErrAntigravityNotRunning
		}
		return snapshot, nil
	})

	d.runAntigravityTaskSampler(context.Background())

	if got := atomic.LoadInt32(rounds); got != 2 {
		t.Fatalf("sampler ran %d round(s), want 2 (spawn-race miss, then success)", got)
	}
	if _, ok := d.planQuotaCache.Load("rt-agy"); !ok {
		t.Error("antigravity runtime got no snapshot from the task sampler")
	}
	if _, ok := d.planQuotaCache.Load("rt-codex"); ok {
		t.Error("codex runtime received the antigravity snapshot; sampling must stay provider-scoped")
	}
	diag := d.antigravityQuotaDiagSnapshot()
	if diag == nil || diag.LastSkipReason != "" || diag.LastSuccessAt == "" {
		t.Fatalf("diagnostics after success = %+v, want cleared reason and a success stamp", diag)
	}
}

func TestAntigravityTaskSamplerGivesUpWhenAgyNeverSpawns(t *testing.T) {
	d := newQuotaProbeFixture(t)
	setAntigravitySampleTunables(t, time.Hour, time.Millisecond, time.Nanosecond)
	rounds := stubAntigravityQuotaFunc(t, func(int32) (*protocol.RuntimePlanQuota, error) {
		return nil, agent.ErrAntigravityNotRunning
	})

	d.runAntigravityTaskSampler(context.Background())

	if got := atomic.LoadInt32(rounds); got != 1 {
		t.Fatalf("sampler ran %d round(s) with agy never spawning inside the grace window, want 1", got)
	}
	if _, ok := d.planQuotaCache.Load("rt-agy"); ok {
		t.Error("a failed sampling window must not leave a snapshot behind")
	}
	assertAntigravitySkip(t, d, antigravityQuotaSkipNotRunning)
}

func TestAntigravityTaskSamplerStopsWhenProcessExits(t *testing.T) {
	d := newQuotaProbeFixture(t)
	setAntigravitySampleTunables(t, time.Hour, time.Millisecond, time.Hour)
	rounds := stubAntigravityQuotaFunc(t, func(round int32) (*protocol.RuntimePlanQuota, error) {
		if round == 1 {
			// A generic failure implies the round reached a live process.
			return nil, errors.New("antigravity quota probe: no agy listener answered with a quota summary")
		}
		return nil, agent.ErrAntigravityNotRunning
	})

	d.runAntigravityTaskSampler(context.Background())

	// Round 1 saw the process, then antigravityTaskSampleExitMisses
	// consecutive rounds saw none: agy has exited, so the sampler stops
	// instead of burning the whole discovery window on a dead task.
	if got := atomic.LoadInt32(rounds); got != 1+int32(antigravityTaskSampleExitMisses) {
		t.Fatalf("sampler ran %d round(s), want %d", got, 1+antigravityTaskSampleExitMisses)
	}
	assertAntigravitySkip(t, d, antigravityQuotaSkipNotRunning)
}

func TestAntigravityTaskSamplerStopsAtDiscoveryWindow(t *testing.T) {
	d := newQuotaProbeFixture(t)
	setAntigravitySampleTunables(t, 5*time.Millisecond, time.Millisecond, time.Hour)
	rounds := stubAntigravityQuotaFunc(t, func(int32) (*protocol.RuntimePlanQuota, error) {
		return nil, errors.New("antigravity quota probe: no agy listener answered with a quota summary")
	})

	d.runAntigravityTaskSampler(context.Background())

	if got := atomic.LoadInt32(rounds); got < 2 {
		t.Fatalf("sampler ran %d round(s) inside its window, want retries before giving up", got)
	}
	assertAntigravitySkip(t, d, antigravityQuotaSkipNoListener)
}

func TestAntigravityTaskSamplerExitsOnTaskContextCancel(t *testing.T) {
	d := newQuotaProbeFixture(t)
	setAntigravitySampleTunables(t, time.Hour, 50*time.Millisecond, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rounds := stubAntigravityQuotaFunc(t, func(int32) (*protocol.RuntimePlanQuota, error) {
		cancel() // the task (and its agy process) ends right after round 1
		return nil, errors.New("antigravity quota probe: no agy listener answered with a quota summary")
	})

	done := make(chan struct{})
	go func() {
		d.runAntigravityTaskSampler(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("sampler did not exit after the task context was cancelled")
	}
	if got := atomic.LoadInt32(rounds); got != 1 {
		t.Fatalf("sampler ran %d round(s) after cancellation, want 1", got)
	}
}

func TestMaybeStartAntigravityTaskSamplerScopesToProvider(t *testing.T) {
	d := newQuotaProbeFixture(t)
	setAntigravitySampleTunables(t, time.Hour, time.Millisecond, time.Hour)
	snapshot := &protocol.RuntimePlanQuota{Provider: "antigravity"}
	rounds := stubAntigravityQuotaFunc(t, func(int32) (*protocol.RuntimePlanQuota, error) { return snapshot, nil })

	stop := d.maybeStartAntigravityTaskSampler(context.Background(), "codex")
	stop()
	time.Sleep(5 * time.Millisecond)
	if got := atomic.LoadInt32(rounds); got != 0 {
		t.Fatalf("a codex task started %d probe round(s); task sampling must stay antigravity-scoped", got)
	}

	stop = d.maybeStartAntigravityTaskSampler(context.Background(), "antigravity")
	defer stop()
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(rounds) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := atomic.LoadInt32(rounds); got == 0 {
		t.Fatal("an antigravity task never started the sampler")
	}
}

func TestAntigravityQuotaDiagnosticsStayNilUntilFirstAttempt(t *testing.T) {
	d := newQuotaProbeFixture(t)
	if diag := d.antigravityQuotaDiagSnapshot(); diag != nil {
		t.Fatalf("diagnostics before any attempt = %+v, want nil", diag)
	}
}

func TestAntigravityQuotaDiagnosticsTrackSkipThenSuccess(t *testing.T) {
	d := newQuotaProbeFixture(t)

	d.recordAntigravityQuotaSkip(antigravityQuotaSkipNoListener)
	diag := d.antigravityQuotaDiagSnapshot()
	if diag == nil || diag.LastSkipReason != antigravityQuotaSkipNoListener || diag.LastSuccessAt != "" {
		t.Fatalf("diagnostics after a skip = %+v, want reason %q and no success stamp", diag, antigravityQuotaSkipNoListener)
	}
	if _, err := time.Parse(time.RFC3339, diag.LastAttemptAt); err != nil {
		t.Errorf("last_attempt_at = %q is not RFC3339: %v", diag.LastAttemptAt, err)
	}

	d.recordAntigravityQuotaSuccess()
	diag = d.antigravityQuotaDiagSnapshot()
	if diag == nil || diag.LastSkipReason != "" || diag.LastSuccessAt == "" {
		t.Fatalf("diagnostics after a success = %+v, want cleared reason and a success stamp", diag)
	}
}

func TestAntigravityQuotaSkipReasonClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"not running", agent.ErrAntigravityNotRunning, antigravityQuotaSkipNotRunning},
		{"wrapped not running", fmt.Errorf("round 3: %w", agent.ErrAntigravityNotRunning), antigravityQuotaSkipNotRunning},
		{"version unsupported", fmt.Errorf("%w %q outside the probed range", agent.ErrAntigravityVersionUnsupported, "2.0.0"), antigravityQuotaSkipVersionUnsupported},
		{"listener aggregate", errors.New("antigravity quota probe: no agy listener answered with a quota summary"), antigravityQuotaSkipNoListener},
		{"nil", nil, ""},
	}
	for _, tc := range cases {
		if got := antigravityQuotaSkipReasonFor(tc.err); got != tc.want {
			t.Errorf("%s: reason = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestHealthHandlerCarriesAntigravityQuotaDiagnostics(t *testing.T) {
	d := newQuotaProbeFixture(t)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	rec := httptest.NewRecorder()
	d.healthHandler(time.Now()).ServeHTTP(rec, req)
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw response: %v", err)
	}
	if _, ok := raw["antigravity_quota"]; ok {
		t.Error("antigravity_quota present before any probe attempt; it must be omitted until then")
	}

	d.recordAntigravityQuotaSkip(antigravityQuotaSkipVersionUnsupported)
	rec = httptest.NewRecorder()
	d.healthHandler(time.Now()).ServeHTTP(rec, req)
	raw = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw response: %v", err)
	}
	quota, ok := raw["antigravity_quota"].(map[string]any)
	if !ok {
		t.Fatalf("antigravity_quota missing from /health: %s", rec.Body.String())
	}
	if quota["last_skip_reason"] != antigravityQuotaSkipVersionUnsupported {
		t.Errorf("last_skip_reason = %v, want %q", quota["last_skip_reason"], antigravityQuotaSkipVersionUnsupported)
	}
	if _, ok := quota["last_attempt_at"].(string); !ok {
		t.Errorf("last_attempt_at = %v, want an RFC3339 string", quota["last_attempt_at"])
	}
}
