package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
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

// zenmuxLinkSet is the explicit, operator-maintained association between the
// ZenMux account behind the configured Management API key and the runtimes
// whose quota that account backs. S2 (product decision by the project
// owner): the association is MANUAL — the daemon never scans, infers, or
// guesses a runtime's real LLM gateway. Configuring a key alone links
// nothing; an empty link set means "no runtime reports this account".
type zenmuxLinkSet struct {
	allHermes  bool                // "hermes" entry: every hermes runtime on this daemon
	workspaces map[string]struct{} // "hermes@<workspace-id>" entries
}

// parseZenMuxLink parses MULTICA_ZENMUX_LINK: a comma-separated list of
// `hermes` (all workspaces on this daemon) or `hermes@<workspace-id>`
// (only that workspace's hermes runtimes). Any other provider or a malformed
// entry is a hard config error — a typo must surface at startup, not
// silently misreport quota.
func parseZenMuxLink(raw string) (zenmuxLinkSet, error) {
	set := zenmuxLinkSet{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		provider, workspaceID, hasWorkspace := strings.Cut(entry, "@")
		if provider != "hermes" {
			return zenmuxLinkSet{}, fmt.Errorf("MULTICA_ZENMUX_LINK: unsupported provider %q (only \"hermes\" is backed by ZenMux)", provider)
		}
		if !hasWorkspace {
			set.allHermes = true
			continue
		}
		workspaceID = strings.TrimSpace(workspaceID)
		if workspaceID == "" {
			return zenmuxLinkSet{}, fmt.Errorf("MULTICA_ZENMUX_LINK: entry %q is missing a workspace id after \"@\"", entry)
		}
		if set.workspaces == nil {
			set.workspaces = make(map[string]struct{})
		}
		set.workspaces[workspaceID] = struct{}{}
	}
	return set, nil
}

func (s zenmuxLinkSet) empty() bool {
	return !s.allHermes && len(s.workspaces) == 0
}

// linked reports whether a runtime (provider, workspace) is in the
// association. Only hermes runtimes can ever be linked.
func (s zenmuxLinkSet) linked(provider, workspaceID string) bool {
	if provider != "hermes" {
		return false
	}
	if s.allHermes {
		return true
	}
	_, ok := s.workspaces[workspaceID]
	return ok
}

// zenmuxLinkedRuntimeIDs resolves the current hermes runtimes in the link
// set. Runtimes are per-workspace rows sharing the machine's account, so the
// link speaks provider + workspace id, both stable across re-registration
// (server runtime ids are not).
func (d *Daemon) zenmuxLinkedRuntimeIDs(link zenmuxLinkSet) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var ids []string
	for wsID, ws := range d.workspaces {
		for _, rid := range ws.runtimeIDs {
			rt, ok := d.runtimeIndex[rid]
			if !ok || !link.linked(rt.Provider, wsID) {
				continue
			}
			ids = append(ids, rid)
		}
	}
	sort.Strings(ids)
	return ids
}

// clearUnlinkedZenMuxQuotas records an explicit empty snapshot (provider
// "zenmux", no windows) for every hermes runtime outside the link set, so a
// runtime whose association was REMOVED stops displaying this account's
// quota on its next heartbeat — instead of showing a mismatched source until
// the 24h staleness window. The empty snapshot renders as "not reported" on
// the frontend, identical to a runtime that never had the association, and
// the server's conditional write throttles repeats of unchanged content.
func (d *Daemon) clearUnlinkedZenMuxQuotas(link zenmuxLinkSet) {
	d.mu.Lock()
	var ids []string
	for wsID, ws := range d.workspaces {
		for _, rid := range ws.runtimeIDs {
			rt, ok := d.runtimeIndex[rid]
			if !ok || rt.Provider != "hermes" || link.linked(rt.Provider, wsID) {
				continue
			}
			ids = append(ids, rid)
		}
	}
	d.mu.Unlock()
	if len(ids) == 0 {
		return
	}
	cleared := &protocol.RuntimePlanQuota{
		Provider:   "zenmux",
		Status:     protocol.PlanQuotaStatusOK,
		ObservedAt: time.Now().Unix(),
		Source:     protocol.PlanQuotaSourceDaemon,
	}
	for _, rid := range ids {
		d.recordRuntimePlanQuota(rid, cleared)
	}
	d.logger.Info("zenmux plan quota: cleared quota display for unlinked hermes runtimes", "runtimes", len(ids))
}

// zenmuxPlanQuotaLoop is the daemon-loop entry point for the ZenMux
// collector. The key stays in daemon-local config and never appears in any
// payload or log. Collection targets only the explicitly linked runtimes;
// with a key but an empty link set the collector stays idle by design.
func (d *Daemon) zenmuxPlanQuotaLoop(ctx context.Context) {
	link := d.cfg.ZenMuxLink
	d.clearUnlinkedZenMuxQuotas(link)
	if d.cfg.ZenMuxManagementAPIKey == "" {
		return // link-only configuration: cleared above, nothing to poll
	}
	if link.empty() {
		d.logger.Warn("zenmux plan quota: MULTICA_ZENMUX_MANAGEMENT_API_KEY is set but MULTICA_ZENMUX_LINK is empty; " +
			"no runtime is linked to this account, so nothing will be reported")
	}
	baseURL := d.cfg.ZenMuxAPIBaseURL
	if baseURL == "" {
		baseURL = zenmuxSubscriptionDetailURL
	}
	collector := newZenmuxPlanQuotaCollector(baseURL, d.cfg.ZenMuxManagementAPIKey)
	d.runPlanQuotaCollector(ctx, "zenmux", d.cfg.PlanQuotaZenMuxInterval,
		func() []string { return d.zenmuxLinkedRuntimeIDs(link) }, collector.collect)
}
