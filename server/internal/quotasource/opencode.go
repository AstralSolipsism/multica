package quotasource

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ---------------------------------------------------------------------------
// OpenCode account driver.
// ---------------------------------------------------------------------------

// OpenCode query modes. A source stores one sealed credential envelope that
// carries the mode (see ParseOpenCodeCredential); legacy rows store the bare
// Zen API key and keep working as OpenCodeModeGo.
const (
	OpenCodeModePayAsYouGo = "payg"
	OpenCodeModeGo         = "go"
)

// OpenCodeCredential is the sealed payload of one opencode quota source. It
// rides inside the existing credential ciphertext so no schema migration is
// needed; Version separates the envelope from a legacy bare key.
type OpenCodeCredential struct {
	Version     int    `json:"v"`
	Mode        string `json:"mode,omitempty"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	Secret      string `json:"secret"`
}

// NormalizeOpenCodeMode maps user input to a known mode. Empty means the
// historical Go-subscription mode (old clients send no mode at all); an
// unrecognized value is rejected.
func NormalizeOpenCodeMode(mode string) (string, bool) {
	switch strings.TrimSpace(mode) {
	case OpenCodeModePayAsYouGo:
		return OpenCodeModePayAsYouGo, true
	case OpenCodeModeGo, "":
		return OpenCodeModeGo, true
	default:
		return "", false
	}
}

// EncodeOpenCodeCredential seals the mode, optional workspace id and real
// secret into one JSON string. Callers pass the result to the encryption box;
// the secret inside is the raw Cookie value or API key, never the envelope.
func EncodeOpenCodeCredential(mode, workspaceID, secret string) string {
	normalized, _ := NormalizeOpenCodeMode(mode)
	if normalized == "" {
		normalized = OpenCodeModeGo
	}
	if normalized != OpenCodeModePayAsYouGo {
		workspaceID = ""
	}
	payload, err := json.Marshal(OpenCodeCredential{
		Version:     1,
		Mode:        normalized,
		WorkspaceID: strings.TrimSpace(workspaceID),
		Secret:      secret,
	})
	if err != nil {
		// Marshaling a struct of strings cannot fail; keep a safe fallback.
		return secret
	}
	return string(payload)
}

// ParseOpenCodeCredential decodes a stored credential, falling back to the
// legacy bare Zen API key (Go mode) when it is not an envelope.
func ParseOpenCodeCredential(raw string) OpenCodeCredential {
	var cred OpenCodeCredential
	if err := json.Unmarshal([]byte(raw), &cred); err == nil && cred.Version == 1 && cred.Secret != "" {
		normalized, ok := NormalizeOpenCodeMode(cred.Mode)
		if !ok {
			normalized = OpenCodeModeGo
		}
		cred.Mode = normalized
		return cred
	}
	return OpenCodeCredential{Version: 1, Mode: OpenCodeModeGo, Secret: raw}
}

// OpenCodeDriver collects an OpenCode account's status with one Zen API key.
// Go-subscription accounts answer GET {base}/zen/go/v1/usage with rolling /
// weekly / monthly windows in the official console shape (status / percent /
// resetsAt — see anomalyco/opencode packages/console/.../zen/go/v1/usage.ts).
// Pay-as-you-go accounts are collected from the console billing API with the
// console session Cookie; see fetchPayAsYouGo.
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
	cred := ParseOpenCodeCredential(credential)
	if cred.Mode == OpenCodeModePayAsYouGo {
		return d.fetchPayAsYouGo(ctx, client, baseURL, cred, now)
	}
	return d.fetchGoSubscription(ctx, client, baseURL, cred.Secret, now)
}

// fetchGoSubscription keeps the historical Go-subscription collection. When
// the endpoint answers 403 EntitlementError, 404, or 200 without recognizable
// windows it falls back to the minimal systemone probe with the same Bearer
// key: a 200 with a valid decision proves the account usable and yields the
// probe latency; 402 or an "Insufficient balance" body yields the limited
// state. A genuinely bad key surfaces as the probe's 401.
func (d OpenCodeDriver) fetchGoSubscription(ctx context.Context, client *http.Client, baseURL, credential string, now time.Time) (*protocol.QuotaSourceSnapshot, error) {
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
// OpenCode pay-as-you-go billing.
// ---------------------------------------------------------------------------

const (
	// Legacy SolidStart server-function ids still served by workspaces that
	// were not migrated to the /console/api routes.
	openCodeLegacyOrgsServerID    = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f"
	openCodeLegacyBillingServerID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d"
	// openCodeMicroCentsDivisor converts the provider's signed micro-cents
	// (1e-8 USD) into a dollar amount.
	openCodeMicroCentsDivisor = 1e8
)

// openCodeWorkspacePattern matches the workspace/org ids the console accepts.
var openCodeWorkspacePattern = regexp.MustCompile(`^(wrk_|org_)[A-Za-z0-9_-]+$`)

// openCodeMicroCents parses the provider's micro-cent fields, which it sends
// either as an integer string or as a JSON number.
type openCodeMicroCents struct {
	Value float64
	OK    bool
}

func (m *openCodeMicroCents) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" {
		return nil
	}
	raw = strings.Trim(raw, `"`)
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fmt.Errorf("invalid micro-cent amount %q", raw)
	}
	m.Value = value
	m.OK = true
	return nil
}

