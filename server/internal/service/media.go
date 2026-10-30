package service

import (
	"encoding/json"
	"math"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// SelectMediaRuntime applies machine-owner consent before considering quota.
// Unknown quota is usable but ranks behind any measured remaining capacity.
func SelectMediaRuntime(runtimes []db.AgentRuntime, caller pgtype.UUID, request protocol.MediaRequest, now time.Time) *db.AgentRuntime {
	var best *db.AgentRuntime
	bestScore := -2.0
	for i := range runtimes {
		rt := &runtimes[i]
		provider := protocol.MediaProvider(rt.Provider)
		if rt.Status != "online" || !RuntimeAllowsUser(*rt, caller) || (request.Provider != "auto" && request.Provider != provider) {
			continue
		}
		tag := protocol.MediaCapabilityTag(provider, request.Capability)
		var meta struct {
			Capabilities []string         `json:"capabilities"`
			Cooldowns    map[string]int64 `json:"media_cooldowns"`
		}
		if tag == "" || json.Unmarshal(rt.Metadata, &meta) != nil || !slices.Contains(meta.Capabilities, tag) || meta.Cooldowns[tag] > now.Unix() {
			continue
		}
		var quota protocol.RuntimePlanQuota
		_ = json.Unmarshal(rt.PlanQuota, &quota)
		score, usable := mediaQuotaScore(quota, provider, now)
		if usable && score > bestScore {
			best, bestScore = rt, score
		}
	}
	return best
}

func applicableMediaWindow(w protocol.RuntimePlanQuotaWindow, provider string) bool {
	// agy image generation consumes the Gemini pool, never Claude/GPT.
	return provider != "agy" || w.Group == "" || w.Group == "gemini"
}

func mediaQuotaScore(quota protocol.RuntimePlanQuota, provider string, now time.Time) (float64, bool) {
	score := -1.0
	hasActive := false
	for _, w := range quota.Windows {
		if !applicableMediaWindow(w, provider) || (w.ResetsAt != nil && *w.ResetsAt <= now.Unix()) {
			continue
		}
		hasActive = true
		if w.UsedPercent == nil {
			continue
		}
		remaining := 100 - *w.UsedPercent
		if math.IsNaN(remaining) || math.IsInf(remaining, 0) || remaining <= 0 {
			return 0, false
		}
		if score < 0 || remaining < score {
			score = remaining
		}
	}
	if quota.Status == protocol.PlanQuotaStatusLimited && (hasActive || len(quota.Windows) == 0) {
		return 0, false
	}
	return score, true
}

func MediaCooldown(rt db.AgentRuntime, retryAfter int64, now time.Time) time.Time {
	if retryAfter > 0 {
		return now.Add(time.Duration(min(retryAfter, int64(86400*7))) * time.Second)
	}
	var quota protocol.RuntimePlanQuota
	_ = json.Unmarshal(rt.PlanQuota, &quota)
	var reset int64
	for _, w := range quota.Windows {
		if applicableMediaWindow(w, protocol.MediaProvider(rt.Provider)) && w.ResetsAt != nil && *w.ResetsAt > now.Unix() && (reset == 0 || *w.ResetsAt < reset) {
			reset = *w.ResetsAt
		}
	}
	if reset > 0 {
		return time.Unix(reset, 0)
	}
	return now.Add(time.Minute)
}
