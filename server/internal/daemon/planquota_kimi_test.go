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
// usage payload. Every request (and every Authorization header) is recorded.
func newKimiTestServer(t *testing.T, usageBody string, usageStatus int, gotAuth *string) *httptest.Server {
	t.Helper()
	return newKimiTestServerCounted(t, usageBody, usageStatus, gotAuth, nil)
}

func newKimiTestServerCounted(t *testing.T, usageBody string, usageStatus int, gotAuth *string, hits *atomic.Int64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			hits.Add(1)
		}
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
// registry entry pinning the test server's port, claiming THIS test process
// as the server pid (tests stub verifyProcess around it).
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
	entry := fmt.Sprintf(`{"server_id":"01TEST","pid":%d,"host":"127.0.0.1","port":%d}`, os.Getpid(), port)
	if err := os.WriteFile(filepath.Join(instances, "01TEST.json"), []byte(entry), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

// kimiTestHomeNoRegistry builds the home with the token but NO instance
// registry, forcing the scan-fallback path.
func kimiTestHomeNoRegistry(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, kimiServerTokenFile), []byte("test-kimi-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

// newKimiTestCollector builds a collector for tests: identity checks stubbed
// to pass, scan fallback pointed at the test server's port. Tests override
// individual probes to pin the failure modes.
func newKimiTestCollector(home string, port int) *kimiPlanQuotaCollector {
	c := newKimiPlanQuotaCollector(home)
	c.verifyProcess = func(int) error { return nil }
	c.identitySupported = func() bool { return true }    // fixtures isolate from the platform gate
	c.socketOwnedByUser = func(int) bool { return true } // real probes are covered by the linux live test
	c.scanBase = port
	c.scanCount = 1
	return c
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
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
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
	if collector.port != port {
		t.Fatalf("remembered port = %d", collector.port)
	}
}

// The scan fallback serves registries that are absent or empty (older
// servers): the port is bound via socket ownership instead of a pid.
func TestKimiCollect_ScanFallback(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
	quota, err := collector.collect(context.Background())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if gotAuth != "Bearer test-kimi-token" {
		t.Fatalf("authorization header = %q", gotAuth)
	}
	if len(quota.Windows) != 2 {
		t.Fatalf("windows = %+v", quota.Windows)
	}
}

// The wallet payload must never cross into the snapshot: no balance, no
// currency, no token — provider metadata stays on the machine.
func TestKimiCollect_RedLine(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
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
	collector := newKimiTestCollector(home, 59870) // nothing listens here
	collector.scanCount = 2
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
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
	if _, err := collector.collect(context.Background()); err == nil || !strings.Contains(err.Error(), "upstream unavailable") {
		t.Fatalf("err = %v", err)
	}
}

func TestKimiCollect_EnvelopeError(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, `{"code":40101,"msg":"unauthorized"}`, 0, &gotAuth)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
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
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
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
// envelope 40101) is what gates credential delivery on the scan path.
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
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
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
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
	collector.socketOwnedByUser = func(int) bool { return false } // foreign-owned socket
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail when the socket is foreign-owned")
	}
	if gotAuth != "" {
		t.Fatalf("foreign-owned service received credentials: %q", gotAuth)
	}
}

// A registry entry whose pid is dead, foreign-owned, or a non-kimi image is
// skipped before any packet is sent — and a present-but-unverifiable
// registry does NOT fall back to scanning (a live squatting server on a
// scanned port must not rescue a stale or forged entry).
func TestKimiCollect_UnverifiableInstanceGetsNoToken(t *testing.T) {
	var hits atomic.Int64
	var gotAuth string
	srv := newKimiTestServerCounted(t, kimiLimitsJSON(), 0, &gotAuth, &hits)
	defer srv.Close()
	port := serverPort(t, srv)

	// Registry points at the live squatting server but with a pid the
	// verifier rejects; scan would find the same server, and must not run.
	collector := newKimiPlanQuotaCollector(kimiTestHome(t, port))
	collector.verifyProcess = func(pid int) error { return fmt.Errorf("pid %d owned by another user", pid) }
	collector.socketOwnedByUser = func(int) bool { return true }
	collector.scanBase = port
	collector.scanCount = 1
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail for an unverifiable instance")
	}
	if hits.Load() != 0 {
		t.Fatalf("squatting server received %d requests (auth %q)", hits.Load(), gotAuth)
	}
}

// Platforms that cannot prove ownership fail closed: no request at all.
func TestKimiCollect_UnsupportedPlatformSendsNothing(t *testing.T) {
	var hits atomic.Int64
	var gotAuth string
	srv := newKimiTestServerCounted(t, kimiLimitsJSON(), 0, &gotAuth, &hits)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
	collector.identitySupported = func() bool { return false }
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected fail-closed error on unsupported platform")
	}
	if hits.Load() != 0 {
		t.Fatalf("unsupported platform still sent %d requests", hits.Load())
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
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
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
	if _, err := loopbackOnlyDialContext(context.Background(), "tcp", "[::1]:58627"); err == nil {
		t.Fatal("expected IPv6 loopback dial to be refused (v4-only proof boundary)")
	}
}

