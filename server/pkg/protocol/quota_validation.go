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
		w := &q.Windows[i]
		if w.Name == "" && strings.TrimSpace(w.Group) == "" {
			return fmt.Errorf("plan quota: window %d name or group is required", i)
		}
		if len(w.Name) > PlanQuotaMaxWindowName {
			return fmt.Errorf("plan quota: window %d name must be at most %d chars", i, PlanQuotaMaxWindowName)
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
	}
	return nil
}
