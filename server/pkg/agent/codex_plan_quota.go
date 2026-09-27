package agent

type codexRawRateLimitWindow struct {
	UsedPercent   *float64 `json:"used_percent"`
	WindowMinutes *int64   `json:"window_minutes"`
	ResetsAt      *int64   `json:"resets_at"`
}

type codexRawRateLimits struct {
	Primary   *codexRawRateLimitWindow `json:"primary"`
	Secondary *codexRawRateLimitWindow `json:"secondary"`
}

func codexRateLimitWindowReported(w *codexRawRateLimitWindow) bool {
	return w != nil && (w.UsedPercent != nil || w.WindowMinutes != nil || w.ResetsAt != nil)
}

func codexRateLimitsUsable(raw *codexRawRateLimits) bool {
	return raw != nil && (codexRateLimitWindowReported(raw.Primary) || codexRateLimitWindowReported(raw.Secondary))
}