// Socket-ownership table parsing, address-aware: the listener must be able
// to serve a 127.0.0.1 dial AND belong to our uid.
func TestLoopbackListenOwnedByUID(t *testing.T) {
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
	entry := func(hexAddr, hexPort string, st string, uid int) string {
		return fmt.Sprintf("   0: %s:%s 00000000:0000 %s 00000000:00000000 00:00000000 00000000 %5d        0 12345 1 0000000000000000 100 0 0 10 0", hexAddr, hexPort, st, uid)
	}
	// 58627 = 0xE503
	table := func(lines ...string) [][]byte { return [][]byte{[]byte(header + "\n" + strings.Join(lines, "\n"))} }

	const (
		v4Loopback = "0100007F"
		v4Wildcard = "00000000"
		v4Lan      = "AC150005" // 172.21.0.5
		v6Wildcard = "00000000000000000000000000000000"
		v6Loopback = "00000000000000000000000000000001" // ::1 — cannot serve a v4 dial
		v6MappedV4 = "00000000000000000000FFFF0100007F" // ::ffff:127.0.0.1
	)

	t.Run("v4 loopback same uid passes", func(t *testing.T) {
		if !loopbackListenOwnedByUID(58627, 1000, table(entry(v4Loopback, "E503", "0A", 1000))) {
			t.Fatal("rejected")
		}
	})
	t.Run("v4 loopback foreign uid fails", func(t *testing.T) {
		if loopbackListenOwnedByUID(58627, 1000, table(entry(v4Loopback, "E503", "0A", 65534))) {
			t.Fatal("accepted foreign listener")
		}
	})
	t.Run("wildcards serving 127.0.0.1 pass when ours", func(t *testing.T) {
		if !loopbackListenOwnedByUID(58627, 1000, table(entry(v4Wildcard, "E503", "0A", 1000))) {
			t.Fatal("v4 wildcard rejected")
		}
		if !loopbackListenOwnedByUID(58627, 1000, table(entry(v6Wildcard, "E503", "0A", 1000))) {
			t.Fatal("v6 dual-stack wildcard rejected")
		}
		if !loopbackListenOwnedByUID(58627, 1000, table(entry(v6MappedV4, "E503", "0A", 1000))) {
			t.Fatal("v4-mapped loopback rejected")
		}
	})
	t.Run("v6-only loopback cannot serve a v4 dial", func(t *testing.T) {
		if loopbackListenOwnedByUID(58627, 1000, table(entry(v6Loopback, "E503", "0A", 1000))) {
			t.Fatal("::1-only listener accepted for a 127.0.0.1 dial")
		}
	})
	t.Run("LAN-bound listener cannot serve loopback", func(t *testing.T) {
		if loopbackListenOwnedByUID(58627, 1000, table(entry(v4Lan, "E503", "0A", 1000))) {
			t.Fatal("LAN listener accepted")
		}
	})
	t.Run("non-listen and missing entries fail", func(t *testing.T) {
		if loopbackListenOwnedByUID(58627, 1000, table(entry(v4Loopback, "E503", "08", 1000))) {
			t.Fatal("accepted a non-LISTEN socket")
		}
		if loopbackListenOwnedByUID(58627, 1000, table()) {
			t.Fatal("accepted with no socket entry at all")
		}
		if loopbackListenOwnedByUID(58627, 1000, table(entry(v4Loopback, "E504", "0A", 1000))) {
			t.Fatal("accepted a socket on a different port")
		}
	})
	// The round-3 review repro: a same-user ::1 registry fixture passes pid
	// verification, while a FOREIGN user serves the fake 40101 on the same
	// port over IPv4 — the actual dial target. The check must fail.
	t.Run("foreign v4 listener on same port defeats a same-user v6 fixture", func(t *testing.T) {
		tables := [][]byte{
			[]byte(header + "\n" + entry(v4Loopback, "E503", "0A", 65534)),
			[]byte(header + "\n" + entry(v6Loopback, "E503", "0A", 1000)),
		}
		if loopbackListenOwnedByUID(58627, 1000, tables) {
			t.Fatal("foreign v4 listener accepted behind a same-user v6 fixture")
		}
	})
	t.Run("dual-stack split ownership fails closed", func(t *testing.T) {
		tables := [][]byte{
			[]byte(header + "\n" + entry(v4Loopback, "E503", "0A", 1000)),
			[]byte(header + "\n" + entry(v6Wildcard, "E503", "0A", 65534)),
		}
		if loopbackListenOwnedByUID(58627, 1000, tables) {
			t.Fatal("mixed-ownership dual-stack accepted")
		}
	})
}

// The registry path must not bypass the socket proof: a pid-verified entry
// whose actual 127.0.0.1:<port> listener belongs to another user still gets
// no credential (round-3 review repro shape).
func TestKimiCollect_RegistryPathRequiresSocketOwnership(t *testing.T) {
	var hits atomic.Int64
	var gotAuth string
	srv := newKimiTestServerCounted(t, kimiLimitsJSON(), 0, &gotAuth, &hits)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
	collector.socketOwnedByUser = func(int) bool { return false } // foreign listener on the dialed target
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail when the dialed socket is foreign-owned")
	}
	if gotAuth != "" {
		t.Fatalf("registry path delivered credentials without socket proof: %q", gotAuth)
	}
}
