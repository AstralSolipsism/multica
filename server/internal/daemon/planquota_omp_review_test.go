package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Review regression tests (OL-1259 first review): each pins a defect the
// reviewer reproduced against real OMP output shapes.

const ompReset5h = float64((1800000000 + 7200) * 1000)    // +2h
const ompReset7d = float64((1800000000 + 3*86400) * 1000) // +3d

func ompLimitJSON(id, windowID string, durationMs, resetsAtMs float64, frac float64, status string) map[string]any {
	limit := map[string]any{
		"id":     id,
		"label":  id,
		"scope":  map[string]any{"provider": "kimi-code", "accountId": "19*"},
		"amount": map[string]any{"usedFraction": frac},
	}
	if status != "" {
		limit["status"] = status
	}
	if windowID != "" || durationMs > 0 || resetsAtMs > 0 {
		window := map[string]any{}
		if windowID != "" {
			window["id"] = windowID
			window["label"] = windowID
		}
		if durationMs > 0 {
			window["durationMs"] = durationMs
		}
		if resetsAtMs > 0 {
			window["resetsAt"] = resetsAtMs
		}
		limit["window"] = window
	}
	return limit
}

// #1: a limit WITHOUT a window must not panic the daemon (nil deref) — it
// keys the bucket off the limit id and still produces a snapshot.
func TestOmpUsageToPlanQuota_LimitWithoutWindow(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "cursor",
			"limits": []any{
				// No window at all.
				ompLimitJSON("cursor-pro", "", 0, 0, 0.42, "ok"),
				// Scope windowId only.
				func() map[string]any {
					l := ompLimitJSON("cursor-team", "", 0, 0, 0.1, "ok")
					l["scope"] = map[string]any{"provider": "cursor", "accountId": "cu*", "windowId": "team"}
					return l
				}(),
			},
			"metadata": map[string]any{"email": "cu*"},
		}},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatalf("windowless limit must not fail: %v", err)
	}
	if err := protocol.ValidateRuntimePlanQuota(quota, now); err != nil {
		t.Fatalf("snapshot failed validation: %v", err)
	}
	pool := quota.AccountPools[0]
	if len(pool.Accounts) != 1 {
		t.Fatalf("accounts = %d", len(pool.Accounts))
	}
	names := []string{}
	for _, w := range pool.Accounts[0].Windows {
		names = append(names, w.Name)
	}
	// Bucket keys fall back: limit id, then scope windowId.
	if strings.Join(names, ",") != "cursor-pro,team" {
		t.Fatalf("window names = %v", names)
	}
}

// #2: the runner must inherit the daemon environment — a bun-shim omp
// (#!/usr/bin/env bun) cannot resolve bun on an empty PATH.
func TestOmpUsageRunner_InheritsEnvironment(t *testing.T) {
	dir := t.TempDir()
	// A shim that mirrors a bun-installed omp: relies on `env` finding a
	// runtime on PATH, and on FOO being exported.
	shim := filepath.Join(dir, "omp-shim")
	if err := os.WriteFile(shim, []byte("#!/bin/sh\nexec \"$OMP_TARGET\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "omp-target")
	if err := os.WriteFile(target, []byte("#!/bin/sh\necho '{\"reports\":[]}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMP_TARGET", target)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	run := newOmpUsageRunner(shim, 5*time.Second)
	out, err := run(context.Background())
	if err != nil {
		t.Fatalf("bun-style shim failed under runner: %v (exit 127 = empty env)", err)
	}
	var payload ompUsagePayload
	if err := json.Unmarshal(out, &payload); err != nil {
		t.Fatalf("shim output: %v", err)
	}
}

// #3: policy.state maps onto account status; inside-reserve is NOT usable.
func TestOmpUsageToPlanQuota_PolicyState(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	report := func(state string, frac float64) map[string]any {
		return map[string]any{
			"provider": "kimi-code",
			"limits":   []any{ompLimitJSON("kimi-5h", "5h", 18_000_000, ompReset5h, frac, "ok")},
			"metadata": map[string]any{"email": "19*"},
			"policy":   map[string]any{"state": state, "priority": 0, "reservePct": 10},
		}
	}
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{
			report("inside-reserve", 0.93),
			report("eligible", 0.30),
		},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	pool := quota.AccountPools[0]
	if pool.Accounts[0].Status != protocol.PlanQuotaAccountReserve {
		t.Fatalf("inside-reserve account status = %q", pool.Accounts[0].Status)
	}
	if pool.Accounts[1].Status != protocol.PlanQuotaAccountOK {
		t.Fatalf("eligible account status = %q", pool.Accounts[1].Status)
	}
	// Reserve is not usable: 1 of 2 available.
	if pool.AvailableAccounts != 1 {
		t.Fatalf("available = %d, want 1 (reserve excluded)", pool.AvailableAccounts)
	}
	if pool.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("pool status = %q, want ok", pool.Status)
	}

	// Both inside-reserve: known-unavailable pool -> limited.
	raw2, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports":     []any{report("inside-reserve", 0.93), report("exhausted", 1.0)},
	})
	quota2, err := ompUsageToPlanQuota(raw2, now)
	if err != nil {
		t.Fatal(err)
	}
	if quota2.AccountPools[0].Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("all-reserve pool status = %q, want limited", quota2.AccountPools[0].Status)
	}
}

