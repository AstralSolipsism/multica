package protocol

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

// PlanQuotaMaxFutureSkew bounds how far a snapshot's observed_at may run
// ahead of the server clock. Without it one reporter with a bad clock could
// pin the row to a far-future observed_at and suppress every later snapshot
// (the conditional write is "newer observed_at wins").
const PlanQuotaMaxFutureSkew = 10 * time.Minute

// ValidateRuntimePlanQuota normalizes and validates an incoming plan-quota
// snapshot against the wire contract. On success the quota's Status is
// normalized ("ok" when empty) and nil is returned; any violation is a hard
// error — callers either reject the request (push endpoint) or drop the
// field (heartbeat).
//
// Provider defaulting is NOT done here: the heartbeat requires the daemon
// to name its provider, while the push endpoint defaults it from the
// runtime row before calling this.
func ValidateRuntimePlanQuota(q *RuntimePlanQuota, now time.Time) error {
	if q == nil {
		return errors.New("plan quota: missing body")
	}
	if q.Provider == "" {
		return errors.New("plan quota: provider is required")
	}
	switch q.Status {
	case "":
		q.Status = PlanQuotaStatusOK
	case PlanQuotaStatusOK, PlanQuotaStatusLimited:
	default:
		return fmt.Errorf("plan quota: unsupported status %q", q.Status)
	}
	if q.ObservedAt <= 0 {
		return errors.New("plan quota: observed_at must be positive unix seconds")
	}
	if q.ObservedAt > now.Add(PlanQuotaMaxFutureSkew).Unix() {
		return errors.New("plan quota: observed_at is too far in the future")
	}
	if len(q.Windows) > PlanQuotaMaxWindows {
		return fmt.Errorf("plan quota: at most %d windows allowed", PlanQuotaMaxWindows)
	}
	for i := range q.Windows {
		if err := validatePlanQuotaWindow(&q.Windows[i]); err != nil {
			return err
		}
	}
	if err := validatePlanQuotaAccountPools(q.AccountPools); err != nil {
		return err
	}
	return nil
}

// validatePlanQuotaWindow validates one window in place. Shared by the
// top-level list and the per-account window lists of provider pools.
func validatePlanQuotaWindow(w *RuntimePlanQuotaWindow) error {
	if w.Name == "" && strings.TrimSpace(w.Group) == "" {
		return errors.New("plan quota: window name or group is required")
	}
	if len(w.Name) > PlanQuotaMaxWindowName {
		return fmt.Errorf("plan quota: window %q name must be at most %d chars", w.Name, PlanQuotaMaxWindowName)
	}
	if w.WindowMinutes != nil && (*w.WindowMinutes <= 0 || *w.WindowMinutes > PlanQuotaMaxWindowMinutes) {
		return fmt.Errorf("plan quota: window %q window_minutes out of range", w.Name)
	}
	if w.UsedPercent != nil && (math.IsNaN(*w.UsedPercent) || math.IsInf(*w.UsedPercent, 0) || *w.UsedPercent < 0 || *w.UsedPercent > PlanQuotaMaxUsedPercent) {
		return fmt.Errorf("plan quota: window %q used_percent out of range", w.Name)
	}
	if len(w.Group) > PlanQuotaMaxGroupName {
		return fmt.Errorf("plan quota: window %q group must be at most %d chars", w.Name, PlanQuotaMaxGroupName)
	}
	return nil
}

// validatePlanQuotaAccountPools validates the multi-account provider pools.
// The privacy red line: an account Label/Note carrying "@" is rejected —
// pool labels are redacted identifiers, never emails or ids.
func validatePlanQuotaAccountPools(pools []RuntimePlanQuotaAccountPool) error {
	if len(pools) > PlanQuotaMaxAccountPools {
		return fmt.Errorf("plan quota: at most %d account pools allowed", PlanQuotaMaxAccountPools)
	}
	for i := range pools {
		p := &pools[i]
		if p.ID == "" {
			return fmt.Errorf("plan quota: account pool %d id is required", i)
		}
		if len(p.ID) > PlanQuotaMaxGroupName {
			return fmt.Errorf("plan quota: account pool %q id must be at most %d chars", p.ID, PlanQuotaMaxGroupName)
		}
		if p.TotalAccounts <= 0 {
			return fmt.Errorf("plan quota: account pool %q total_accounts must be positive", p.ID)
		}
		if p.AvailableAccounts < 0 || p.AvailableAccounts > p.TotalAccounts {
			return fmt.Errorf("plan quota: account pool %q available_accounts out of range", p.ID)
		}
		if p.DisabledAccounts < 0 || p.DisabledAccounts > p.TotalAccounts {
			return fmt.Errorf("plan quota: account pool %q disabled_accounts out of range", p.ID)
		}
		switch p.Status {
		case "":
			p.Status = poolStatusForCounts(*p)
		case PlanQuotaStatusOK, PlanQuotaStatusLimited:
		default:
			return fmt.Errorf("plan quota: account pool %q unsupported status %q", p.ID, p.Status)
		}
		if len(p.Accounts) > PlanQuotaMaxAccountsPerPool {
			return fmt.Errorf("plan quota: account pool %q allows at most %d accounts", p.ID, PlanQuotaMaxAccountsPerPool)
		}
		for j := range p.Accounts {
			a := &p.Accounts[j]
			if a.Label == "" {
				return fmt.Errorf("plan quota: account pool %q account %d label is required", p.ID, j)
			}
			if len(a.Label) > PlanQuotaMaxAccountLabel {
				return fmt.Errorf("plan quota: account pool %q account %q label must be at most %d chars", p.ID, a.Label, PlanQuotaMaxAccountLabel)
			}
			if strings.Contains(a.Label, "@") || strings.Contains(a.Note, "@") {
				return fmt.Errorf("plan quota: account pool %q account %q must not carry identity strings", p.ID, a.Label)
			}
			switch a.Status {
			case "":
				a.Status = PlanQuotaAccountUnknown
			case PlanQuotaAccountOK, PlanQuotaAccountWarning, PlanQuotaAccountExhausted, PlanQuotaAccountReserve, PlanQuotaAccountDisabled, PlanQuotaAccountUnknown:
			default:
				return fmt.Errorf("plan quota: account pool %q account %q unsupported status %q", p.ID, a.Label, a.Status)
			}
			if len(a.Note) > PlanQuotaMaxAccountNote {
				return fmt.Errorf("plan quota: account pool %q account %q note must be at most %d chars", p.ID, a.Label, PlanQuotaMaxAccountNote)
			}
			if len(a.Windows) > PlanQuotaMaxWindows {
				return fmt.Errorf("plan quota: account pool %q account %q allows at most %d windows", p.ID, a.Label, PlanQuotaMaxWindows)
			}
			for k := range a.Windows {
				if err := validatePlanQuotaWindow(&a.Windows[k]); err != nil {
					return fmt.Errorf("plan quota: account pool %q account %q: %w", p.ID, a.Label, err)
				}
			}
		}
	}
	return nil
}

// poolStatusForCounts derives a pool's OR status from its counts: OK while
// at least one account is available, limited only when none is.
func poolStatusForCounts(p RuntimePlanQuotaAccountPool) string {
	if p.AvailableAccounts > 0 {
		return PlanQuotaStatusOK
	}
	return PlanQuotaStatusLimited
}
