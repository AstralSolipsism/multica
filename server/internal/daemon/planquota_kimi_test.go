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
	"sync/atomic"
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

// newKimiTestServer emulates Kimi's auth surface: unauthenticated /api/*
// calls get HTTP 401 with envelope code 40101; authenticated ones get the
// usage payload. Every Authorization header seen is recorded.
func newKimiTestServer(t *testing.T, usageBody string, usageStatus int, gotAuth *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/oauth/usage" {
			http.NotFound(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		if auth == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":40101,"msg":"missing bearer token"}`))
			return
		}
		*gotAuth = auth
		w.Header().Set("Content-Type", "application/json")
		if usageStatus != 0 {
			w.WriteHeader(usageStatus)
		}
		_, _ = w.Write([]byte(usageBody))
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

// --- OL-5 R1 regressions: the bearer must never reach an unverified peer ---

// The reviewer's repro: an unrelated local service answering 200 on any path
// must never receive the token. The unauthenticated handshake (401 +
// envelope 40101) is what gates credential delivery.
func TestKimiCollect_UnrelatedServiceGetsNoToken(t *testing.T) {
	var sawAuth atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			sawAuth.Add(1)
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("unrelated local HTTP service"))
	}))
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail against an unrelated service")
	}
	if sawAuth.Load() != 0 {
		t.Fatalf("unrelated service received %d authenticated requests", sawAuth.Load())
	}
}

// A peer that mimics the 401/40101 handshake still gets no token when the
// listening socket belongs to another user (e.g. a port claimed by a
// foreign process on a shared machine).
func TestKimiCollect_ForeignOwnedSocketGetsNoToken(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	collector.portOwnedByUser = func(int) bool { return false } // foreign-owned socket
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail when the socket is foreign-owned")
	}
	if gotAuth != "" {
		t.Fatalf("foreign-owned service received credentials: %q", gotAuth)
	}
}

// Redirects are never followed: a verified-shape peer that answers the usage
// call with a 307 must not bounce the bearer anywhere — not even to another
// loopback port, let alone off-box (the dialer also refuses non-loopback
// targets outright).
func TestKimiCollect_RedirectNotFollowed(t *testing.T) {
	var redirectHits atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":40101,"msg":"missing bearer token"}`))
			return
		}
		gotAuth = auth
		w.Header().Set("Location", target.URL+"/api/v1/oauth/usage")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer srv.Close()

	collector := newKimiPlanQuotaCollector(kimiTestHome(t, serverPort(t, srv)))
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail on a redirecting peer")
	}
	if redirectHits.Load() != 0 {
		t.Fatalf("redirect target received %d requests", redirectHits.Load())
	}
	// The first peer passed the handshake, so IT may hold the token; the
	// regression being pinned is that the redirect target never does.
	if gotAuth != "Bearer test-kimi-token" {
		t.Fatalf("first peer auth = %q", gotAuth)
	}
}

// The dial constraint itself: non-loopback targets are refused at the
// connection point.
func TestLoopbackOnlyDialContext(t *testing.T) {
	if _, err := loopbackOnlyDialContext(context.Background(), "tcp", "203.0.113.10:443"); err == nil {
		t.Fatal("expected non-loopback dial to be refused")
	}
	if _, err := loopbackOnlyDialContext(context.Background(), "tcp", "192.168.1.5:8080"); err == nil {
		t.Fatal("expected LAN dial to be refused")
	}
}

// Socket-ownership table parsing: same-uid LISTEN passes; foreign uid,
// non-LISTEN states and missing entries all fail.
func TestPortListenOwnedByUID(t *testing.T) {
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
	listen := func(hexPort string, uid int) string {
		return fmt.Sprintf("   0: 0100007F:%s 00000000:0000 0A 00000000:00000000 00:00000000 00000000 %5d        0 12345 1 0000000000000000 100 0 0 10 0", hexPort, uid)
	}
	// 58627 = 0xE503
	if !portListenOwnedByUID(58627, 1000, [][]byte{[]byte(header + "\n" + listen("E503", 1000))}) {
		t.Fatal("same-uid LISTEN socket rejected")
	}
	if portListenOwnedByUID(58627, 1000, [][]byte{[]byte(header + "\n" + listen("E503", 1001))}) {
		t.Fatal("foreign-uid LISTEN socket accepted")
	}
	// A different port's socket must not count.
	if portListenOwnedByUID(58627, 1000, [][]byte{[]byte(header + "\n" + listen("E504", 1000))}) {
		t.Fatal("accepted a socket on a different port")
	}
	// st 08 (CLOSE_WAIT-ish non-LISTEN) must not count.
	nonListen := strings.Replace(listen("E503", 1000), " 0A ", " 08 ", 1)
	if portListenOwnedByUID(58627, 1000, [][]byte{[]byte(header + "\n" + nonListen)}) {
		t.Fatal("accepted a non-LISTEN socket")
	}
	if portListenOwnedByUID(58627, 1000, [][]byte{[]byte(header)}) {
		t.Fatal("accepted with no socket entry at all")
	}
	// Dual-stack: tcp4 + tcp6 both owned by us passes; one foreign fails all.
	v6 := strings.Replace(listen("E503", 1000), "0100007F", "00000000000000000000000001000000", 1)
	if !portListenOwnedByUID(58627, 1000, [][]byte{[]byte(header + "\n" + listen("E503", 1000)), []byte(header + "\n" + v6)}) {
		t.Fatal("dual-table same-uid rejected")
	}
}