// #4: a pool whose only accounts are unknown (usage endpoint failed / API
// key vendor without reports) must not render "exhausted".
func TestOmpUsageToPlanQuota_UnknownOnlyPoolStaysOK(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "kimi-code",
			"limits":   []any{ompLimitJSON("kimi-5h", "5h", 18_000_000, ompReset5h, 0.2, "ok")},
			"metadata": map[string]any{"email": "19*"},
		}},
		"accountsWithoutUsage": []any{map[string]any{
			"provider": "zai", "type": "oauth", "email": "ze*",
		}},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	var zai *protocol.RuntimePlanQuotaAccountPool
	for i := range quota.AccountPools {
		if quota.AccountPools[i].ID == "zai" {
			zai = &quota.AccountPools[i]
		}
	}
	if zai == nil {
		t.Fatal("zai pool missing")
	}
	if zai.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("unknown-only pool status = %q, want ok (unknown is not exhaustion)", zai.Status)
	}
	if quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("runtime status = %q, want ok", quota.Status)
	}
}

// #5: pool recovery waits for the LATEST reset among an account's exhausted
// windows (serial windows), then the earliest account wins.
func TestOmpUsageToPlanQuota_RecoveryWaitsForSlowestExhaustedWindow(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	// 5h healthy (+2h reset), 7d exhausted (+3d reset): the account recovers
	// in 3 days, not 2 hours.
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "anthropic",
			"limits": []any{
				ompLimitJSON("claude-5h", "5h", 18_000_000, ompReset5h, 0.30, "ok"),
				ompLimitJSON("claude-7d", "7d", 604_800_000, ompReset7d, 1.0, "exhausted"),
			},
			"metadata": map[string]any{"email": "ca*"},
		}},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	pool := quota.AccountPools[0]
	if pool.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("pool status = %q", pool.Status)
	}
	want := now.Unix() + 3*86400
	if pool.ResumesAt == nil || *pool.ResumesAt != want {
		t.Fatalf("resumes_at = %v, want %d (+3d, the exhausted 7d window)", pool.ResumesAt, want)
	}
}

// #6: kimi's weekly window carries resetsAt but NO durationMs — the reset
// and the canonical 7d duration must both survive.
func TestOmpUsageToPlanQuota_KimiWeeklyWindowWithoutDuration(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "kimi-code",
			"limits": []any{
				ompLimitJSON("kimi-5h", "5h", 18_000_000, ompReset5h, 0.4, "ok"),
				ompLimitJSON("kimi-7d", "7d", 0, ompReset7d, 0.5, "ok"), // no durationMs
			},
			"metadata": map[string]any{"email": "19*"},
		}},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	acc := quota.AccountPools[0].Accounts[0]
	var weekly *protocol.RuntimePlanQuotaWindow
	for i := range acc.Windows {
		if acc.Windows[i].Name == "7d" {
			weekly = &acc.Windows[i]
		}
	}
	if weekly == nil {
		t.Fatalf("no 7d window: %+v", acc.Windows)
	}
	if weekly.WindowMinutes == nil || *weekly.WindowMinutes != 10080 {
		t.Fatalf("7d window_minutes = %v, want 10080 (derived from the canonical id)", weekly.WindowMinutes)
	}
	if weekly.ResetsAt == nil || *weekly.ResetsAt != now.Unix()+3*86400 {
		t.Fatalf("7d resets_at = %v", weekly.ResetsAt)
	}
}

