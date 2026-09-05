package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ZenMux plan-quota collector: syncs the hermes subscription's quota state
// from ZenMux's official Management API and normalizes it into a plan-quota
// snapshot for every hermes runtime registered on this daemon.
//
// Source contract (https://zenmux.ai/docs/api/platform/subscription-detail.html):
//   - GET https://zenmux.ai/api/v1/management/subscription/detail with a
//     Management API key bearer (a dedicated console credential, NOT the
//     inference key). The key comes from daemon-local config
//     (MULTICA_ZENMUX_MANAGEMENT_API_KEY) and never leaves this machine.
//   - The platform rate-limits each endpoint and answers 422 when exceeded;
//     the loop backs off exponentially on that signal.
//
// The quota source is deliberately NOT the runtime provider: a hermes
// runtime's inference may be backed by any gateway, so the snapshot's
// provider names the quota source ("zenmux") — and the collector only runs
// when the operator pinned this machine's account by configuring the key.
// Nothing is attached to hermes runtimes by default.
//
// Privacy: plan tier, USD rates, flow counts, and account status are read
// only far enough to reach the two quota windows; they are never copied into
// the snapshot (no account identifiers, plan names, or credit balances on
// the wire).

const zenmuxSubscriptionDetailURL = "https://zenmux.ai/api/v1/management/subscription/detail"

type zenmuxPlanQuotaCollector struct {
	client  *http.Client
	baseURL string // subscription detail endpoint; overridable for tests
	apiKey  string
}

func newZenmuxPlanQuotaCollector(baseURL, apiKey string) *zenmuxPlanQuotaCollector {
	return &zenmuxPlanQuotaCollector{
		client:  &http.Client{Timeout: 10 * time.Second},
		baseURL: baseURL,
		apiKey:  apiKey,
	}
}

// collect fetches the subscription detail once and normalizes it.
func (c *zenmuxPlanQuotaCollector) collect(ctx context.Context) (*protocol.RuntimePlanQuota, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("zenmux subscription detail: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnprocessableEntity || resp.StatusCode == http.StatusTooManyRequests {
		return nil, &rateLimitError{err: fmt.Errorf("zenmux subscription detail: rate limited (http %d)", resp.StatusCode)}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("zenmux subscription detail: unexpected http %d", resp.StatusCode)
	}
	var envelope struct {
		Success bool                    `json:"success"`
		Data    *zenmuxSubscriptionData `json:"data,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("zenmux subscription detail: decode: %w", err)
	}
	if !envelope.Success || envelope.Data == nil {
		return nil, errors.New("zenmux subscription detail: unsuccessful or empty response")
	}
	return zenmuxDetailToPlanQuota(envelope.Data, time.Now()), nil
}

// zenmuxSubscriptionData models only the quota windows of the subscription
// detail payload. Plan, currency, per-flow rates, and account status are
// intentionally not decoded: the snapshot must not carry account metadata.
type zenmuxSubscriptionData struct {
	Quota5Hour *zenmuxQuotaWindow `json:"quota_5_hour,omitempty"`
	Quota7Day  *zenmuxQuotaWindow `json:"quota_7_day,omitempty"`
}

type zenmuxQuotaWindow struct {
	UsagePercentage *float64 `json:"usage_percentage,omitempty"` // fraction 0..1
	ResetsAt        *string  `json:"resets_at,omitempty"`        // ISO 8601; null before the window starts
}

// zenmuxDetailToPlanQuota maps the 5-hour and 7-day rolling windows onto the
// canonical "primary"/"secondary" window ids. A missing window is skipped
// (never zero-filled); a window without a usage fraction reports no
// percentage. Nil when neither window is present.
func zenmuxDetailToPlanQuota(data *zenmuxSubscriptionData, observedAt time.Time) *protocol.RuntimePlanQuota {
	if data == nil {
		return nil
	}
	quota := &protocol.RuntimePlanQuota{
		Provider:   "zenmux",
		Status:     protocol.PlanQuotaStatusOK,
		ObservedAt: observedAt.Unix(),
		Source:     protocol.PlanQuotaSourceDaemon,
	}
	limited := false
	appendWindow := func(name string, minutes int64, w *zenmuxQuotaWindow) {
		if w == nil {
			return
		}
		window := protocol.RuntimePlanQuotaWindow{
			Name:          name,
			WindowMinutes: &minutes,
		}
		if w.UsagePercentage != nil {
			used := *w.UsagePercentage * 100
			window.UsedPercent = &used
			if used >= 100 {
				limited = true
			}
		}
		if w.ResetsAt != nil {
			if ts, err := time.Parse(time.RFC3339, strings.TrimSpace(*w.ResetsAt)); err == nil {
				sec := ts.Unix()
				window.ResetsAt = &sec
			}
		}
		quota.Windows = append(quota.Windows, window)
	}
	appendWindow("primary", 300, data.Quota5Hour)
	appendWindow("secondary", 10080, data.Quota7Day)
	if len(quota.Windows) == 0 {
		return nil
	}
	if limited {
		quota.Status = protocol.PlanQuotaStatusLimited
	}
	return quota
}

// zenmuxPlanQuotaLoop is the daemon-loop entry point for the ZenMux
// collector. It only runs when the operator configured a Management API key
// for this daemon; the key stays in daemon-local config and never appears in
// any payload or log.
func (d *Daemon) zenmuxPlanQuotaLoop(ctx context.Context) {
	baseURL := d.cfg.ZenMuxAPIBaseURL
	if baseURL == "" {
		baseURL = zenmuxSubscriptionDetailURL
	}
	collector := newZenmuxPlanQuotaCollector(baseURL, d.cfg.ZenMuxManagementAPIKey)
	d.runPlanQuotaCollector(ctx, "zenmux", d.cfg.PlanQuotaZenMuxInterval, []string{"hermes"}, collector.collect)
}