// openCodeBillingFigures is one billing collection: the spendable balance and
// the optional 30-day spend (micro-cents).
type openCodeBillingFigures struct {
	balanceMicro float64
	spendMicro   *float64
}

// fetchPayAsYouGo collects the prepaid USD balance and the last-30-day spend
// for an OpenCode pay-as-you-go account, using the console session Cookie.
func (d OpenCodeDriver) fetchPayAsYouGo(ctx context.Context, client *http.Client, baseURL string, cred OpenCodeCredential, now time.Time) (*protocol.QuotaSourceSnapshot, error) {
	base := strings.TrimRight(baseURL, "/")
	cookie, err := normalizeOpenCodeCookie(cred.Secret)
	if err != nil {
		return nil, &ProbeError{Code: "invalid_credential", Err: err}
	}
	workspaceID, err := resolveOpenCodeWorkspaceID(ctx, client, base, cookie, cred.WorkspaceID)
	if err != nil {
		return nil, err
	}
	figures, err := fetchOpenCodeBilling(ctx, client, base, cookie, workspaceID)
	if err != nil {
		return nil, err
	}
	if figures.spendMicro == nil {
		if spend, ok := fetchOpenCodeUsageSummary(ctx, client, base, cookie, workspaceID); ok {
			figures.spendMicro = spend
		}
	}
	return openCodePaygSnapshot(figures, now), nil
}

// normalizeOpenCodeCookie accepts either a bare session value or a Cookie
// header and always returns the two console session cookies. A bare value is
// the __Host-console_session value, duplicated into the legacy auth cookie.
func normalizeOpenCodeCookie(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", errors.New("session cookie is empty")
	}
	if !strings.Contains(value, "=") {
		return "__Host-console_session=" + value + "; auth=" + value, nil
	}
	kept := make([]string, 0, 2)
	for _, part := range strings.Split(value, ";") {
		name, cookieValue, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name != "__Host-console_session" && name != "auth" {
			continue
		}
		if strings.TrimSpace(cookieValue) == "" {
			continue
		}
		kept = append(kept, name+"="+strings.TrimSpace(cookieValue))
	}
	if len(kept) == 0 {
		return "", errors.New("cookie has neither __Host-console_session nor auth")
	}
	return strings.Join(kept, "; "), nil
}