// #9: the REAL exec path must fail soft on a hanging subprocess — the
// injected timeout kills it and collection reports an error instead of
// blocking forever.
func TestOmpUsageRunner_TimeoutFailsSoft(t *testing.T) {
	dir := t.TempDir()
	hang := filepath.Join(dir, "omp-hang")
	if err := os.WriteFile(hang, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	run := newOmpUsageRunner(hang, 300*time.Millisecond)
	start := time.Now()
	_, err := run(context.Background())
	if err == nil {
		t.Fatal("hanging omp usage must return an error")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("timeout did not bound the subprocess (%v elapsed)", time.Since(start))
	}
	// Non-zero exit also fails soft (already covered for exit 1; prove the
	// real exec path reports it too).
	missing := filepath.Join(dir, "omp-missing")
	run = newOmpUsageRunner(missing, 5*time.Second)
	if _, err := run(context.Background()); err == nil {
		t.Fatal("missing executable must return an error")
	}
}

// #12: the disabled-credential note never forwards the verbatim upstream
// cause (it could carry an identity string and reject the snapshot).
func TestOmpDisabledNote_Fixed(t *testing.T) {
	note := ompDisabledNote()
	if strings.Contains(note, "@") {
		t.Fatalf("note must not forward upstream causes: %q", note)
	}
	if note != "credential disabled; re-login required" {
		t.Fatalf("note = %q", note)
	}
}

// OMP real-shape e2e through the collector: fake executable -> exec ->
// parse -> validate, covering the 0%-coverage func2 path.
func TestOmpPlanQuotaCollector_FakeExecutableEndToEnd(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "omp")
	script := fmt.Sprintf(`#!/bin/sh
case "$1" in
  usage) echo '%s' ;;
  *) exit 0 ;;
esac
`, `{"generatedAt":1800000000000,"reports":[{"provider":"kimi-code","limits":[{"id":"kimi-5h","label":"Kimi 5h","scope":{"provider":"kimi-code","accountId":"19*"},"window":{"id":"5h","label":"5 Hour","durationMs":18000000,"resetsAt":1800007200000},"amount":{"usedFraction":0.25},"status":"ok"}],"metadata":{"email":"19*"}}]}`)
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	c := &ompPlanQuotaCollector{runCommand: newOmpUsageRunner(fake, 5*time.Second)}
	quota, err := c.collect(context.Background())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if quota.Provider != "omp" || len(quota.AccountPools) != 1 {
		t.Fatalf("quota = %+v", quota)
	}
}

// #10: runtime-level status ORs across pools — one dead vendor pool must not
// limit the runtime while a sibling vendor still serves (aligned with the
// TS evaluatePlanQuotaPools summary).
func TestOmpUsageToPlanQuota_RuntimeStatusORsAcrossPools(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	deadPool := map[string]any{
		"provider": "zai",
		"limits": []any{
			ompLimitJSON("zai-5h", "5h", 18_000_000, ompReset5h, 1.0, "exhausted"),
		},
		"metadata": map[string]any{"email": "ze*"},
	}
	livePool := map[string]any{
		"provider": "kimi-code",
		"limits": []any{
			ompLimitJSON("kimi-5h", "5h", 18_000_000, ompReset5h, 0.2, "ok"),
		},
		"metadata": map[string]any{"email": "19*"},
	}
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports":     []any{deadPool, livePool},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(quota.AccountPools) != 2 {
		t.Fatalf("pools = %d", len(quota.AccountPools))
	}
	var deadLimited bool
	for _, p := range quota.AccountPools {
		if p.ID == "zai" {
			deadLimited = p.Status == protocol.PlanQuotaStatusLimited
		}
	}
	if !deadLimited {
		t.Fatal("zai pool should be limited")
	}
	if quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("runtime status = %q, want ok (sibling pool still serves)", quota.Status)
	}

	// Every pool dead -> runtime limited.
	rawAll, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports":     []any{deadPool},
	})
	quotaAll, err := ompUsageToPlanQuota(rawAll, now)
	if err != nil {
		t.Fatal(err)
	}
	if quotaAll.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("all-dead runtime status = %q, want limited", quotaAll.Status)
	}
}

// #18/#19: the issue's scenario-2 PRIMARY example — 5h exhausted, 7d still
// healthy. Recovery must be the earliest 5h reset (the exhausted window),
// not the latest reset across ALL windows (which would point at the healthy
// 7d reset days out). Failed before the fix: Go reported the 7d reset.
func TestOmpUsageToPlanQuota_RecoveryIgnoresHealthyWindows(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	reset5hA := float64((now.Unix() + 4320) * 1000)    // 1h12m
	reset5hB := float64((now.Unix() + 7200) * 1000)    // 2h
	reset7dA := float64((now.Unix() + 5*86400) * 1000) // 5d
	reset7dB := float64((now.Unix() + 6*86400) * 1000) // 6d
	account := func(label string, reset5h, reset7d float64) map[string]any {
		return map[string]any{
			"provider": "kimi-code",
			"limits": []any{
				// 5h used up (0% remaining) — the binding exhaustion.
				ompLimitJSON("kimi-5h", "5h", 18_000_000, reset5h, 1.0, "exhausted"),
				// 7d still has headroom.
				ompLimitJSON("kimi-7d", "7d", 604_800_000, reset7d, 0.35, "ok"),
			},
			"metadata": map[string]any{"email": label},
		}
	}
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports":     []any{account("19*", reset5hA, reset7dA), account("as*", reset5hB, reset7dB)},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	pool := quota.AccountPools[0]
	if pool.Status != protocol.PlanQuotaStatusLimited || pool.AvailableAccounts != 0 {
		t.Fatalf("pool = %+v", pool)
	}
	want := now.Unix() + 4320 // account #1's 5h reset — the earliest exhausted-window recovery
	if pool.ResumesAt == nil || *pool.ResumesAt != want {
		t.Fatalf("resumes_at = %v, want %d (+1h12m, the exhausted 5h reset of account #1)", pool.ResumesAt, want)
	}
}
