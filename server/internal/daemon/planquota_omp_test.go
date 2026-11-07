package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ompUsageFixture builds an `omp usage --json --redact` payload.
func ompWindowFix(id string, durationMs, resetsAtMs float64) map[string]any {
	return map[string]any{"id": id, "label": id + " Window", "durationMs": durationMs, "resetsAt": resetsAtMs}
}

func TestOmpUsageToPlanQuota_MultiProviderMultiAccount(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	reset5h := float64((now.Unix() + 3600) * 1000)
	reset7d := float64((now.Unix() + 5*24*3600) * 1000)
	acc := func(label string, frac5h, frac7d float64, status string) map[string]any {
		limits := []any{
			map[string]any{
				"id": "kimi-5h", "label": "Kimi 5h",
				"scope":  map[string]any{"provider": "kimi-code", "accountId": label},
				"window": map[string]any{"id": "5h", "label": "5 Hour", "durationMs": 18_000_000.0, "resetsAt": reset5h},
				"amount": map[string]any{"usedFraction": frac5h},
				"status": status,
			},
			map[string]any{
				"id": "kimi-7d", "label": "Kimi 7d",
				"scope":  map[string]any{"provider": "kimi-code", "accountId": label},
				"window": map[string]any{"id": "7d", "label": "7 Day", "durationMs": 604_800_000.0, "resetsAt": reset7d},
				"amount": map[string]any{"usedFraction": frac7d},
				"status": status,
			},
		}
		return map[string]any{
			"provider": "kimi-code",
			"limits":   limits,
			"metadata": map[string]any{"email": label},
		}
	}
	payload := map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{
			// Account 1: 5h exhausted, 7d fine -> exhausted account.
			acc("19*", 1.0, 0.35, "exhausted"),
			// Account 2: healthy.
			acc("as*", 0.15, 0.20, "ok"),
			acc("de*", 0.0, 0.05, "ok"),
		},
		"accountsWithoutUsage": []any{},
		"disabledCredentials":  []any{},
		"capacity": map[string]any{
			"kimi-code": []any{map[string]any{
				"window": "5h", "durationMs": 18_000_000.0,
				"accounts": 3, "usedAccounts": 1.15, "remainingAccounts": 1.85,
			}},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatalf("ompUsageToPlanQuota: %v", err)
	}
	if err := protocol.ValidateRuntimePlanQuota(quota, now); err != nil {
		t.Fatalf("snapshot failed wire validation: %v", err)
	}
	if len(quota.AccountPools) != 1 {
		t.Fatalf("pools = %d, want 1", len(quota.AccountPools))
	}
	pool := quota.AccountPools[0]
	if pool.ID != "kimi-code" || pool.TotalAccounts != 3 || pool.AvailableAccounts != 2 || pool.DisabledAccounts != 0 {
		t.Fatalf("pool = %+v", pool)
	}
	// OR health: one exhausted account of three must NOT limit the pool.
	if pool.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("pool status = %q, want ok (parallel OR)", pool.Status)
	}
	if quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("runtime status = %q, want ok", quota.Status)
	}
	if len(pool.Accounts) != 3 {
		t.Fatalf("accounts = %d", len(pool.Accounts))
	}
	if pool.Accounts[0].Status != protocol.PlanQuotaAccountExhausted {
		t.Fatalf("account 0 status = %q", pool.Accounts[0].Status)
	}
	if len(pool.Accounts[0].Windows) != 2 {
		t.Fatalf("account 0 windows = %d", len(pool.Accounts[0].Windows))
	}
	// The flat window list stays empty for pooled providers.
	if len(quota.Windows) != 0 {
		t.Fatalf("top-level windows = %d, want 0", len(quota.Windows))
	}
}

