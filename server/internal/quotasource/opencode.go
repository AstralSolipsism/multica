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
// weekly / monthly windows in the official console shape (status / percent /
// resetsAt — see anomalyco/opencode packages/console/.../zen/go/v1/usage.ts).
// Pay-as-you-go accounts — the endpoint answers 403 EntitlementError ("valid
// key, no Go subscription"), 404, or 200 without recognizable windows — fall
// back to the minimal systemone probe with the same Bearer key: a 200 with a
// valid decision proves the account usable and yields the probe latency;
// 402 or an "Insufficient balance" body yields the limited state.
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

	// The official usage window status for an exhausted window.
	openCodeStatusRateLimited = "rate-limited"
)

// openCodeUsageWindow is the official usage window shape: used percent,
// reset deadline, and the provider's own rate-limit verdict. Every numeric
// field is a pointer so a real 0 stays distinct from "not reported".
type openCodeUsageWindow struct {
	Status   string   `json:"status"`   // ok | rate-limited
	Percent  *float64 `json:"percent"`  // used percent (0-100)
	ResetsAt string   `json:"resetsAt"` // ISO 8601
}

type openCodeUsageResponse struct {
	Usage struct {
		Rolling *openCodeUsageWindow `json:"rolling"`
		Weekly  *openCodeUsageWindow `json:"weekly"`
		Monthly *openCodeUsageWindow `json:"monthly"`
	} `json:"usage"`
	// Balances is not part of the official Go-usage response today; kept
	// tolerant so a future balance disclosure normalizes without a driver
	// change.
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
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, &ProbeError{Code: "invalid_credential", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &ProbeError{Code: "rate_limited", Status: resp.StatusCode}
	}
	if resp.StatusCode >= 500 {
		return nil, &ProbeError{Code: "provider_error", Status: resp.StatusCode}
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
	}
	// 403 EntitlementError, 404 and other 4xx (auth and rate-limit already
	// handled above): no Go subscription on this key; probe availability
	// instead. A genuinely bad key surfaces as the probe's 401.
	return systemoneProbe(ctx, client, base+"/zen/v1/systemone", credential, openCodeGoModel, now)
}

// openCodeUsageSnapshot normalizes the official usage payload; nil when it
// carries no recognizable window or balance payload (caller falls back to
// probing).
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
		window.UsedPercent = w.Percent
		if w.Status == openCodeStatusRateLimited || (w.Percent != nil && *w.Percent >= 100) {
			limited = true
		}
		if w.ResetsAt != "" {
			if ts, err := time.Parse(time.RFC3339, strings.TrimSpace(w.ResetsAt)); err == nil {
				sec := ts.Unix()
				window.ResetsAt = &sec
			}
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

// probeOptions are the only choices a healthy System One endpoint may answer
// with — the same set the probe request offers. Anything else means the
// response is not a decision for this question, mirroring the daemon-side
// validation in internal/daemon/jev.
var probeOptions = map[string]bool{"low": true, "medium": true, "high": true}

// systemOneAnswers is the slice of the decision response the probe validates.
type systemOneAnswers struct {
	Answers struct {
		Effort struct {
			Choice string `json:"choice"`
		} `json:"effort"`
	} `json:"answers"`
}

// systemoneProbe sends one minimal probe request and classifies the outcome:
// a 2xx with a valid decision for this question is the ok snapshot
// (availability + latency); 402, or a 2xx carrying "Insufficient balance",
// is the limited snapshot; auth failures and rate limiting are ProbeErrors;
// every other non-2xx (5xx included, whatever the body says) is
// provider_error; transport and body-read timeouts stay transport errors so
// ClassifyError maps them to network_error.
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

	// Status codes outrank any body text: a 500 that happens to quote
	// "Insufficient balance" is still a provider error, never a clean
	// limited snapshot.
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, &ProbeError{Code: "invalid_credential", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &ProbeError{Code: "rate_limited", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusPaymentRequired {
		return systemOneProbeSnapshot(false, latency, model, now), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &ProbeError{Code: "provider_error", Status: resp.StatusCode}
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		// A body-read timeout is a transport failure, not a malformed
		// response: leave it unwrapped so ClassifyError maps
		// context-deadline errors to network_error.
		if isDeadlineError(readErr) {
			return nil, readErr
		}
		return nil, &ProbeError{Code: "unexpected_response", Err: readErr}
	}
	if bytes.Contains(body, []byte("Insufficient balance")) {
		return systemOneProbeSnapshot(false, latency, model, now), nil
	}
	var answers systemOneAnswers
	if err := json.Unmarshal(body, &answers); err != nil || !probeOptions[answers.Answers.Effort.Choice] {
		return nil, &ProbeError{Code: "unexpected_response", Err: errors.New("response carried no decision for the probe question")}
	}
	return systemOneProbeSnapshot(true, latency, model, now), nil
}

// isDeadlineError reports whether a transport error is a timeout, by substring
// the same way ClassifyError does (Go wraps client timeouts as "context
// deadline exceeded" in both the dial and the body-read paths).
func isDeadlineError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "context deadline exceeded")
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
