package agent

import (
	"encoding/json"
	"math"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

type claudeQuotaWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *int64   `json:"resetsAt"`
}

// Claude Code 2.1.286 adds unifiedWindows to rate_limit_event. It carries
// response-header observations, not account polling or token-cost estimates.
// Keep parsing isolated: the extension is internal and may change with the CLI.
func parseClaudePlanQuota(data json.RawMessage, observedAt time.Time) *protocol.RuntimePlanQuota {
	var raw struct {
		Status        string `json:"status"`
		RateLimitType string `json:"rateLimitType"`
		claudeQuotaWindow
		UnifiedWindows map[string]json.RawMessage `json:"unifiedWindows"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	status := protocol.PlanQuotaStatusOK
	switch raw.Status {
	case "allowed", "allowed_warning":
	case "rejected":
		status = protocol.PlanQuotaStatusLimited
	default:
		return nil
	}
	quota := &protocol.RuntimePlanQuota{
		Provider: "claude", Status: status, ObservedAt: observedAt.Unix(),
		Source: protocol.PlanQuotaSourceDaemon,
	}
	for _, kind := range []string{"five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"} {
		window := claudeQuotaWindow{}
		reported := false
		if data, ok := raw.UnifiedWindows[kind]; ok {
			reported = json.Unmarshal(data, &window) == nil && (window.Utilization != nil || window.ResetsAt != nil)
		}
		// The documented top-level fields describe only the limiting window.
		// They can fill that window, never invent the other subscription window.
		if !reported && raw.RateLimitType == kind {
			window = raw.claudeQuotaWindow
			reported = window.Utilization != nil || window.ResetsAt != nil || status == protocol.PlanQuotaStatusLimited
		}
		if !reported {
			continue
		}
		minutes := int64(7 * 24 * 60)
		group := ""
		switch kind {
		case "five_hour":
			minutes = 5 * 60
		case "seven_day_opus":
			group = "Opus"
		case "seven_day_sonnet":
			group = "Sonnet"
		case "seven_day_overage_included":
			group = "claude_models"
		}
		normalized := protocol.RuntimePlanQuotaWindow{Name: kind, WindowMinutes: &minutes, Group: group}
		if window.Utilization != nil {
			percent := *window.Utilization * 100
			if math.IsNaN(percent) || math.IsInf(percent, 0) || percent < 0 || percent > protocol.PlanQuotaMaxUsedPercent {
				continue
			}
			normalized.UsedPercent = &percent
		}
		if window.ResetsAt != nil {
			if *window.ResetsAt <= 0 {
				continue
			}
			normalized.ResetsAt = window.ResetsAt
		}
		quota.Windows = append(quota.Windows, normalized)
	}
	// API-key/gateway sessions and status-only notices have no subscription
	// window. Leave the last real observation untouched instead of reporting 0.
	if len(quota.Windows) == 0 {
		return nil
	}
	return quota
}
