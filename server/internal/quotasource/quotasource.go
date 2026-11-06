// Package quotasource implements the user-scoped subscription quota sources
// (OL-1205 scenario 3): drivers that fetch a third-party subscription's
// balance with a user-registered credential and normalize it into the
// standard protocol.RuntimePlanQuota shape. Drivers never see or store the
// credential beyond the fetch call; snapshots carry only percentages, reset
// times and window periods — never plan tiers, absolute usage, or any
// account identifier (RuntimePlanQuota privacy red line).
package quotasource

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

// Driver fetches one provider's subscription balance. Implementations must be
// safe for concurrent use.
type Driver interface {
	Kind() string
	DefaultBaseURL() string
	// AllowedHosts is the base_url host allowlist; empty means "any host the
	// SSRF validator accepts as a public HTTPS endpoint".
	AllowedHosts() []string
	// Fetch performs one collection round. baseURL is the validated endpoint;
	// credential is the decrypted API key.
	Fetch(ctx context.Context, client *http.Client, baseURL, credential string, now time.Time) (*protocol.RuntimePlanQuota, error)
}

// DriverFor returns the driver for a quota_source kind, or nil.
func DriverFor(kind string) Driver {
	switch kind {
	case "glm":
		return GLMDriver{}
	case "zenmux":
		return ZenMuxDriver{}
	default:
		return nil
	}
}

// fetchJSON is the shared HTTP boilerplate: GET with the raw key in
// Authorization, 1 MiB body cap.
func fetchJSON(ctx context.Context, client *http.Client, url, credential string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", credential)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return &ProbeError{Code: "invalid_credential", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusUnprocessableEntity {
		return &ProbeError{Code: "rate_limited", Status: resp.StatusCode}
	}
	if resp.StatusCode != http.StatusOK {
		return &ProbeError{Code: "provider_error", Status: resp.StatusCode}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
		return &ProbeError{Code: "unexpected_response", Err: err}
	}
	return nil
}

// ProbeError classifies a failed collection round with a stable code the API
// surfaces verbatim (quota_source_probe_failed reasons).
type ProbeError struct {
	Code   string
	Status int
	Err    error
}

func (e *ProbeError) Error() string {
	if e.Err != nil {
		return e.Code + ": " + e.Err.Error()
	}
	if e.Status != 0 {
		return fmt.Sprintf("%s (http %d)", e.Code, e.Status)
	}
	return e.Code
}

// ClassifyError maps a transport error to a probe code.
func ClassifyError(err error) string {
	var probe *ProbeError
	if errors.As(err, &probe) {
		return probe.Code
	}
	if err != nil && strings.Contains(err.Error(), "context deadline exceeded") {
		return "network_error"
	}
	return "provider_error"
}

// ---------------------------------------------------------------------------
// GLM (Zhipu) Coding Plan driver.
// ---------------------------------------------------------------------------

// GLMDriver collects the personal Coding Plan balance via the usage-query
// plugin contract: GET {base}/api/monitor/usage/quota/limit, raw API key in
// Authorization (no Bearer prefix).
type GLMDriver struct{}

func (GLMDriver) Kind() string           { return "glm" }
func (GLMDriver) DefaultBaseURL() string { return "https://open.bigmodel.cn" }
func (GLMDriver) AllowedHosts() []string {
	return []string{"open.bigmodel.cn", "api.z.ai", "bigmodel.cn"}
}

// glmQuotaUnit* are the provider's time-unit codes in limits[].unit. Weeks
// are classified by unit alone (plans disagree on number: 1 and 7 both mean
// one week); hours multiply; months carry no minute count.
const (
	glmUnitHours  = 3.0
	glmUnitMonths = 5.0
	glmUnitWeeks  = 6.0
)

// GLMWindowMinutes converts a limit's unit/number pair into the window period
// in minutes. Shared with the legacy handler passthrough (scenario 2): unit 3
// = hours×number, unit 6 = one week (10080), anything else = 0 (unknown).
func GLMWindowMinutes(unit, number *float64) int64 {
	if unit == nil || *unit <= 0 {
		return 0
	}
	switch *unit {
	case glmUnitWeeks:
		return 7 * 24 * 60
	case glmUnitHours:
		if number == nil || *number <= 0 {
			return 0
		}
		return int64(*number * 60)
	default:
		// Months (5) and unrecognized codes carry no minute count.
		return 0
	}
}

type glmRaw struct {
	Code    int   `json:"code"`
	Success *bool `json:"success"`
	Data    struct {
		Limits []struct {
			Type         string   `json:"type"`
			Unit         *float64 `json:"unit"`
			Number       *float64 `json:"number"`
			Usage        *float64 `json:"usage"`
			CurrentValue *float64 `json:"currentValue"`
			Remaining    *float64 `json:"remaining"`
			Percentage   *float64 `json:"percentage"`
			NextResetMs  *float64 `json:"nextResetTime"`
		} `json:"limits"`
		Level string `json:"level"`
	} `json:"data"`
}