// parseOpenCodeWorkspaceID accepts a wrk_/org_ id or a full console URL and
// extracts the workspace id from its path.
func ParseOpenCodeWorkspaceID(raw string) (string, error) {
	candidate := strings.TrimSpace(raw)
	if openCodeWorkspacePattern.MatchString(candidate) {
		return candidate, nil
	}
	if !strings.Contains(candidate, "://") {
		candidate = "https://" + candidate
	}
	endpoint, err := url.Parse(candidate)
	if err != nil {
		return "", fmt.Errorf("workspace id is not a wrk_/org_ id or console URL")
	}
	segments := strings.Split(strings.Trim(endpoint.Path, "/"), "/")
	for index, segment := range segments {
		if segment != "workspace" && segment != "console" {
			continue
		}
		if index+1 < len(segments) && openCodeWorkspacePattern.MatchString(segments[index+1]) {
			return segments[index+1], nil
		}
	}
	return "", fmt.Errorf("workspace id is not a wrk_/org_ id or console URL")
}

// resolveOpenCodeWorkspaceID honors a configured workspace and otherwise
// discovers the account's first workspace from GET /console/api/orgs.
func resolveOpenCodeWorkspaceID(ctx context.Context, client *http.Client, base, cookie, configured string) (string, error) {
	if strings.TrimSpace(configured) != "" {
		id, err := ParseOpenCodeWorkspaceID(configured)
		if err != nil {
			return "", &ProbeError{Code: "invalid_credential", Err: err}
		}
		return id, nil
	}
	result, err := openCodeDo(ctx, client, base+"/console/api/orgs", cookie, "", nil)
	if err != nil {
		return "", err
	}
	if result.Status == http.StatusNotFound || result.Status == http.StatusMethodNotAllowed {
		// An unmigrated workspace has no console API at all: leave the id
		// empty so the billing step can fall back to /_server, which
		// discovers the workspace itself.
		return "", nil
	}
	if result.Status != http.StatusOK {
		return "", openCodeStatusError(result.Status)
	}
	if id := firstOpenCodeWorkspaceID(result.Body); id != "" {
		return id, nil
	}
	return "", &ProbeError{Code: "unexpected_response", Err: errors.New("orgs response carried no workspace id")}
}

// firstOpenCodeWorkspaceID walks an arbitrary orgs payload for the first
// wrk_/org_ id. The console wrapped this array differently across versions.
func firstOpenCodeWorkspaceID(body []byte) string {
	payload, ok := parseOpenCodeJSON(body)
	if !ok {
		return ""
	}
	var walk func(any) string
	walk = func(value any) string {
		switch typed := value.(type) {
		case []any:
			for _, entry := range typed {
				if id := walk(entry); id != "" {
					return id
				}
			}
		case map[string]any:
			if id, ok := typed["id"].(string); ok && openCodeWorkspacePattern.MatchString(id) {
				return id
			}
			for _, entry := range typed {
				if id := walk(entry); id != "" {
					return id
				}
			}
		}
		return ""
	}
	return walk(payload)
}

// fetchOpenCodeBilling asks the console billing API for the prepaid balance,
// falling back to the legacy SolidStart server function on 404/405.
func fetchOpenCodeBilling(ctx context.Context, client *http.Client, base, cookie, workspaceID string) (openCodeBillingFigures, error) {
	result, err := openCodeDo(ctx, client, base+"/console/api/billing/status", cookie, workspaceID, nil)
	if err != nil {
		return openCodeBillingFigures{}, err
	}
	switch {
	case result.Status == http.StatusOK:
		var raw struct {
			BalanceMicroCents openCodeMicroCents `json:"balanceMicroCents"`
		}
		if err := json.Unmarshal(result.Body, &raw); err != nil {
			return openCodeBillingFigures{}, openCodeUnreadableResponse(result.Body, err)
		}
		if !raw.BalanceMicroCents.OK {
			return openCodeBillingFigures{}, &ProbeError{Code: "unexpected_response", Err: errors.New("billing status carried no balanceMicroCents")}
		}
		return openCodeBillingFigures{balanceMicro: raw.BalanceMicroCents.Value}, nil
	case result.Status == http.StatusNotFound || result.Status == http.StatusMethodNotAllowed:
		return fetchOpenCodeLegacyBilling(ctx, client, base, cookie, workspaceID)
	default:
		return openCodeBillingFigures{}, openCodeStatusError(result.Status)
	}
}

