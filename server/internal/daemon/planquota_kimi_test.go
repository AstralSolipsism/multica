package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func f64(v float64) *float64 { return &v }

func kimiLimitsJSON() string {
	return `{
	  "code": 0,
	  "msg": "success",
	  "data": {
	    "kind": "ok",
	    "summary": {"name": "5-hour", "window": {"duration": 5, "unit": "hour"}, "used": 12, "limit": 100, "reset_at": 1741234567},
	    "limits": [
	      {"name": "weekly", "window": {"duration": 7, "unit": "day"}, "used": 45, "limit": 500, "reset_at": 1741700000},
	      {"name": "5-hour", "window": {"duration": 5, "unit": "hour"}, "used": 12, "limit": 100, "reset_at": 1741234567}
	    ],
	    "extra_usage": {"balance_cents": 1288, "currency": "cny"}
	  }
	}`
}

// newKimiTestServer serves healthz and the usage envelope, recording the
// bearer it was called with.
func newKimiTestServer(t *testing.T, usageBody string, usageStatus int, gotAuth *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/healthz":
			w.WriteHeader(http.StatusOK)
		case "/api/v1/oauth/usage":
			*gotAuth = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			if usageStatus != 0 {
				w.WriteHeader(usageStatus)
			}
			_, _ = w.Write([]byte(usageBody))
		default:
			http.NotFound(w, r)
		}
	}))
}

// kimiTestHome builds a fake ~/.kimi-code: the token file and an instance
// registry entry pinning the test server's port.
func kimiTestHome(t *testing.T, port int) string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, kimiServerTokenFile), []byte("test-kimi-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	instances := filepath.Join(home, kimiServerInstances)
	if err := os.MkdirAll(instances, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(instances, "inst-1.json"), []byte(fmt.Sprintf(`{"port": %d}`, port)), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func serverPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	var port int
	if _, err := fmt.Sscanf(srv.URL, "http://127.0.0.1:%d", &port); err != nil {
		t.Fatalf("parse test server port from %q: %v", srv.URL, err)
	}
	return port
}

func TestKimiCollect_Success(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	quota, err := collector.collect(context.Background())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if gotAuth != "Bearer test-kimi-token" {
		t.Fatalf("authorization header = %q", gotAuth)
	}
	if quota.Provider != "kimi" || quota.Source != protocol.PlanQuotaSourceDaemon || quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("identity fields = %+v", quota)
	}
	if quota.ObservedAt <= 0 {
		t.Fatalf("observed_at = %d", quota.ObservedAt)
	}
	if len(quota.Windows) != 2 {
		t.Fatalf("windows = %+v", quota.Windows)
	}
	primary, secondary := quota.Windows[0], quota.Windows[1]
	if primary.Name != "primary" || *primary.WindowMinutes != 300 || *primary.UsedPercent != 12 || *primary.ResetsAt != 1741234567 {
		t.Fatalf("primary window = %+v", primary)
	}
	if secondary.Name != "secondary" || *secondary.WindowMinutes != 10080 || *secondary.UsedPercent != 9 || *secondary.ResetsAt != 1741700000 {
		t.Fatalf("secondary window = %+v", secondary)
	}
	if collector.port != serverPort(t, srv) {
		t.Fatalf("remembered port = %d", collector.port)
	}
}

// The wallet payload must never cross into the snapshot: no balance, no
// currency, no token — provider metadata stays on the machine.
func TestKimiCollect_RedLine(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	quota, err := collector.collect(context.Background())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	raw, err := json.Marshal(quota)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"test-kimi-token", "balance", "cents", "currency", "cny", "1288", "extra_usage"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("snapshot leaks %q: %s", forbidden, raw)
		}
	}
}

func TestKimiCollect_ServerDown(t *testing.T) {
	// Token file exists but nothing listens anywhere: silent-degrade path —
	// an error for the loop to log, never a panic.
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, kimiServerTokenFile), []byte("tok"), 0o600); err != nil {
		t.Fatal(err)
	}
	collector := newKimiPlanQuotaCollector(home)
	collector.client.Timeout = 200 * time.Millisecond
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected error when no server is running")
	}
}

func TestKimiCollect_MissingToken(t *testing.T) {
	collector := newKimiPlanQuotaCollector(t.TempDir())
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected error when server.token is absent")
	}
}

func TestKimiCollect_InBandError(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, `{"code":0,"data":{"kind":"error","message":"upstream unavailable","status":502}}`, 0, &gotAuth)
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	if _, err := collector.collect(context.Background()); err == nil || !strings.Contains(err.Error(), "upstream unavailable") {
		t.Fatalf("err = %v", err)
	}
}

func TestKimiCollect_EnvelopeError(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, `{"code":40101,"msg":"unauthorized"}`, 0, &gotAuth)
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected envelope-code error")
	}
}

// A drifted (experimental-API-changed) response must fail the round, not
// crash the daemon.
func TestKimiCollect_DriftedShape(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, `{"code":0,"data":{"totally":"different"}}`, 0, &gotAuth)
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	quota, err := collector.collect(context.Background())
	// kind is absent (≠ "ok") → treated as an in-band failure.
	if err == nil {
		t.Fatalf("expected error for drifted shape, got quota %+v", quota)
	}
}