func (GLMDriver) Fetch(ctx context.Context, client *http.Client, baseURL, credential string, now time.Time) (*protocol.RuntimePlanQuota, error) {
	var raw glmRaw
	if err := fetchJSON(ctx, client, strings.TrimRight(baseURL, "/")+"/api/monitor/usage/quota/limit", credential, &raw); err != nil {
		return nil, err
	}
	// HTTP 200 with a business failure is this endpoint's error shape.
	if raw.Code != 200 || (raw.Success != nil && !*raw.Success) {
		return nil, &ProbeError{Code: "invalid_credential"}
	}
	if len(raw.Data.Limits) == 0 {
		return nil, &ProbeError{Code: "unexpected_response", Err: errors.New("response carried no limit windows")}
	}
	quota := &protocol.RuntimePlanQuota{
		Provider:   "glm",
		Status:     protocol.PlanQuotaStatusOK,
		ObservedAt: now.Unix(),
		Source:     protocol.PlanQuotaSourceSubscription,
	}
	limited := false
	for _, lim := range raw.Data.Limits {
		group, ok := map[string]string{
			"TOKENS_LIMIT": "tokens",
			"CREDIT_LIMIT": "credits",
			"TIME_LIMIT":   "tools",
		}[lim.Type]
		if !ok {
			continue // unknown window kind: drop rather than mislabel
		}
		minutes := GLMWindowMinutes(lim.Unit, lim.Number)
		name := group
		if minutes > 0 {
			name = fmt.Sprintf("%s_%d", group, minutes)
		}
		window := protocol.RuntimePlanQuotaWindow{Name: name, Group: group}
		if minutes > 0 {
			m := minutes
			window.WindowMinutes = &m
		}
		// Percentage is USED; derive remaining percent from whichever pair
		// exists, then drop the absolute values (privacy red line).
		used := usedPercent(lim.Percentage, lim.Usage, lim.Remaining)
		if used != nil {
			window.UsedPercent = used
			if *used >= 100 {
				limited = true
			}
		}
		if lim.NextResetMs != nil {
			sec := int64(*lim.NextResetMs) / 1000
			window.ResetsAt = &sec
		}
		quota.Windows = append(quota.Windows, window)
	}
	if len(quota.Windows) == 0 {
		return nil, &ProbeError{Code: "unexpected_response", Err: errors.New("no recognizable limit windows")}
	}
	if limited {
		quota.Status = protocol.PlanQuotaStatusLimited
	}
	return quota, nil
}

// usedPercent prefers the provider's percentage (used), else derives it from
// remaining/usage. Nil when neither is derivable.
func usedPercent(percentage, usage, remaining *float64) *float64 {
	if percentage != nil {
		return percentage
	}
	if usage != nil && remaining != nil && *usage > 0 {
		used := ((*usage - *remaining) / *usage) * 100
		return &used
	}
	return nil
}

// ---------------------------------------------------------------------------
// ZenMux driver.
// ---------------------------------------------------------------------------

// ZenMuxDriver collects the subscription's quota windows from ZenMux's
// Management API: GET {base}/api/v1/management/subscription/detail with a
// Bearer Management API key.
type ZenMuxDriver struct{}

func (ZenMuxDriver) Kind() string           { return "zenmux" }
func (ZenMuxDriver) DefaultBaseURL() string { return "https://zenmux.ai" }
func (ZenMuxDriver) AllowedHosts() []string { return []string{"zenmux.ai", "www.zenmux.ai"} }

type zenmuxEnvelope struct {
	Success bool `json:"success"`
	Data    struct {
		Quota5Hour *zenmuxQuotaWindow `json:"quota_5_hour,omitempty"`
		Quota7Day  *zenmuxQuotaWindow `json:"quota_7_day,omitempty"`
	} `json:"data,omitempty"`
}

type zenmuxQuotaWindow struct {
	UsagePercentage *float64 `json:"usage_percentage,omitempty"` // fraction 0..1
	ResetsAt        *string  `json:"resets_at,omitempty"`        // ISO 8601
}

func (ZenMuxDriver) Fetch(ctx context.Context, client *http.Client, baseURL, credential string, now time.Time) (*protocol.RuntimePlanQuota, error) {
	var env zenmuxEnvelope
	url := strings.TrimRight(baseURL, "/") + "/api/v1/management/subscription/detail"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
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
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusUnprocessableEntity {
		return nil, &ProbeError{Code: "rate_limited", Status: resp.StatusCode}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &ProbeError{Code: "provider_error", Status: resp.StatusCode}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&env); err != nil {
		return nil, &ProbeError{Code: "unexpected_response", Err: err}
	}
	if !env.Success {
		return nil, &ProbeError{Code: "unexpected_response", Err: errors.New("unsuccessful response")}
	}

	quota := &protocol.RuntimePlanQuota{
		Provider:   "zenmux",
		Status:     protocol.PlanQuotaStatusOK,
		ObservedAt: now.Unix(),
		Source:     protocol.PlanQuotaSourceSubscription,
	}
	limited := false
	appendWindow := func(name string, minutes int64, w *zenmuxQuotaWindow) {
		if w == nil {
			return
		}
		window := protocol.RuntimePlanQuotaWindow{Name: name, Group: "zenmux"}
		m := minutes
		window.WindowMinutes = &m
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
	appendWindow("zenmux_5h", 300, env.Data.Quota5Hour)
	appendWindow("zenmux_7d", 10080, env.Data.Quota7Day)
	if len(quota.Windows) == 0 {
		return nil, &ProbeError{Code: "unexpected_response", Err: errors.New("no quota windows in subscription detail")}
	}
	if limited {
		quota.Status = protocol.PlanQuotaStatusLimited
	}
	return quota, nil
}
