package quotasource

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ---------------------------------------------------------------------------
// DeepSeek driver.
// ---------------------------------------------------------------------------

func TestDeepSeekDriverFetchParsesStringAmounts(t *testing.T) {
	var gotAuth string
	snap, err := fetchWith(t, DeepSeekDriver{}, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"is_available":true,"balance_infos":[` +
			`{"currency":"CNY","total_balance":"48.50","granted_balance":"0.00","topped_up_balance":"48.50"},` +
			`{"currency":"USD","total_balance":12.75}]}`))
	}, "sk-ds-key-123456")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotAuth != "Bearer sk-ds-key-123456" {
		t.Fatalf("auth = %q (Bearer expected)", gotAuth)
	}
	if snap.Provider != "deepseek" || snap.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("provider/status = %s/%s", snap.Provider, snap.Status)
	}
	if snap.Available == nil || !*snap.Available {
		t.Fatalf("available = %v, want true", snap.Available)
	}
	if len(snap.Balances) != 2 {
		t.Fatalf("balances = %+v", snap.Balances)
	}
	cny := snap.Balances[0]
	if cny.Currency != "CNY" || cny.TotalBalance == nil || *cny.TotalBalance != 48.5 {
		t.Fatalf("CNY balance = %+v", cny)
	}
	if cny.ToppedUpBalance == nil || *cny.ToppedUpBalance != 48.5 || cny.GrantedBalance == nil || *cny.GrantedBalance != 0 {
		t.Fatalf("CNY breakdown = %+v", cny)
	}
	usd := snap.Balances[1]
	if usd.TotalBalance == nil || *usd.TotalBalance != 12.75 {
		t.Fatalf("USD numeric balance = %+v", usd)
	}
	if len(snap.Windows) != 0 {
		t.Fatalf("deepseek snapshot must not fabricate windows: %+v", snap.Windows)
	}
}

func TestDeepSeekDriverUnavailableFlagLimits(t *testing.T) {
	snap, err := fetchWith(t, DeepSeekDriver{}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"is_available":false,"balance_infos":[{"currency":"CNY","total_balance":"10.00"}]}`))
	}, "k")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if snap.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("status = %s, want limited", snap.Status)
	}
}

func TestDeepSeekDriverDrainedBalanceLimits(t *testing.T) {
	// Negative and zero primary balances both mean "cannot spend".
	snap, err := fetchWith(t, DeepSeekDriver{}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"-2.50"}]}`))
	}, "k")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if snap.Status != protocol.PlanQuotaStatusLimited || snap.Available == nil || *snap.Available {
		t.Fatalf("drained balance must be limited/unavailable: %+v", snap)
	}
}

func TestDeepSeekDriverNoBalancesIsUnexpected(t *testing.T) {
	_, err := fetchWith(t, DeepSeekDriver{}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"is_available":true,"balance_infos":[]}`))
	}, "k")
	if err == nil || ClassifyError(err) != "unexpected_response" {
		t.Fatalf("expected unexpected_response, got %v", err)
	}
}

func TestDeepSeekDriverInvalidCredential(t *testing.T) {
	_, err := fetchWith(t, DeepSeekDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}, "bad")
	if err == nil || ClassifyError(err) != "invalid_credential" {
		t.Fatalf("expected invalid_credential, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// OpenCode driver.
// ---------------------------------------------------------------------------

const openCodeUsageBody = `{"usage":{` +
	`"rolling":{"used_percent":30,"resets_at":"2026-11-15T12:00:00Z"},` +
	`"weekly":{"used":40,"limit":200},` +
	`"monthly":{"used_percent":100}` +
	`}}`

func TestOpenCodeDriverUsageWindows(t *testing.T) {
	var gotPath, gotAuth string
	snap, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(openCodeUsageBody))
	}, "oc-key-123456")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotPath != "/zen/go/v1/usage" || gotAuth != "Bearer oc-key-123456" {
		t.Fatalf("request = %s %q", gotPath, gotAuth)
	}
	if snap.Provider != "opencode" || snap.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("provider/status = %s/%s (monthly is 100%% used)", snap.Provider, snap.Status)
	}
	if m, used, ok := window(snap, "opencode_5h"); !ok || m != 300 || used != 30 {
		t.Errorf("rolling window: minutes=%d used=%v ok=%v", m, used, ok)
	}
	if m, used, ok := window(snap, "opencode_7d"); !ok || m != 10080 || used != 20 {
		t.Errorf("weekly window (used/limit derived): minutes=%d used=%v ok=%v", m, used, ok)
	}
	if _, _, ok := window(snap, "opencode_30d"); !ok {
		t.Error("monthly window missing")
	}
	if snap.Windows[0].ResetsAt == nil {
		t.Error("rolling window reset missing")
	}
}

