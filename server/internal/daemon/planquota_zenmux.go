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
//
// Entry grammar (MULTICA_ZENMUX_LINK, comma-separated):
//
//	hermes                      every hermes runtime on this daemon
//	hermes@<workspace-id>       every hermes runtime in one workspace
//	hermes:profile:<profile-id> runtimes of one custom runtime profile —
//	                            the stable identity when a built-in hermes
//	                            and a custom hermes profile coexist in the
//	                            same workspace (both report provider
//	                            "hermes", so workspace-wide selection cannot
//	                            tell them apart)
type zenmuxLinkSet struct {
	allHermes         bool
	workspaces        map[string]struct{}
	profiles          map[string]struct{}
	builtinAll        bool
	builtinWorkspaces map[string]struct{}
}

// parseZenMuxLink parses MULTICA_ZENMUX_LINK. Any other provider or a
// malformed entry is a hard config error — a typo must surface at startup,
// not silently misreport quota.
func parseZenMuxLink(raw string) (zenmuxLinkSet, error) {
	set := zenmuxLinkSet{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if id, ok := strings.CutPrefix(entry, "hermes:profile:"); ok {
			id = strings.TrimSpace(id)
			if id == "" {
				return zenmuxLinkSet{}, fmt.Errorf("MULTICA_ZENMUX_LINK: %q is missing a profile id", entry)
			}
			if set.profiles == nil {
				set.profiles = make(map[string]struct{})
			}
			set.profiles[id] = struct{}{}
			continue
		}
		if rest, ok := strings.CutPrefix(entry, "hermes:builtin"); ok {
			if rest == "" {
				set.builtinAll = true
				continue
			}
			wsID, found := strings.CutPrefix(rest, "@")
			if !found || strings.TrimSpace(wsID) == "" {
				return zenmuxLinkSet{}, fmt.Errorf("MULTICA_ZENMUX_LINK: malformed entry %q (want hermes:builtin[@<workspace-id>])", entry)
			}
			if set.builtinWorkspaces == nil {
				set.builtinWorkspaces = make(map[string]struct{})
			}
			set.builtinWorkspaces[strings.TrimSpace(wsID)] = struct{}{}
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
	return !s.allHermes && !s.builtinAll &&
		len(s.workspaces) == 0 && len(s.profiles) == 0 && len(s.builtinWorkspaces) == 0
}

// linked reports whether a runtime (provider, workspace, custom profile) is
// in the association. Only hermes runtimes can ever be linked.
func (s zenmuxLinkSet) linked(provider, workspaceID, profileID string) bool {
	if provider != "hermes" {
		return false
	}
	if s.allHermes {
		return true
	}
	if _, ok := s.workspaces[workspaceID]; ok {
		return true
	}
	if profileID != "" {
		_, ok := s.profiles[profileID]
		return ok
	}
	// Built-in runtimes (no profile) are selectable without dragging custom
	// profiles along.
	if s.builtinAll {
		return true
	}
	_, ok := s.builtinWorkspaces[workspaceID]
	return ok
}

// zenmuxRuntimeKey is the stable per-runtime identity used for the persisted
// reported-set: server runtime ids churn on re-registration, but
// provider+workspace (+profile) does not.
func zenmuxRuntimeKey(workspaceID, profileID string) string {
	if profileID != "" {
		return "hermes@" + workspaceID + "#" + profileID
	}
	return "hermes@" + workspaceID
}

type zenmuxRuntimeRef struct {
	ID  string
	Key string
}

// zenmuxHermesRuntimes lists every hermes runtime registered on this daemon
// with its stable key.
func (d *Daemon) zenmuxHermesRuntimes() []zenmuxRuntimeRef {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []zenmuxRuntimeRef
	for wsID, ws := range d.workspaces {
		for _, rid := range ws.runtimeIDs {
			rt, ok := d.runtimeIndex[rid]
			if !ok || rt.Provider != "hermes" {
				continue
			}
			out = append(out, zenmuxRuntimeRef{ID: rid, Key: zenmuxRuntimeKey(wsID, rt.ProfileID)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// zenmuxLinkedRuntimes resolves the current hermes runtimes in the link set.
func (d *Daemon) zenmuxLinkedRuntimes(link zenmuxLinkSet) []zenmuxRuntimeRef {
	var out []zenmuxRuntimeRef
	for _, rt := range d.zenmuxHermesRuntimes() {
		wsID, profileID := splitZenmuxRuntimeKey(rt.Key)
		if link.linked("hermes", wsID, profileID) {
			out = append(out, rt)
		}
	}
	return out
}

func splitZenmuxRuntimeKey(key string) (workspaceID, profileID string) {
	rest := strings.TrimPrefix(key, "hermes@")
	ws, prof, _ := strings.Cut(rest, "#")
	return ws, prof
}

// reconcileZenMuxClears records an explicit empty snapshot (provider
// "zenmux", no windows — a clear marker that renders as "not reported") for
// every hermes runtime that THIS daemon previously reported for but which is
// no longer linked. The persisted state is what distinguishes "explicitly
// removed" from "never associated": runtimes that were never reported get no
// marker at all, so a BYO-pushed or other-source snapshot is never touched
// (the server additionally guards clear markers by provider+source). Markers
// stay in the cache, so heartbeats keep them fresh and a cleared runtime
// never ages into the stale state while this daemon runs.
func (d *Daemon) reconcileZenMuxClears(link zenmuxLinkSet, state *zenmuxQuotaState) {
	var cleared []string
	for _, rt := range d.zenmuxHermesRuntimes() {
		wsID, profileID := splitZenmuxRuntimeKey(rt.Key)
		if link.linked("hermes", wsID, profileID) {
			continue
		}
		if !state.has(rt.Key) {
			continue // never reported by this daemon — leave its row alone
		}
		d.recordZenMuxPlanQuotaClearMarker(rt.ID)
		cleared = append(cleared, rt.Key)
	}
	if len(cleared) > 0 {
		d.logger.Info("zenmux plan quota: cleared quota display for unlinked hermes runtimes", "runtimes", cleared)
	}
}

// zenmuxPlanQuotaLoop is the daemon-loop entry point for the ZenMux
// collector. It always runs (like the kimi loop) so that a REMOVED
// association is actively cleared even when the operator also removed the
// key; polling itself only happens with both key and a non-empty link set.
// The key stays in daemon-local config and never appears in any payload or
// log.
func (d *Daemon) zenmuxPlanQuotaLoop(ctx context.Context) {
	link := d.cfg.ZenMuxLink
	state := loadZenMuxQuotaState(d.cfg.Profile, d.logger)

	// Clear-on-startup, then re-clear whenever the runtime set changes
	// (re-registration swaps runtime ids; the stable keys survive).
	d.reconcileZenMuxClears(link, state)
	if d.runtimeSet != nil {
		go func() {
			ch, unsub := d.runtimeSet.Subscribe()
			defer unsub()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ch:
					d.reconcileZenMuxClears(link, state)
				}
			}
		}()
	}

	if d.cfg.ZenMuxManagementAPIKey == "" {
		return // cleared above; without a key there is nothing to poll
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
	collectTracked := func(ctx context.Context) (*protocol.RuntimePlanQuota, error) {
		quota, err := collector.collect(ctx)
		if err == nil && quota != nil {
			// Remember what this daemon reported so a later removal can be
			// cleared precisely (see reconcileZenMuxClears).
			for _, rt := range d.zenmuxLinkedRuntimes(link) {
				state.add(rt.Key, d.logger)
			}
		}
		return quota, err
	}
	d.runPlanQuotaCollector(ctx, "zenmux", d.cfg.PlanQuotaZenMuxInterval,
		func() []string {
			refs := d.zenmuxLinkedRuntimes(link)
			ids := make([]string, 0, len(refs))
			for _, rt := range refs {
				ids = append(ids, rt.ID)
			}
			return ids
		}, collectTracked)
}
