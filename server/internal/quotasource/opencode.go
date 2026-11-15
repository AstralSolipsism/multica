package quotasource

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ---------------------------------------------------------------------------
// OpenCode account driver.
// ---------------------------------------------------------------------------

// OpenCodeDriver collects an OpenCode account's status with one Zen API key.
// Go-subscription accounts answer GET {base}/zen/go/v1/usage with rolling /
// weekly / monthly windows (and possibly balances) which normalize into the
// standard window shape. Pay-as-you-go accounts without a subscription (404
// or no recognizable windows) fall back to the minimal systemone probe with
// the same Bearer key: a 200 with a valid decision structure proves the
// account usable and yields the probe latency; 402 / "Insufficient balance"
// yields the limited state.
type OpenCodeDriver struct{}

func (OpenCodeDriver) Kind() string           { return "opencode" }
func (OpenCodeDriver) DefaultBaseURL() string { return "https://opencode.ai" }
func (OpenCodeDriver) AllowedHosts() []string {
	return []string{"opencode.ai", "www.opencode.ai"}
}
func (OpenCodeDriver) RequiresCredential() bool { return true }

const (
	openCodeGoModel   = "jev-1.13"
	openCodeFreeModel = "jev-1.13-free"
)

// The usage window shape is normalized from whichever fields the endpoint
// discloses; every numeric field is a pointer so a real 0 stays distinct
// from "not reported".
type openCodeUsageWindow struct {
	UsedPercent  *float64        `json:"used_percent"`
	UsagePercent *float64        `json:"usage_percent"`
	Used         *float64        `json:"used"`
	Limit        *float64        `json:"limit"`
	ResetsAt     *time.Time      `json:"resets_at"`
	ResetsAtRaw  json.RawMessage `json:"resets_at_unix"`
}

type openCodeUsageResponse struct {
	Usage struct {
		Rolling *openCodeUsageWindow `json:"rolling"`
		Weekly  *openCodeUsageWindow `json:"weekly"`
		Monthly *openCodeUsageWindow `json:"monthly"`
	} `json:"usage"`
	Balances []deepSeekBalanceInfo `json:"balances"`
}

func (d OpenCodeDriver) Fetch(ctx context.Context, client *http.Client, baseURL, credential string, now time.Time) (*protocol.QuotaSourceSnapshot, error) {
	base := strings.TrimRight(baseURL, "/")
	usageURL := base + "/zen/go/v1/usage"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, usageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, &ProbeError{Code: "invalid_credential", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &ProbeError{Code: "rate_limited", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusOK {
		var raw openCodeUsageResponse
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&raw); err != nil {
			return nil, &ProbeError{Code: "unexpected_response", Err: err}
		}
		if snap := openCodeUsageSnapshot(&raw, now); snap != nil {
			return snap, nil
		}
		// 200 without recognizable windows or balances: not a Go
		// subscription — fall through to the pay-as-you-go probe.
	} else if resp.StatusCode >= 500 {
		return nil, &ProbeError{Code: "provider_error", Status: resp.StatusCode}
	}
	// 404 and other 4xx (short of auth/rate-limit, already handled): the
	// account has no Go subscription; probe availability instead.
	return systemoneProbe(ctx, client, base+"/zen/v1/systemone", credential, openCodeGoModel, now)
}

// openCodeUsageSnapshot normalizes the usage payload; nil when it carries
// no recognizable window or balance payload (caller falls back to probing).
func openCodeUsageSnapshot(raw *openCodeUsageResponse, now time.Time) *protocol.QuotaSourceSnapshot {
	snap := &protocol.QuotaSourceSnapshot{}
	snap.Provider = "opencode"
	snap.Status = protocol.PlanQuotaStatusOK
	snap.ObservedAt = now.Unix()
	snap.Source = protocol.PlanQuotaSourceSubscription
	limited := false
	appendWindow := func(name string, minutes int64, w *openCodeUsageWindow) {
		if w == nil {
			return
		}
		window := protocol.RuntimePlanQuotaWindow{Name: name, Group: "opencode"}
		m := minutes
		window.WindowMinutes = &m
		if used := openCodeUsedPercent(w); used != nil {
			window.UsedPercent = used
			if *used >= 100 {
				limited = true
			}
		}
		if ts := openCodeResetTime(w); ts != nil {
			sec := ts.Unix()
			window.ResetsAt = &sec
		}
		snap.Windows = append(snap.Windows, window)
	}
	appendWindow("opencode_5h", 300, raw.Usage.Rolling)
	appendWindow("opencode_7d", 10080, raw.Usage.Weekly)
	appendWindow("opencode_30d", 43200, raw.Usage.Monthly)
	for _, info := range raw.Balances {
		balance := protocol.QuotaSourceBalance{Currency: strings.TrimSpace(info.Currency)}
		balance.TotalBalance = amountFromRaw(info.TotalBalance)
		balance.GrantedBalance = amountFromRaw(info.GrantedBalance)
		balance.ToppedUpBalance = amountFromRaw(info.ToppedUpBalance)
		if balance.TotalBalance == nil && balance.GrantedBalance == nil && balance.ToppedUpBalance == nil {
			continue
		}
		snap.Balances = append(snap.Balances, balance)
	}
	if len(snap.Windows) == 0 && len(snap.Balances) == 0 {
		return nil
	}
	if limited {
		snap.Status = protocol.PlanQuotaStatusLimited
	}
	return snap
}

func openCodeUsedPercent(w *openCodeUsageWindow) *float64 {
	if w.UsedPercent != nil {
		return w.UsedPercent
	}
	if w.UsagePercent != nil {
		return w.UsagePercent
	}
	if w.Used != nil && w.Limit != nil && *w.Limit > 0 {
		used := (*w.Used / *w.Limit) * 100
		return &used
	}
	return nil
}

func openCodeResetTime(w *openCodeUsageWindow) *time.Time {
	if w.ResetsAt != nil {
		return w.ResetsAt
	}
	s := strings.Trim(strings.TrimSpace(string(w.ResetsAtRaw)), "\"")
	if s == "" || s == "null" {
		return nil
	}
	var unix float64
	if err := json.Unmarshal([]byte(s), &unix); err == nil {
		sec := int64(unix / 1000)
		if sec <= 0 {
			sec = int64(unix)
		}
		ts := time.Unix(sec, 0).UTC()
		return &ts
	}
	if ts, err := time.Parse(time.RFC3339, s); err == nil {
		return &ts
	}
	return nil
}

// ---------------------------------------------------------------------------
// OpenCode Jev free-channel driver (jev_free).
// ---------------------------------------------------------------------------

// JevFreeDriver monitors the OpenCode Zen free decision channel
// (model jev-1.13-free). No credential is stored or sent: the probe is the
// unauthenticated minimal systemone request, and the snapshot carries only
// availability, latency and the model id.
type JevFreeDriver struct{}

func (JevFreeDriver) Kind() string           { return "jev_free" }
func (JevFreeDriver) DefaultBaseURL() string { return "https://opencode.ai/zen/v1/systemone" }
func (JevFreeDriver) AllowedHosts() []string {
	return []string{"opencode.ai", "www.opencode.ai"}
}
func (JevFreeDriver) RequiresCredential() bool { return false }

func (JevFreeDriver) Fetch(ctx context.Context, client *http.Client, baseURL, credential string, now time.Time) (*protocol.QuotaSourceSnapshot, error) {
	return systemoneProbe(ctx, client, normalizeSystemOneURL(baseURL), "", openCodeFreeModel, now)
}

// normalizeSystemOneURL appends the default probe path when only the origin
// was registered (https://opencode.ai → https://opencode.ai/zen/v1/systemone).
func normalizeSystemOneURL(baseURL string) string {
	endpoint, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return baseURL
	}
	if endpoint.Path == "" || endpoint.Path == "/" {
		endpoint.Path = "/zen/v1/systemone"
	}
	return endpoint.String()
}