func TestOpenCodeDriverFallbackProbeOn404(t *testing.T) {
	var probeAuth, probeModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/zen/go/v1/usage" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		probeAuth = r.Header.Get("Authorization")
		body := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
		probeModel = string(body)
		_, _ = w.Write([]byte(`{"answers":{"effort":{"choice":"low"}}}`))
	}))
	t.Cleanup(srv.Close)
	client := srv.Client()
	client.Timeout = 5 * time.Second
	snap, err := OpenCodeDriver{}.Fetch(context.Background(), client, srv.URL, "oc-key-123456", time.Unix(1_800_000_000, 0))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if probeAuth != "Bearer oc-key-123456" {
		t.Fatalf("probe auth = %q", probeAuth)
	}
	if !strings.Contains(probeModel, `"model":"jev-1.13"`) || !strings.Contains(probeModel, `"health-probe"`) {
		t.Fatalf("probe body = %s", probeModel)
	}
	if snap.Status != protocol.PlanQuotaStatusOK || snap.Available == nil || !*snap.Available {
		t.Fatalf("probe snapshot = %+v", snap)
	}
	if snap.Probe == nil || !snap.Probe.Available || snap.Probe.Model != "jev-1.13" {
		t.Fatalf("probe = %+v", snap.Probe)
	}
	if len(snap.Windows) != 0 {
		t.Fatalf("probe fallback must not fabricate windows: %+v", snap.Windows)
	}
}

func TestOpenCodeDriverFallbackInsufficientBalance(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/zen/go/v1/usage" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"error":"Insufficient balance"}`))
	}))
	t.Cleanup(srv.Close)
	client := srv.Client()
	client.Timeout = 5 * time.Second
	snap, err := OpenCodeDriver{}.Fetch(context.Background(), client, srv.URL, "oc-key-123456", time.Unix(1_800_000_000, 0))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if snap.Status != protocol.PlanQuotaStatusLimited || snap.Available == nil || *snap.Available {
		t.Fatalf("insufficient balance snapshot = %+v", snap)
	}
}

func TestOpenCodeDriverUsageInvalidCredential(t *testing.T) {
	_, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}, "bad")
	if err == nil || ClassifyError(err) != "invalid_credential" {
		t.Fatalf("expected invalid_credential, got %v", err)
	}
}

func TestOpenCodeDriverUsageRateLimited(t *testing.T) {
	_, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}, "k")
	if err == nil || ClassifyError(err) != "rate_limited" {
		t.Fatalf("expected rate_limited, got %v", err)
	}
}

// A 200 usage answer without recognizable payload falls back to the probe
// rather than being stored as an empty snapshot.
func TestOpenCodeDriverUsage200WithoutPayloadFallsBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/zen/go/v1/usage" {
			_, _ = w.Write([]byte(`{"usage":{}}`))
			return
		}
		_, _ = w.Write([]byte(`{"answers":{"effort":{"choice":"medium"}}}`))
	}))
	t.Cleanup(srv.Close)
	client := srv.Client()
	client.Timeout = 5 * time.Second
	snap, err := OpenCodeDriver{}.Fetch(context.Background(), client, srv.URL, "k", time.Unix(1_800_000_000, 0))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if snap.Probe == nil || !snap.Probe.Available {
		t.Fatalf("fallback snapshot = %+v", snap)
	}
}

// ---------------------------------------------------------------------------
// jev_free driver.
// ---------------------------------------------------------------------------