func TestKimiUsageToPlanQuota_Mapping(t *testing.T) {
	observed := time.Unix(1757000000, 0)
	t.Run("sorts and renames canonical windows", func(t *testing.T) {
		data := &kimiUsageData{
			Kind: "ok",
			Limits: []kimiUsageLimitRow{
				{Name: "weekly", Window: &kimiUsageWindow{Duration: 1, Unit: "week"}, Used: f64(45), Limit: f64(500), ResetAt: float64(1741700000)},
				{Name: "5-hour", Window: &kimiUsageWindow{Duration: 5, Unit: "hour"}, Used: f64(0), Limit: f64(100), ResetAt: float64(1741234567)},
			},
		}
		quota := kimiUsageToPlanQuota(data, observed)
		if quota == nil || len(quota.Windows) != 2 {
			t.Fatalf("quota = %+v", quota)
		}
		if quota.Windows[0].Name != "primary" || *quota.Windows[0].WindowMinutes != 300 {
			t.Fatalf("first window = %+v", quota.Windows[0])
		}
		// A real 0% is preserved as 0, not treated as unreported.
		if quota.Windows[0].UsedPercent == nil || *quota.Windows[0].UsedPercent != 0 {
			t.Fatalf("zero used_percent lost: %+v", quota.Windows[0])
		}
		if quota.Windows[1].Name != "secondary" || *quota.Windows[1].WindowMinutes != 10080 {
			t.Fatalf("second window = %+v", quota.Windows[1])
		}
	})

	t.Run("limited when a window is full", func(t *testing.T) {
		data := &kimiUsageData{
			Kind:   "ok",
			Limits: []kimiUsageLimitRow{{Name: "5-hour", Window: &kimiUsageWindow{Duration: 5, Unit: "hour"}, Used: f64(100), Limit: f64(100)}},
		}
		quota := kimiUsageToPlanQuota(data, observed)
		if quota.Status != protocol.PlanQuotaStatusLimited {
			t.Fatalf("status = %q", quota.Status)
		}
	})

	t.Run("missing limit means no percentage", func(t *testing.T) {
		data := &kimiUsageData{
			Kind:   "ok",
			Limits: []kimiUsageLimitRow{{Name: "5-hour", Window: &kimiUsageWindow{Duration: 5, Unit: "hour"}, Used: f64(3)}},
		}
		quota := kimiUsageToPlanQuota(data, observed)
		if quota.Windows[0].UsedPercent != nil {
			t.Fatalf("fabricated percent: %+v", quota.Windows[0])
		}
	})

	t.Run("empty rows dropped, empty input nil", func(t *testing.T) {
		if got := kimiUsageToPlanQuota(nil, observed); got != nil {
			t.Fatalf("nil input = %+v", got)
		}
		if got := kimiUsageToPlanQuota(&kimiUsageData{Kind: "ok"}, observed); got != nil {
			t.Fatalf("no limits = %+v", got)
		}
		if got := kimiUsageToPlanQuota(&kimiUsageData{Kind: "ok", Limits: []kimiUsageLimitRow{{}}}, observed); got != nil {
			t.Fatalf("empty row = %+v", got)
		}
	})

	t.Run("third window keeps provider name", func(t *testing.T) {
		data := &kimiUsageData{
			Kind: "ok",
			Limits: []kimiUsageLimitRow{
				{Name: "5-hour", Window: &kimiUsageWindow{Duration: 5, Unit: "hour"}, Used: f64(1), Limit: f64(10)},
				{Name: "weekly", Window: &kimiUsageWindow{Duration: 7, Unit: "day"}, Used: f64(1), Limit: f64(10)},
				{Name: "monthly", Window: &kimiUsageWindow{Duration: 30, Unit: "day"}, Used: f64(1), Limit: f64(10)},
			},
		}
		quota := kimiUsageToPlanQuota(data, observed)
		if len(quota.Windows) != 3 || quota.Windows[2].Name != "monthly" {
			t.Fatalf("windows = %+v", quota.Windows)
		}
	})
}

func TestUnixSecondsPtr(t *testing.T) {
	if got := unixSecondsPtr(float64(1741234567)); got == nil || *got != 1741234567 {
		t.Fatalf("float = %v", got)
	}
	if got := unixSecondsPtr("1741234567"); got == nil || *got != 1741234567 {
		t.Fatalf("numeric string = %v", got)
	}
	if got := unixSecondsPtr("2026-03-24T08:35:09Z"); got == nil || *got != time.Date(2026, 3, 24, 8, 35, 9, 0, time.UTC).Unix() {
		t.Fatalf("rfc3339 = %v", got)
	}
	for _, bad := range []any{nil, "", "not-a-time", float64(0), float64(-5), true} {
		if got := unixSecondsPtr(bad); got != nil {
			t.Fatalf("%v = %v, want nil", bad, *got)
		}
	}
}