// fetchOpenCodeLegacyBilling reads the balance and monthly usage from the
// pre-migration SolidStart server functions.
func fetchOpenCodeLegacyBilling(ctx context.Context, client *http.Client, base, cookie, workspaceID string) (openCodeBillingFigures, error) {
	if workspaceID == "" {
		result, err := openCodeLegacyServerGet(ctx, client, base, cookie, openCodeLegacyOrgsServerID, "")
		if err != nil {
			return openCodeBillingFigures{}, err
		}
		if result.Status != http.StatusOK {
			return openCodeBillingFigures{}, openCodeStatusError(result.Status)
		}
		workspaceID = firstOpenCodeWorkspaceID(result.Body)
		if workspaceID == "" {
			return openCodeBillingFigures{}, &ProbeError{Code: "unexpected_response", Err: errors.New("legacy orgs response carried no workspace id")}
		}
	}
	args := fmt.Sprintf(`["%s"]`, workspaceID)
	result, err := openCodeLegacyServerGet(ctx, client, base, cookie, openCodeLegacyBillingServerID, args)
	if err != nil {
		return openCodeBillingFigures{}, err
	}
	if result.Status != http.StatusOK {
		return openCodeBillingFigures{}, openCodeStatusError(result.Status)
	}
	payload, ok := parseOpenCodeJSON(result.Body)
	if !ok {
		return openCodeBillingFigures{}, &ProbeError{Code: "unexpected_response", Err: errors.New("legacy billing response was not JSON")}
	}
	balance, ok := findOpenCodeNumber(payload, "balance")
	if !ok {
		return openCodeBillingFigures{}, &ProbeError{Code: "unexpected_response", Err: errors.New("legacy billing response carried no balance")}
	}
	figures := openCodeBillingFigures{balanceMicro: balance}
	if monthly, ok := findOpenCodeNumber(payload, "monthlyUsage"); ok {
		figures.spendMicro = &monthly
	}
	return figures, nil
}

// fetchOpenCodeUsageSummary reads the last-30-day spend. Any failure is
// silently ignored so the main balance still lands.
func fetchOpenCodeUsageSummary(ctx context.Context, client *http.Client, base, cookie, workspaceID string) (*float64, bool) {
	result, err := openCodeDo(ctx, client, base+"/console/api/usage/summary?range=30d", cookie, workspaceID, nil)
	if err != nil || result.Status != http.StatusOK {
		return nil, false
	}
	var raw struct {
		TotalCostMicroCents openCodeMicroCents `json:"totalCostMicroCents"`
	}
	if err := json.Unmarshal(result.Body, &raw); err != nil || !raw.TotalCostMicroCents.OK || raw.TotalCostMicroCents.Value < 0 {
		return nil, false
	}
	value := raw.TotalCostMicroCents.Value
	return &value, true
}

// openCodePaygSnapshot converts the billing figures into the snapshot shape.
func openCodePaygSnapshot(figures openCodeBillingFigures, now time.Time) *protocol.QuotaSourceSnapshot {
	usd := figures.balanceMicro / openCodeMicroCentsDivisor
	available := usd > 0
	snap := &protocol.QuotaSourceSnapshot{}
	snap.Provider = "opencode"
	snap.Source = protocol.PlanQuotaSourceSubscription
	snap.ObservedAt = now.Unix()
	snap.Status = protocol.PlanQuotaStatusOK
	if !available {
		snap.Status = protocol.PlanQuotaStatusLimited
	}
	snap.Available = &available
	balance := protocol.QuotaSourceBalance{Currency: "USD", TotalBalance: &usd}
	if figures.spendMicro != nil {
		spend := *figures.spendMicro / openCodeMicroCentsDivisor
		balance.Spend30d = &spend
	}
	snap.Balances = []protocol.QuotaSourceBalance{balance}
	return snap
}