func TestJevFreeDriverProbe(t *testing.T) {
	var gotAuth, gotModel, gotMethod string
	snap, err := fetchWith(t, JevFreeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotMethod = r.Header.Get("Authorization"), r.Method
		body := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
		gotModel = string(body)
		_, _ = w.Write([]byte(`{"answers":{"effort":{"choice":"low"}}}`))
	}, "")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotAuth != "" {
		t.Fatalf("free channel must send no Authorization, got %q", gotAuth)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %s, want POST", gotMethod)
	}
	if !strings.Contains(gotModel, `"model":"jev-1.13-free"`) {
		t.Fatalf("probe body = %s", gotModel)
	}
	if snap.Provider != "opencode" || snap.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("provider/status = %s/%s", snap.Provider, snap.Status)
	}
	if snap.Available == nil || !*snap.Available || snap.Probe == nil || snap.Probe.Model != "jev-1.13-free" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if snap.Probe.LatencyMS < 0 {
		t.Fatalf("latency = %d", snap.Probe.LatencyMS)
	}
}

func TestJevFreeDriverRateLimited(t *testing.T) {
	_, err := fetchWith(t, JevFreeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}, "")
	if err == nil || ClassifyError(err) != "rate_limited" {
		t.Fatalf("expected rate_limited, got %v", err)
	}
}

func TestJevFreeDriverProviderError(t *testing.T) {
	_, err := fetchWith(t, JevFreeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}, "")
	if err == nil || ClassifyError(err) != "provider_error" {
		t.Fatalf("expected provider_error, got %v", err)
	}
}

func TestJevFreeDriverInvalidDecisionStructure(t *testing.T) {
	_, err := fetchWith(t, JevFreeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"unexpected":true}`))
	}, "")
	if err == nil || ClassifyError(err) != "unexpected_response" {
		t.Fatalf("expected unexpected_response, got %v", err)
	}
}

func TestNormalizeSystemOneURL(t *testing.T) {
	cases := map[string]string{
		"https://opencode.ai":                    "https://opencode.ai/zen/v1/systemone",
		"https://opencode.ai/":                   "https://opencode.ai/zen/v1/systemone",
		"https://www.opencode.ai":                "https://www.opencode.ai/zen/v1/systemone",
		"https://opencode.ai/zen/v1/systemone":   "https://opencode.ai/zen/v1/systemone",
		"https://proxy.example.com/v1/systemone": "https://proxy.example.com/v1/systemone",
	}
	for in, want := range cases {
		if got := normalizeSystemOneURL(in); got != want {
			t.Errorf("normalizeSystemOneURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Driver metadata + SSRF allowlists for the new kinds.
// ---------------------------------------------------------------------------

func TestNewDriverMetadata(t *testing.T) {
	if !(DeepSeekDriver{}).RequiresCredential() || !(OpenCodeDriver{}).RequiresCredential() {
		t.Fatal("deepseek/opencode require credentials")
	}
	if (JevFreeDriver{}).RequiresCredential() {
		t.Fatal("jev_free must be credential-free")
	}
	if (DeepSeekDriver{}).DefaultBaseURL() != "https://api.deepseek.com" {
		t.Fatal("deepseek default base url")
	}
	if (JevFreeDriver{}).DefaultBaseURL() != "https://opencode.ai/zen/v1/systemone" {
		t.Fatal("jev_free default base url")
	}
}

func TestValidateBaseURLNewKindAllowlists(t *testing.T) {
	ok := []struct {
		driver Driver
		url    string
	}{
		{DeepSeekDriver{}, "https://api.deepseek.com"},
		{OpenCodeDriver{}, "https://opencode.ai"},
		{OpenCodeDriver{}, "https://www.opencode.ai"},
		{JevFreeDriver{}, "https://opencode.ai/zen/v1/systemone"},
	}
	for _, tc := range ok {
		if _, err := ValidateBaseURL(context.Background(), tc.driver, tc.url, stubResolver{}); err != nil {
			t.Errorf("ValidateBaseURL(%s, %s): %v", tc.driver.Kind(), tc.url, err)
		}
	}
	bad := []struct {
		driver Driver
		url    string
	}{
		{DeepSeekDriver{}, "https://evil.example.com"},
		{OpenCodeDriver{}, "https://api.deepseek.com"},
		{JevFreeDriver{}, "https://open.bigmodel.cn/zen/v1/systemone"},
	}
	for _, tc := range bad {
		if _, err := ValidateBaseURL(context.Background(), tc.driver, tc.url, stubResolver{}); err == nil {
			t.Errorf("ValidateBaseURL(%s, %s) must be rejected", tc.driver.Kind(), tc.url)
		}
	}
}
