package protocol

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Table-driven coverage for the account-pool validation contract (bounds,
// statuses, counts, and the "@" identity guard). OL-1259.
func TestValidateRuntimePlanQuotaAccountPools(t *testing.T) {
	now := time.Now()
	account := func(label string) RuntimePlanQuotaAccount {
		return RuntimePlanQuotaAccount{
			Label:  label,
			Status: PlanQuotaAccountOK,
			Windows: []RuntimePlanQuotaWindow{
				{Name: "5h", WindowMinutes: int64Ptr(300), UsedPercent: floatPtr(10)},
			},
		}
	}
	pool := func(mutate func(*RuntimePlanQuotaAccountPool)) RuntimePlanQuotaAccountPool {
		p := RuntimePlanQuotaAccountPool{
			ID:                "kimi-code",
			TotalAccounts:     2,
			AvailableAccounts: 2,
			DisabledAccounts:  0,
			Status:            PlanQuotaStatusOK,
			Accounts:          []RuntimePlanQuotaAccount{account("19*"), account("as*")},
		}
		if mutate != nil {
			mutate(&p)
		}
		return p
	}
	withPools := func(pools ...RuntimePlanQuotaAccountPool) *RuntimePlanQuota {
		return &RuntimePlanQuota{
			Provider:     "omp",
			Status:       PlanQuotaStatusOK,
			ObservedAt:   now.Unix(),
			Source:       PlanQuotaSourceDaemon,
			AccountPools: pools,
		}
	}

	t.Run("accepts a well-formed pool set and defaults empty statuses", func(t *testing.T) {
		q := withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Status = "" }))
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("valid pools rejected: %v", err)
		}
		if q.AccountPools[0].Status != PlanQuotaStatusOK {
			t.Fatalf("pool status not defaulted: %q", q.AccountPools[0].Status)
		}
		// An empty account status defaults to unknown.
		acc := account("de*")
		acc.Status = ""
		p := pool(func(x *RuntimePlanQuotaAccountPool) { x.Accounts = []RuntimePlanQuotaAccount{acc} })
		if err := ValidateRuntimePlanQuota(withPools(p), now); err != nil {
			t.Fatalf("empty account status rejected: %v", err)
		}
	})

	rejects := []struct {
		name  string
		build func() *RuntimePlanQuota
		want  string
	}{
		{"pool id required", func() *RuntimePlanQuota {
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.ID = "" }))
		}, "id is required"},
		{"pool id too long", func() *RuntimePlanQuota {
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.ID = strings.Repeat("x", PlanQuotaMaxGroupName+1) }))
		}, "at most"},
		{"zero total accounts", func() *RuntimePlanQuota {
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.TotalAccounts = 0 }))
		}, "total_accounts must be positive"},
		{"available over total", func() *RuntimePlanQuota {
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.AvailableAccounts = 3 }))
		}, "available_accounts out of range"},
		{"disabled negative", func() *RuntimePlanQuota {
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.DisabledAccounts = -1 }))
		}, "disabled_accounts out of range"},
		{"unsupported pool status", func() *RuntimePlanQuota {
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Status = "hungry" }))
		}, "unsupported status"},
		{"too many pools", func() *RuntimePlanQuota {
			pools := make([]RuntimePlanQuotaAccountPool, PlanQuotaMaxAccountPools+1)
			for i := range pools {
				pools[i] = pool(nil)
			}
			return withPools(pools...)
		}, "at most"},
		{"too many accounts", func() *RuntimePlanQuota {
			p := pool(func(x *RuntimePlanQuotaAccountPool) {
				accounts := make([]RuntimePlanQuotaAccount, PlanQuotaMaxAccountsPerPool+1)
				for i := range accounts {
					accounts[i] = account(fmt.Sprintf("a%d*", i))
				}
				x.Accounts = accounts
				x.TotalAccounts = len(accounts)
				x.AvailableAccounts = len(accounts)
			})
			return withPools(p)
		}, "at most"},
		{"account label required", func() *RuntimePlanQuota {
			acc := account("")
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "label is required"},
		{"account label too long", func() *RuntimePlanQuota {
			acc := account(strings.Repeat("x", PlanQuotaMaxAccountLabel+1))
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "at most"},
		{"identity string in label", func() *RuntimePlanQuota {
			acc := account("someone@example.com")
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "must not carry identity"},
		{"identity string in note", func() *RuntimePlanQuota {
			acc := account("19*")
			acc.Note = "oauth failed for someone@example.com"
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "must not carry identity"},
		{"unsupported account status", func() *RuntimePlanQuota {
			acc := account("19*")
			acc.Status = "sleepy"
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "unsupported status"},
		{"note too long", func() *RuntimePlanQuota {
			acc := account("19*")
			acc.Note = strings.Repeat("x", PlanQuotaMaxAccountNote+1)
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "at most"},
		{"too many account windows", func() *RuntimePlanQuota {
			acc := account("19*")
			acc.Windows = make([]RuntimePlanQuotaWindow, PlanQuotaMaxWindows+1)
			for i := range acc.Windows {
				acc.Windows[i] = RuntimePlanQuotaWindow{Name: fmt.Sprintf("w%d", i)}
			}
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "at most"},
		{"malformed account window", func() *RuntimePlanQuota {
			acc := account("19*")
			acc.Windows = []RuntimePlanQuotaWindow{{Name: "", Group: ""}}
			return withPools(pool(func(p *RuntimePlanQuotaAccountPool) { p.Accounts = []RuntimePlanQuotaAccount{acc} }))
		}, "name or group is required"},
	}
	for _, tc := range rejects {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateRuntimePlanQuota(tc.build(), now)
			if err == nil {
				t.Fatalf("expected rejection containing %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

func int64Ptr(v int64) *int64     { return &v }
func floatPtr(v float64) *float64 { return &v }
