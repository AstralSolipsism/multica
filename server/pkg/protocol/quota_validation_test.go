package protocol

import (
	"math"
	"strings"
	"testing"
	"time"
)

func validPlanQuotaPayload(observedAt int64) *RuntimePlanQuota {
	used := 42.5
	minutes := int64(300)
	return &RuntimePlanQuota{
		Provider: "codex",
		Status:   PlanQuotaStatusOK,
		Windows: []RuntimePlanQuotaWindow{
			{Name: "primary", UsedPercent: &used, WindowMinutes: &minutes},
		},
		ObservedAt: observedAt,
		Source:     PlanQuotaSourceDaemon,
	}
}

// TestValidateRuntimePlanQuota pins the wire-contract validation: bounds,
// normalization, the required fields, and the future-clock skew guard.
func TestValidateRuntimePlanQuota(t *testing.T) {
	t.Parallel()
	now := time.Now()

	t.Run("valid payload normalizes empty status", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Status = ""
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if q.Status != PlanQuotaStatusOK {
			t.Fatalf("status = %q, want ok", q.Status)
		}
	})

	t.Run("provider required", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Provider = ""
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for empty provider")
		}
	})

	t.Run("observed_at must be positive", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(0)
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for observed_at=0")
		}
	})

	t.Run("observed_at within the skew allowance is accepted", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Add(PlanQuotaMaxFutureSkew).Unix())
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate at skew boundary: %v", err)
		}
	})

	t.Run("observed_at beyond the skew allowance is rejected", func(t *testing.T) {
		t.Parallel()
		// A far-future timestamp would otherwise pin the row and suppress
		// every later snapshot ("newer observed_at wins").
		q := validPlanQuotaPayload(now.Add(PlanQuotaMaxFutureSkew + time.Hour).Unix())
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for far-future observed_at")
		}
	})

	t.Run("bogus status rejected", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Status = "exhausted"
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for unknown status")
		}
	})

	t.Run("too many windows", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		for len(q.Windows) < PlanQuotaMaxWindows+1 {
			q.Windows = append(q.Windows, RuntimePlanQuotaWindow{Name: "w"})
		}
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for >8 windows")
		}
	})

	t.Run("window name bounds", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Windows[0].Name = ""
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for empty window name")
		}
		q.Windows[0].Name = strings.Repeat("x", PlanQuotaMaxWindowName)
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate at window name boundary: %v", err)
		}
		q.Windows[0].Name = strings.Repeat("x", PlanQuotaMaxWindowName+1)
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized window name")
		}
	})

	t.Run("window minutes range", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		zero := int64(0)
		q.Windows[0].WindowMinutes = &zero
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for window_minutes=0")
		}
		over := int64(PlanQuotaMaxWindowMinutes + 1)
		q.Windows[0].WindowMinutes = &over
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized window_minutes")
		}
	})

	t.Run("used percent range", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		negative := -1.0
		q.Windows[0].UsedPercent = &negative
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for negative used_percent")
		}
		over := float64(PlanQuotaMaxUsedPercent + 1)
		q.Windows[0].UsedPercent = &over
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized used_percent")
		}
	})

	t.Run("group label bounds", func(t *testing.T) {
		t.Parallel()
		// The optional group labels providers with several quota pools
		// (antigravity's gemini / claude_gpt) are free-form but bounded, and
		// omission stays legal for single-pool providers.
		q := validPlanQuotaPayload(now.Unix())
		q.Windows[0].Group = "gemini"
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate with group: %v", err)
		}
		q.Windows[0].Group = strings.Repeat("x", PlanQuotaMaxGroupName)
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate at group boundary: %v", err)
		}
		q.Windows[0].Group = strings.Repeat("x", PlanQuotaMaxGroupName+1)
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized group")
		}
	})

	t.Run("real zero values are accepted", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		zeroPercent := 0.0
		q.Windows[0].UsedPercent = &zeroPercent
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate: %v", err)
		}
	})
}

func TestValidateRuntimePlanQuotaGroupedWindow(t *testing.T) {
	now := time.Now()
	for _, group := range []string{"gemini", "claude_gpt"} {
		q := validPlanQuotaPayload(now.Unix())
		q.Windows[0].Name = ""
		q.Windows[0].Group = group
		if err := ValidateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("deployed grouped window: %v", err)
		}
	}
	for _, group := range []string{"", "  ", strings.Repeat("x", PlanQuotaMaxGroupName+1)} {
		q := validPlanQuotaPayload(now.Unix())
		q.Windows[0].Name = ""
		q.Windows[0].Group = group
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatalf("accepted invalid unnamed group %q", group)
		}
	}
	if err := ValidateRuntimePlanQuota(nil, now); err == nil {
		t.Fatal("accepted nil quota")
	}
	for _, used := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		q := validPlanQuotaPayload(now.Unix())
		q.Windows[0].UsedPercent = &used
		if err := ValidateRuntimePlanQuota(q, now); err == nil {
			t.Fatalf("accepted non-JSON percentage %v", used)
		}
	}
}