func TestOmpUsageToPlanQuota_AllAccountsExhausted(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	soon := float64((now.Unix() + 4320) * 1000) // 1h12m
	later := float64((now.Unix() + 90000) * 1000)
	acc := func(label string, resetMs float64) map[string]any {
		return map[string]any{
			"provider": "kimi-code",
			"limits": []any{map[string]any{
				"id": "kimi-5h", "label": "Kimi 5h",
				"scope":  map[string]any{"provider": "kimi-code", "accountId": label},
				"window": map[string]any{"id": "5h", "durationMs": 18_000_000.0, "resetsAt": resetMs},
				"amount": map[string]any{"usedFraction": 1.0},
				"status": "exhausted",
			}},
			"metadata": map[string]any{"email": label},
		}
	}
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports":     []any{acc("19*", soon), acc("as*", later)},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	pool := quota.AccountPools[0]
	if pool.Status != protocol.PlanQuotaStatusLimited || pool.AvailableAccounts != 0 {
		t.Fatalf("pool = %+v", pool)
	}
	if quota.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("runtime status = %q, want limited", quota.Status)
	}
	// Recovery = the EARLIEST reset among the exhausted accounts.
	if pool.ResumesAt == nil || *pool.ResumesAt != now.Unix()+4320 {
		t.Fatalf("resumes_at = %v, want %d", pool.ResumesAt, now.Unix()+4320)
	}
}

func TestOmpUsageToPlanQuota_DisabledCredentialsAndUnknownAccounts(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "anthropic",
			"limits": []any{map[string]any{
				"id": "claude-5h", "label": "Claude 5h",
				"scope":  map[string]any{"provider": "anthropic", "accountId": "ca*9*"},
				"window": map[string]any{"id": "5h", "durationMs": 18_000_000.0},
				"amount": map[string]any{"usedFraction": 0.1},
				"status": "ok",
			}},
			"metadata": map[string]any{"email": "ca*9*"},
		}},
		"accountsWithoutUsage": []any{map[string]any{
			"provider": "anthropic", "type": "oauth", "email": "ce*2*",
		}},
		"disabledCredentials": []any{map[string]any{
			"provider": "anthropic", "type": "oauth", "email": "di*7*",
			"cause": "oauth refresh failed",
		}},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	pool := quota.AccountPools[0]
	if pool.ID != "anthropic" || pool.TotalAccounts != 3 || pool.AvailableAccounts != 1 || pool.DisabledAccounts != 1 {
		t.Fatalf("pool = %+v", pool)
	}
	var disabled *protocol.RuntimePlanQuotaAccount
	for i := range pool.Accounts {
		if pool.Accounts[i].Status == protocol.PlanQuotaAccountDisabled {
			disabled = &pool.Accounts[i]
		}
	}
	if disabled == nil {
		t.Fatalf("no disabled account in %+v", pool.Accounts)
	}
	if disabled.Label != "di*7*" || disabled.Note != "credential disabled; re-login required" {
		t.Fatalf("disabled = %+v", disabled)
	}
}

func TestOmpUsageToPlanQuota_EmptyOutputIsNoReport(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"generatedAt": 1, "reports": []any{}})
	quota, err := ompUsageToPlanQuota(raw, time.Now())
	if err != nil {
		t.Fatalf("empty output must not error: %v", err)
	}
	if quota != nil {
		t.Fatalf("quota = %+v, want nil", quota)
	}
}

func TestOmpUsageToPlanQuota_RejectsUnredactedIdentities(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "anthropic",
			"limits": []any{map[string]any{
				"id": "claude-5h", "label": "Claude 5h",
				"scope":  map[string]any{"provider": "anthropic", "accountId": "someone@example.com"},
				"window": map[string]any{"id": "5h", "durationMs": 18_000_000.0},
				"amount": map[string]any{"usedFraction": 0.1},
			}},
			"metadata": map[string]any{"email": "someone@example.com"},
		}},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	// The parser produces the snapshot; the shared wire validator is the
	// privacy gate and must reject a plaintext email label.
	if err := protocol.ValidateRuntimePlanQuota(quota, now); err == nil {
		t.Fatal("validator accepted an unredacted email label")
	}
}

