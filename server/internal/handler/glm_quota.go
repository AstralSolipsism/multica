package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

// GLM (Zhipu) Coding Plan quota monitor: a server-side, account-level
// collector for the provider balance behind the claude/hermes GLM runtimes.
//
// Unlike the per-runtime plan-quota collectors (kimi local Server API,
// antigravity probe), the GLM allowance is a property of the API key's
// account, not of any runtime: several runtimes share one Coding Plan key.
// It is therefore collected once here — not per daemon — and surfaced at a
// fixed spot on the runtimes page instead of per-runtime rows.
//
// Data source (official usage-query plugin contract, personal Coding Plan
// only): GET {base}/api/monitor/usage/quota/limit with the raw API key in
// Authorization. The endpoint answers HTTP 200 even for business failures,
// so the body's code/success fields are the real health check. Response
// shapes seen in the wild:
//   - Older plans: limits[] with TIME_LIMIT (monthly tool/MCP credits:
//     usage=allowance, currentValue=used, remaining, percentage=used%,
//     usageDetails per tool) and TOKENS_LIMIT (the 5-hour token window:
//     percentage only).
//   - Newer plans: CREDIT_LIMIT windows (5h + weekly credit pools).
// All three are passed through as typed windows; the frontend labels them.
//
// Every failure is fail-soft: a failed round keeps the previous snapshot
// (the UI ages it out) and records last_error for the status endpoint.

const (
	glmQuotaDefaultBaseURL   = "https://open.bigmodel.cn"
	glmQuotaDefaultInterval  = 5 * time.Minute
	glmQuotaRequestTimeout   = 15 * time.Second
	glmQuotaPath             = "/api/monitor/usage/quota/limit"
	// Stale after a day without a successful poll — mirrors the runtime
	// plan-quota aging so both surfaces degrade the same way.
	glmQuotaStaleAfter = 24 * time.Hour
)

// GlmQuotaWindow is one quota pool from the provider response. Pointer
// fields keep "not reported" distinct from a real zero.
type GlmQuotaWindow struct {
	Type         string   `json:"type"`
	UsedPercent  *float64 `json:"used_percent,omitempty"`
	Usage        *float64 `json:"usage,omitempty"`
	CurrentValue *float64 `json:"current_value,omitempty"`
	Remaining    *float64 `json:"remaining,omitempty"`
	ResetsAt     *int64   `json:"resets_at,omitempty"`
}

// GlmQuotaSnapshot is one successful poll result.
type GlmQuotaSnapshot struct {
	Level      string           `json:"level,omitempty"`
	Windows    []GlmQuotaWindow `json:"windows"`
	ObservedAt int64            `json:"observed_at"`
}

// GlmQuotaStatus is the API payload: enabled=false when no key is
// configured, quota omitted when no successful poll ever happened.
type GlmQuotaStatus struct {
	Enabled   bool              `json:"enabled"`
	Quota     *GlmQuotaSnapshot `json:"quota,omitempty"`
	Stale     bool              `json:"stale,omitempty"`
	LastError string            `json:"last_error,omitempty"`
}

// glmQuotaRaw mirrors the provider wire shape. Only the fields we surface
// are typed; usageDetails is deliberately dropped (per-tool usage is not
// displayed and keeps the payload small).
type glmQuotaRaw struct {
	Code    int  `json:"code"`
	Success *bool `json:"success"`
	Data    struct {
		Limits []struct {
			Type         string    `json:"type"`
			Unit         *float64  `json:"unit"`
			Number       *float64  `json:"number"`
			Usage        *float64  `json:"usage"`
			CurrentValue *float64  `json:"currentValue"`
			Remaining    *float64  `json:"remaining"`
			Percentage   *float64  `json:"percentage"`
			NextResetMs  *float64  `json:"nextResetTime"`
		} `json:"limits"`
		Level string `json:"level"`
	} `json:"data"`
}