// openCodeHTTPResult is one console response with its body already read.
type openCodeHTTPResult struct {
	Status int
	Body   []byte
}

// openCodeDo performs one console GET with the session cookie and workspace
// header. Bodies are capped at 1 MiB; the response is always closed.
func openCodeDo(ctx context.Context, client *http.Client, endpoint, cookie, workspaceID string, extraHeaders map[string]string) (openCodeHTTPResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return openCodeHTTPResult{}, err
	}
	req.Header.Set("Cookie", cookie)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Multica quota collector)")
	if workspaceID != "" {
		req.Header.Set("x-org-id", workspaceID)
	}
	for name, value := range extraHeaders {
		req.Header.Set(name, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return openCodeHTTPResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return openCodeHTTPResult{}, err
	}
	return openCodeHTTPResult{Status: resp.StatusCode, Body: body}, nil
}

// openCodeLegacyServerGet calls one SolidStart server function with the
// session cookie and the headers that endpoint expects.
func openCodeLegacyServerGet(ctx context.Context, client *http.Client, base, cookie, serverID, args string) (openCodeHTTPResult, error) {
	endpoint := base + "/_server?id=" + serverID
	if args != "" {
		endpoint += "&args=" + url.QueryEscape(args)
	}
	headers := map[string]string{
		"X-Server-Id":       serverID,
		"X-Server-Instance": "server-fn:" + randomOpenCodeUUID(),
		"Origin":            base,
		"Referer":           base + "/",
	}
	return openCodeDo(ctx, client, endpoint, cookie, "", headers)
}

// openCodeStatusError maps a console auth/rate-limit failure to the stable
// probe codes the API surfaces.
func openCodeStatusError(status int) error {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return &ProbeError{Code: "invalid_credential", Status: status}
	case status == http.StatusTooManyRequests:
		return &ProbeError{Code: "rate_limited", Status: status}
	default:
		return &ProbeError{Code: "provider_error", Status: status}
	}
}

// openCodeUnreadableResponse treats an HTML login page as a rejected session
// cookie; anything else is a malformed provider response.
func openCodeUnreadableResponse(body []byte, err error) error {
	if trimmed := bytes.TrimSpace(body); len(trimmed) > 0 && trimmed[0] == '<' {
		return &ProbeError{Code: "invalid_credential", Err: errors.New("console returned an HTML page instead of JSON")}
	}
	return &ProbeError{Code: "unexpected_response", Err: err}
}

// parseOpenCodeJSON decodes a JSON document, tolerating a doubly-encoded JSON
// string body.
func parseOpenCodeJSON(body []byte) (any, bool) {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, false
	}
	if encoded, ok := payload.(string); ok {
		var nested any
		if err := json.Unmarshal([]byte(encoded), &nested); err != nil {
			return nil, false
		}
		return nested, true
	}
	return payload, true
}

// findOpenCodeNumber walks a decoded payload for the first numeric (or
// numeric-string) field with the given key.
func findOpenCodeNumber(value any, key string) (float64, bool) {
	switch typed := value.(type) {
	case map[string]any:
		if raw, ok := typed[key]; ok {
			if number, ok := openCodeNumber(raw); ok {
				return number, true
			}
		}
		for _, nested := range typed {
			if number, ok := findOpenCodeNumber(nested, key); ok {
				return number, true
			}
		}
	case []any:
		for _, entry := range typed {
			if number, ok := findOpenCodeNumber(entry, key); ok {
				return number, true
			}
		}
	}
	return 0, false
}

func openCodeNumber(raw any) (float64, bool) {
	switch typed := raw.(type) {
	case float64:
		return typed, true
	case string:
		value, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return value, true
		}
	}
	return 0, false
}

// randomOpenCodeUUID builds the X-Server-Instance identifier the legacy
// server function expects.
func randomOpenCodeUUID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
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