// probeRequestBody is the fixed, business-content-free System One request —
// the same minimal health probe the daemon's jev client sends. Plain JSON
// only: the OpenCode Zen gateway rejects compressed request bodies, so no
// Content-Encoding may ever be set.
func probeRequestBody(model string) []byte {
	questions := `{"effort":{"type":"choice","instructions":` +
		`"Pick the reasoning effort for a routine health check of a decision endpoint.",` +
		`"criteria":{"low":"routine health check","medium":"standard health check","high":"thorough health check"}}}`
	return []byte(fmt.Sprintf(`{"model":%q,"state":{"kind":"health-probe","component":"jev"},"questions":%s}`, model, questions))
}

// systemOneAnswers is the slice of the decision response the probe validates.
type systemOneAnswers struct {
	Answers struct {
		Effort struct {
			Choice string `json:"choice"`
		} `json:"effort"`
	} `json:"answers"`
}

// systemoneProbe sends one minimal probe request and classifies the outcome:
// a 200 with a valid decision structure is the ok snapshot (availability +
// latency); 402 or an "Insufficient balance" body is the limited snapshot;
// auth failures, rate limiting, 5xx and transport errors are ProbeErrors.
func systemoneProbe(ctx context.Context, client *http.Client, url, bearer, model string, now time.Time) (*protocol.QuotaSourceSnapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(probeRequestBody(model)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	latency := time.Since(started).Milliseconds()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, &ProbeError{Code: "invalid_credential", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &ProbeError{Code: "rate_limited", Status: resp.StatusCode}
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return nil, &ProbeError{Code: "unexpected_response", Err: readErr}
	}
	if resp.StatusCode == http.StatusPaymentRequired || bytes.Contains(body, []byte("Insufficient balance")) {
		return systemOneProbeSnapshot(false, latency, model, now), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &ProbeError{Code: "provider_error", Status: resp.StatusCode}
	}
	var answers systemOneAnswers
	if err := json.Unmarshal(body, &answers); err != nil || answers.Answers.Effort.Choice == "" {
		return nil, &ProbeError{Code: "unexpected_response", Err: errors.New("response carried no decision structure")}
	}
	return systemOneProbeSnapshot(true, latency, model, now), nil
}

func systemOneProbeSnapshot(available bool, latencyMS int64, model string, now time.Time) *protocol.QuotaSourceSnapshot {
	snap := &protocol.QuotaSourceSnapshot{}
	snap.Provider = "opencode"
	snap.Status = protocol.PlanQuotaStatusOK
	snap.ObservedAt = now.Unix()
	snap.Source = protocol.PlanQuotaSourceSubscription
	snap.Available = &available
	snap.Probe = &protocol.QuotaSourceProbe{Available: available, LatencyMS: latencyMS, Model: model}
	if !available {
		snap.Status = protocol.PlanQuotaStatusLimited
	}
	return snap
}
