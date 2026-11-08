package quotasource

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
	"github.com/multica-ai/multica/server/pkg/remotemcp"
)

// fetchWith drives a driver against a local test server. The server URL is a
// plain http origin; the SSRF validation is exercised separately in
// TestValidateBaseURLHostAllowlist.
func fetchWith(t *testing.T, driver Driver, handler http.HandlerFunc, credential string) (*protocol.RuntimePlanQuota, error) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	client := srv.Client()
	client.Timeout = 5 * time.Second
	return driver.Fetch(context.Background(), client, srv.URL, credential, time.Unix(1_800_000_000, 0))
}

// window finds one window by name and returns its minutes/used percent.
func window(q *protocol.RuntimePlanQuota, name string) (minutes int64, used float64, found bool) {
	for _, w := range q.Windows {
		if w.Name == name {
			if w.WindowMinutes != nil {
				minutes = *w.WindowMinutes
			}
			if w.UsedPercent != nil {
				used = *w.UsedPercent
			}
			return minutes, used, true
		}
	}
	return 0, 0, false
}

const glmBody = `{"code":200,"success":true,"data":{"limits":[` +
	`{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":10,"nextResetTime":1788808596818},` +
	`{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":60,"nextResetTime":1790000000000},` +
	`{"type":"CREDIT_LIMIT","unit":6,"percentage":40},` +
	`{"type":"TIME_LIMIT","unit":5,"number":1,"usage":1000,"remaining":840,"percentage":16,"nextResetTime":1790845772998}` +
	`],"level":"max"}}`

func TestGLMDriverFetch(t *testing.T) {
	var gotAuth string
	quota, err := fetchWith(t, GLMDriver{}, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(glmBody))
	}, "test-key-123456")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotAuth != "test-key-123456" {
		t.Fatalf("auth = %q (raw key expected, no Bearer)", gotAuth)
	}
	if quota.Provider != "glm" || quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("provider/status = %s/%s", quota.Provider, quota.Status)
	}
	if m, used, ok := window(quota, "tokens_300"); !ok || m != 300 || used != 10 {
		t.Errorf("5h tokens window: minutes=%d used=%v ok=%v", m, used, ok)
	}
	if m, _, ok := window(quota, "tokens_10080"); !ok || m != 10080 {
		t.Errorf("weekly tokens window: minutes=%d ok=%v", m, ok)
	}
	if _, _, ok := window(quota, "credits_10080"); !ok {
		t.Error("weekly credit window missing")
	}
	if m, used, ok := window(quota, "tools"); !ok || m != 0 || used != 16 {
		t.Errorf("monthly tools window: minutes=%d used=%v ok=%v", m, used, ok)
	}
	// No absolute usage values or level may ride along (privacy red line).
	for _, w := range quota.Windows {
		if w.Name == "tools" && w.UsedPercent != nil && *w.UsedPercent != 16 {
			t.Errorf("tools window used_percent = %v, want 16", *w.UsedPercent)
		}
	}
}

// A 100%-used window flips the snapshot to limited.
func TestGLMDriverLimited(t *testing.T) {
	quota, err := fetchWith(t, GLMDriver{}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":200,"success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":100}],"level":"lite"}}`))
	}, "k")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if quota.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("status = %q, want limited", quota.Status)
	}
}

func TestGLMDriverBusinessFailure(t *testing.T) {
	_, err := fetchWith(t, GLMDriver{}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":401,"msg":"unauthorized","success":false}`))
	}, "bad")
	if err == nil || ClassifyError(err) != "invalid_credential" {
		t.Fatalf("expected invalid_credential, got %v", err)
	}
}

func TestGLMDriverHTTP401(t *testing.T) {
	_, err := fetchWith(t, GLMDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}, "bad")
	if err == nil || ClassifyError(err) != "invalid_credential" {
		t.Fatalf("expected invalid_credential, got %v", err)
	}
}

func TestGLMDriverRateLimited(t *testing.T) {
	_, err := fetchWith(t, GLMDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
	}, "k")
	if err == nil || ClassifyError(err) != "rate_limited" {
		t.Fatalf("expected rate_limited, got %v", err)
	}
}