// parseGlmQuotaBody converts one provider response body into a snapshot.
// observedAt is injected so tests can pin time.
func parseGlmQuotaBody(body []byte, observedAt time.Time) (*GlmQuotaSnapshot, error) {
	var raw glmQuotaRaw
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("glm quota: decode body: %w", err)
	}
	// HTTP 200 with a business failure is this endpoint's error shape —
	// checking the transport code alone would surface garbage as data.
	if raw.Code != 200 || (raw.Success != nil && !*raw.Success) {
		return nil, fmt.Errorf("glm quota: provider rejected the request (code=%d)", raw.Code)
	}
	snap := &GlmQuotaSnapshot{Level: raw.Data.Level, ObservedAt: observedAt.Unix()}
	for _, lim := range raw.Data.Limits {
		w := GlmQuotaWindow{
			Type:         lim.Type,
			UsedPercent:  lim.Percentage,
			Usage:        lim.Usage,
			CurrentValue: lim.CurrentValue,
			Remaining:    lim.Remaining,
		}
		if lim.NextResetMs != nil {
			reset := int64(*lim.NextResetMs) / 1000
			w.ResetsAt = &reset
		}
		snap.Windows = append(snap.Windows, w)
	}
	if len(snap.Windows) == 0 {
		return nil, fmt.Errorf("glm quota: response carried no limit windows")
	}
	return snap, nil
}

// GlmQuotaMonitor polls the provider and holds the latest snapshot.
type GlmQuotaMonitor struct {
	apiKey   string
	baseURL  string
	interval time.Duration
	client   *http.Client

	mu        sync.RWMutex
	snapshot  *GlmQuotaSnapshot
	lastError string
}

// NewGlmQuotaMonitorFromEnv returns nil when GLM_QUOTA_API_KEY is unset —
// the feature is off and the endpoint answers enabled=false.
func NewGlmQuotaMonitorFromEnv() *GlmQuotaMonitor {
	key := os.Getenv("GLM_QUOTA_API_KEY")
	if key == "" {
		return nil
	}
	interval := glmQuotaDefaultInterval
	if v := os.Getenv("GLM_QUOTA_POLL_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			interval = d
		}
	}
	base := os.Getenv("GLM_QUOTA_BASE_URL")
	if base == "" {
		base = glmQuotaDefaultBaseURL
	}
	return &GlmQuotaMonitor{
		apiKey:   key,
		baseURL:  base,
		interval: interval,
		client:   &http.Client{Timeout: glmQuotaRequestTimeout},
	}
}

// Start launches the poll loop; the first round runs immediately so a
// freshly booted server serves data without waiting a full interval.
func (m *GlmQuotaMonitor) Start(ctx context.Context) {
	go func() {
		m.poll(ctx)
		t := time.NewTicker(m.interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.poll(ctx)
			}
		}
	}()
}

// poll runs one round; any failure keeps the previous snapshot.
func (m *GlmQuotaMonitor) poll(ctx context.Context) {
	snap, err := m.fetch(ctx)
	m.mu.Lock()
	if err != nil {
		m.lastError = err.Error()
	} else {
		m.snapshot = snap
		m.lastError = ""
	}
	m.mu.Unlock()
}

func (m *GlmQuotaMonitor) fetch(ctx context.Context) (*GlmQuotaSnapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.baseURL+glmQuotaPath, nil)
	if err != nil {
		return nil, err
	}
	// The provider expects the raw key (official plugin sends it verbatim).
	req.Header.Set("Authorization", m.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("glm quota: request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("glm quota: http %d", resp.StatusCode)
	}
	body := make([]byte, 0, 8192)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil || len(body) > 1<<20 {
			break
		}
	}
	return parseGlmQuotaBody(body, time.Now())
}

// Status returns the API view of the monitor. enabled reports only whether
// polling is active; quota is nil until the first successful round.
func (m *GlmQuotaMonitor) Status() GlmQuotaStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	st := GlmQuotaStatus{Enabled: true, Quota: m.snapshot, LastError: m.lastError}
	if m.snapshot != nil && time.Since(time.Unix(m.snapshot.ObservedAt, 0)) > glmQuotaStaleAfter {
		st.Stale = true
	}
	return st
}

// GetGlmQuota serves GET /api/glm-quota (session-authed). A nil monitor
// (no key configured) still answers, with enabled=false, so the frontend
// can distinguish "not configured" from "configured but never succeeded".
func (h *Handler) GetGlmQuota(w http.ResponseWriter, r *http.Request) {
	if h.GlmQuota == nil {
		writeJSON(w, http.StatusOK, GlmQuotaStatus{Enabled: false})
		return
	}
	writeJSON(w, http.StatusOK, h.GlmQuota.Status())
}