func TestOmpPlanQuotaCollector_CommandFailures(t *testing.T) {
	c := &ompPlanQuotaCollector{runCommand: func(context.Context) ([]byte, error) {
		return nil, fmt.Errorf("exit status 1")
	}}
	if _, err := c.collect(context.Background()); err == nil {
		t.Fatal("non-zero exit must fail the round")
	}
	c = &ompPlanQuotaCollector{runCommand: func(context.Context) ([]byte, error) {
		return []byte("not json"), nil
	}}
	if _, err := c.collect(context.Background()); err == nil {
		t.Fatal("garbage output must fail the round")
	}
}

// The loop records one omp snapshot for every omp runtime across all
// workspaces of this daemon (same-source broadcast), and skips collection
// when no omp runtime is registered.
func TestOmpPlanQuotaLoop_RecordsAllOmpRuntimes(t *testing.T) {
	d := &Daemon{
		cfg:    Config{},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		workspaces: map[string]*workspaceState{
			"ws-1": {runtimeIDs: []string{"rt-omp-1", "rt-kimi"}},
			"ws-2": {runtimeIDs: []string{"rt-omp-2"}},
		},
		runtimeIndex: map[string]Runtime{
			"rt-omp-1": {ID: "rt-omp-1", Provider: "omp"},
			"rt-omp-2": {ID: "rt-omp-2", Provider: "omp"},
			"rt-kimi":  {ID: "rt-kimi", Provider: "kimi"},
		},
	}
	now := time.Unix(1_800_000_000, 0)
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "kimi-code",
			"limits": []any{map[string]any{
				"id": "kimi-5h", "label": "Kimi 5h",
				"scope":  map[string]any{"provider": "kimi-code", "accountId": "19*"},
				"window": map[string]any{"id": "5h", "durationMs": 18_000_000.0},
				"amount": map[string]any{"usedFraction": 0.2},
				"status": "ok",
			}},
			"metadata": map[string]any{"email": "19*"},
		}},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.ompPlanQuotaLoopWithCommand(ctx, 5*time.Millisecond, func(context.Context) ([]byte, error) {
		return raw, nil
	})
	waitForQuotaCondition(t, "omp snapshots recorded", func() bool {
		for _, id := range []string{"rt-omp-1", "rt-omp-2"} {
			v, ok := d.planQuotaCache.Load(id)
			if !ok {
				return false
			}
			entry := v.(planQuotaCacheEntry)
			if entry.quota == nil || entry.quota.Provider != "omp" || len(entry.quota.AccountPools) != 1 {
				return false
			}
		}
		// The kimi runtime must stay untouched by the omp collector.
		if _, ok := d.planQuotaCache.Load("rt-kimi"); ok {
			t.Fatal("omp collector wrote the kimi runtime's snapshot")
		}
		return true
	})
}

// ompPlanQuotaLoopWithCommand is the loop with an injected command runner,
// for tests.
func (d *Daemon) ompPlanQuotaLoopWithCommand(ctx context.Context, interval time.Duration, run func(context.Context) ([]byte, error)) {
	c := &ompPlanQuotaCollector{runCommand: run}
	d.runPlanQuotaCollector(ctx, ompQuotaProvider, interval,
		func() []string { return d.runtimeIDsForProvider(ompQuotaProvider) },
		c.collect)
}

// Redacted payloads never carry an email into the snapshot JSON.
func TestOmpSnapshotJSONCarriesNoEmail(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw, _ := json.Marshal(map[string]any{
		"generatedAt": now.UnixMilli(),
		"reports": []any{map[string]any{
			"provider": "zai",
			"limits": []any{map[string]any{
				"id": "zai-5h", "label": "ZAI 5h",
				"scope":  map[string]any{"provider": "zai", "accountId": "ze*1*"},
				"window": map[string]any{"id": "5h", "durationMs": 18_000_000.0},
				"amount": map[string]any{"usedFraction": 0.5},
				"status": "ok",
			}},
			"metadata": map[string]any{"email": "ze*1*"},
		}},
	})
	quota, err := ompUsageToPlanQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := json.Marshal(quota)
	if strings.Contains(string(blob), "@") {
		t.Fatalf("snapshot carries an identity string: %s", blob)
	}
}