func TestGLMWindowMinutes(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	cases := []struct {
		name         string
		unit, number *float64
		want         int64
	}{
		{"nil unit", nil, f(5), 0},
		{"5h", f(3), f(5), 300},
		{"hours no number", f(3), nil, 0},
		{"week number=7", f(6), f(7), 10080},
		{"week number=1", f(6), f(1), 10080},
		{"week no number", f(6), nil, 10080},
		{"month", f(5), f(1), 0},
		{"unknown", f(9), f(2), 0},
	}
	for _, c := range cases {
		if got := GLMWindowMinutes(c.unit, c.number); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestZenMuxDriverFetch(t *testing.T) {
	var gotAuth string
	quota, err := fetchWith(t, ZenMuxDriver{}, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"success":true,"data":{"quota_5_hour":{"usage_percentage":0.25,"resets_at":"2026-11-04T12:00:00Z"},"quota_7_day":{"usage_percentage":0.8,"resets_at":"2026-11-08T00:00:00Z"}}}`))
	}, "mgmt-key-123456")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotAuth != "Bearer mgmt-key-123456" {
		t.Fatalf("auth = %q (Bearer expected)", gotAuth)
	}
	if quota.Provider != "zenmux" {
		t.Fatalf("provider = %q", quota.Provider)
	}
	if m, used, ok := window(quota, "zenmux_5h"); !ok || m != 300 || used != 25 {
		t.Errorf("5h window: minutes=%d used=%v ok=%v", m, used, ok)
	}
	if m, used, ok := window(quota, "zenmux_7d"); !ok || m != 10080 || used != 80 {
		t.Errorf("7d window: minutes=%d used=%v ok=%v", m, used, ok)
	}
	if quota.Windows[0].ResetsAt == nil || *quota.Windows[0].ResetsAt != time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC).Unix() {
		t.Errorf("5h resets_at = %v", quota.Windows[0].ResetsAt)
	}
}

func TestZenMuxDriverEmptyWindows(t *testing.T) {
	_, err := fetchWith(t, ZenMuxDriver{}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
	}, "k")
	if err == nil || ClassifyError(err) != "unexpected_response" {
		t.Fatalf("expected unexpected_response, got %v", err)
	}
}

func TestZenMuxDriverInvalidCredential(t *testing.T) {
	_, err := fetchWith(t, ZenMuxDriver{}, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}, "bad")
	if err == nil || ClassifyError(err) != "invalid_credential" {
		t.Fatalf("expected invalid_credential, got %v", err)
	}
}

// The base_url host must sit on the driver's allowlist and be public HTTPS.
// DNS is stubbed: this sandbox's resolver answers real hostnames with
// synthetic addresses, so only the policy (scheme/host/allowlist) is tested
// here; the public-address rule is the remotemcp package's own contract.
type stubResolver struct{}

func (stubResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	addr, err := netip.ParseAddr("93.184.216.34")
	if err != nil {
		return nil, err
	}
	return []netip.Addr{addr}, nil
}

func TestValidateBaseURLHostAllowlist(t *testing.T) {
	ctx := context.Background()
	validate := func(raw string) error {
		base := raw
		if base == "" {
			base = GLMDriver{}.DefaultBaseURL()
		}
		_, err := remotemcp.ValidatePublicHTTPSEndpoint(ctx, base, GLMDriver{}.AllowedHosts(), stubResolver{})
		return err
	}
	if err := validate("https://evil.example.com"); err == nil {
		t.Fatal("host outside allowlist accepted")
	}
	if err := validate("http://open.bigmodel.cn"); err == nil {
		t.Fatal("non-HTTPS accepted")
	}
	if _, err := remotemcp.ValidatePublicHTTPSEndpoint(ctx, "https://open.bigmodel.cn", ZenMuxDriver{}.AllowedHosts(), stubResolver{}); err == nil {
		t.Fatal("glm host accepted for zenmux driver")
	}
	// The default endpoint must pass its own allowlist.
	if err := validate(""); err != nil {
		t.Fatalf("default base URL rejected: %v", err)
	}
	if _, err := remotemcp.ValidatePublicHTTPSEndpoint(ctx, "", ZenMuxDriver{}.AllowedHosts(), stubResolver{}); err != nil {
		// empty raw defaults to driver default only in ValidateBaseURL
		if _, err2 := remotemcp.ValidatePublicHTTPSEndpoint(ctx, ZenMuxDriver{}.DefaultBaseURL(), ZenMuxDriver{}.AllowedHosts(), stubResolver{}); err2 != nil {
			t.Fatalf("default zenmux base URL rejected: %v", err2)
		}
	}
}

// fixedAddrs answers every lookup with the same addresses, standing in for
// the system resolver on a fake-ip gateway.
type fixedAddrs []netip.Addr

func (f fixedAddrs) LookupNetIP(_ context.Context, _, _ string) ([]netip.Addr, error) {
	return f, nil
}

// Behind a transparent proxy in fake-ip mode (Mihomo/Clash enhanced-mode)
// the system resolver answers every public hostname out of 198.18.0.0/15.
// The quota chain accepts exactly that pool — registering and polling a
// provider host keeps working — while real intranet, loopback and metadata
// answers stay refused.
func TestValidateBaseURLAcceptsFakeIPGateway(t *testing.T) {
	ctx := context.Background()
	glm := GLMDriver{}

	fake := fixedAddrs{netip.MustParseAddr("198.18.0.165"), netip.MustParseAddr("198.19.3.48")}
	for _, host := range glm.AllowedHosts() {
		if _, err := ValidateBaseURL(ctx, glm, "https://"+host, fake); err != nil {
			t.Fatalf("fake-ip resolution of %s rejected: %v", host, err)
		}
	}
	zenmux := fixedAddrs{netip.MustParseAddr("198.18.3.45")}
	if _, err := ValidateBaseURL(ctx, ZenMuxDriver{}, ZenMuxDriver{}.DefaultBaseURL(), zenmux); err != nil {
		t.Fatalf("fake-ip resolution of %s rejected: %v", ZenMuxDriver{}.DefaultBaseURL(), err)
	}

	// A pool address alongside a real intranet answer fails closed: the
	// exemption widens nothing but the pool.
	rebind := fixedAddrs{netip.MustParseAddr("198.18.0.165"), netip.MustParseAddr("192.168.50.1")}
	if _, err := ValidateBaseURL(ctx, glm, glm.DefaultBaseURL(), rebind); err == nil {
		t.Fatal("a mixed fake-ip + intranet answer was accepted")
	}
	for _, addr := range []string{
		"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.50.1",
		"169.254.169.254", "100.64.0.1", "0.0.0.1", "0.1.2.3",
		"::1", "fd00::1",
	} {
		answer := fixedAddrs{netip.MustParseAddr(addr)}
		if _, err := ValidateBaseURL(ctx, glm, glm.DefaultBaseURL(), answer); err == nil {
			t.Fatalf("%s was accepted", addr)
		}
	}
}

// The dial half of the quota chain: the client a provider fetch dials with
// must accept the pool ValidateBaseURL accepted and keep refusing everything
// else. Guards the fake-ip wiring end to end without a database; the context
// is already canceled so no dial ever leaves the machine — the gate runs
// before the connect.
func TestNewHTTPClientDialGateMatchesValidation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	poolEndpoint, err := url.Parse("https://198.18.0.165")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewHTTPClient(poolEndpoint).Transport.(*http.Transport).DialContext(ctx, "tcp", "198.18.0.165:443"); err == nil || strings.Contains(err.Error(), "non-public") {
		t.Fatalf("quota-source dial gate refused a fake-ip pool address: %v", err)
	}

	for _, addr := range []string{"127.0.0.1", "0.1.2.3"} {
		endpoint, err := url.Parse("https://" + addr)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := NewHTTPClient(endpoint).Transport.(*http.Transport).DialContext(ctx, "tcp", addr+":443"); err == nil || !strings.Contains(err.Error(), "non-public") {
			t.Fatalf("quota-source dial gate accepted %s (err = %v)", addr, err)
		}
	}
}

func TestDriverFor(t *testing.T) {
	if DriverFor("glm") == nil || DriverFor("zenmux") == nil {
		t.Fatal("known kinds must resolve")
	}
	if DriverFor("http") != nil {
		t.Fatal("generic kind must not resolve")
	}
}
