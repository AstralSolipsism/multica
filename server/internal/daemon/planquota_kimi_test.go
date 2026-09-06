package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
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
	c.verifyConnPeer = func(net.Conn) bool { return true }
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
// connection point, and both proofs are consulted on every dial.
func TestLoopbackOwnedDialContext(t *testing.T) {
	for _, addr := range []string{"203.0.113.10:443", "192.168.1.5:8080", "[::1]:58627"} {
		if _, err := loopbackOwnedDialContext(context.Background(), "tcp", addr, nil, nil); err == nil {
			t.Fatalf("expected %s to be refused", addr)
		}
	}

	// Pre-dial probe consulted per dial: first dial passes, second (after
	// the listener changed hands) is refused.
	var owned atomic.Bool
	owned.Store(true)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	check := func(int) bool { return owned.Load() }
	conn, err := loopbackOwnedDialContext(context.Background(), "tcp", ln.Addr().String(), check, nil)
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	_ = conn.Close()
	owned.Store(false)
	if _, err := loopbackOwnedDialContext(context.Background(), "tcp", ln.Addr().String(), check, nil); err == nil {
		t.Fatal("second dial not refused after ownership flip")
	}

	// The established-peer proof is consulted after connecting, with the
	// actual connection: LISTEN fine, peer unprovable → connection closed.
	peerOK := func(net.Conn) bool { return false }
	if _, err := loopbackOwnedDialContext(context.Background(), "tcp", ln.Addr().String(), nil, peerOK); err == nil {
		t.Fatal("dial not refused when the established peer is unprovable")
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
		v6Loopback = "00000000000000000000000001000000" // ::1, host-order words — cannot serve a v4 dial
		v6MappedV4 = "0000000000000000FFFF00000100007F" // ::ffff:127.0.0.1, host-order words
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

// Round-4 R1 regression: probe passes, the server releases the port, a
// different-owner process claims it, and the credential-carrying request —
// which must re-dial because the probe connection closed — is refused at
// dial time. The ownership flip is sequenced deterministically: A flips it
// inside the probe handler, which happens-before the client reads the
// response and dials again.
func TestKimiCollect_ReconnectionRevalidatesListener(t *testing.T) {
	lnA, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := lnA.Addr().(*net.TCPAddr).Port

	var owned atomic.Bool
	owned.Store(true)
	var probeServed atomic.Int64

	srvA := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("server A received a credential") // A is same-owner, but the point is zero delivery after the flip
		}
		w.Header().Set("Connection", "close") // force a NEW dial for the usage request
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":40101,"msg":"missing bearer token"}`))
		probeServed.Add(1)
		// The listener changes hands as the probe answer goes out.
		owned.Store(false)
	})}
	go func() { _ = srvA.Serve(lnA) }()

	// B claims the same port once A lets go — the foreign new owner.
	var hitsB atomic.Int64
	var authB atomic.Int64
	go func() {
		for i := 0; i < 200; i++ {
			if probeServed.Load() > 0 {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		_ = srvA.Close()
		lnB, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return // port still settling; the dial-time refusal must hold regardless
		}
		srvB := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hitsB.Add(1)
			if r.Header.Get("Authorization") != "" {
				authB.Add(1)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":40101,"msg":"missing bearer token"}`))
		})}
		_ = srvB.Serve(lnB)
		t.Cleanup(func() { _ = srvB.Close() })
	}()
	t.Cleanup(func() { _ = srvA.Close() })

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
	collector.socketOwnedByUser = func(int) bool { return owned.Load() }

	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail after the listener changed hands")
	}
	if probeServed.Load() == 0 {
		t.Fatal("probe never reached A — test setup broken")
	}
	if hitsB.Load() != 0 || authB.Load() != 0 {
		t.Fatalf("new owner received %d requests (%d authed)", hitsB.Load(), authB.Load())
	}
}

// The established-peer proof parses the SERVER side of the exact 4-tuple.
// Matrix includes the round-5 shape: our LISTEN on the port while the
// ESTABLISHED row (the connection we actually hold) belongs to uid 65534.
func TestEstablishedPeerOwnedByUID(t *testing.T) {
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
	row := func(local, rem, st string, uid int) string {
		return fmt.Sprintf("   0: %s %s %s 00000000:00000000 00:00000000 00000000 %5d        0 12345 1 0000000000000000 100 0 0 10 0", local, rem, st, uid)
	}
	// server 58627 = E503, client ephemeral 40000 = 9C40
	const (
		v4lo     = "0100007F"
		v6Mapped = "0000000000000000FFFF00000100007F"
	)
	table := func(lines ...string) [][]byte { return [][]byte{[]byte(header + "\n" + strings.Join(lines, "\n"))} }

	t.Run("ours", func(t *testing.T) {
		if !establishedPeerOwnedByUID(58627, 40000, 1000, table(row(v4lo+":E503", v4lo+":9C40", "01", 1000))) {
			t.Fatal("own established peer rejected")
		}
	})
	t.Run("foreign established row fails", func(t *testing.T) {
		if establishedPeerOwnedByUID(58627, 40000, 1000, table(row(v4lo+":E503", v4lo+":9C40", "01", 65534))) {
			t.Fatal("foreign established peer accepted")
		}
	})
	t.Run("round-5 shape: our LISTEN plus foreign ESTABLISHED fails", func(t *testing.T) {
		tables := table(
			row(v4lo+":E503", "00000000:0000", "0A", 1000), // our re-bound listener
			row(v4lo+":E503", v4lo+":9C40", "01", 65534),   // foreign accepted conn
		)
		if establishedPeerOwnedByUID(58627, 40000, 1000, tables) {
			t.Fatal("foreign accepted connection hidden behind our listener")
		}
	})
	t.Run("no established row fails closed", func(t *testing.T) {
		if establishedPeerOwnedByUID(58627, 40000, 1000, table(row(v4lo+":E503", "00000000:0000", "0A", 1000))) {
			t.Fatal("LISTEN-only accepted as peer proof")
		}
	})
	t.Run("wrong ephemeral or wrong port does not match", func(t *testing.T) {
		if establishedPeerOwnedByUID(58627, 40000, 1000, table(row(v4lo+":E503", v4lo+":9C41", "01", 1000))) {
			t.Fatal("wrong ephemeral accepted")
		}
		if establishedPeerOwnedByUID(58627, 40000, 1000, table(row(v4lo+":E504", v4lo+":9C40", "01", 1000))) {
			t.Fatal("wrong server port accepted")
		}
	})
	t.Run("non-established states ignored", func(t *testing.T) {
		if establishedPeerOwnedByUID(58627, 40000, 1000, table(row(v4lo+":E503", v4lo+":9C40", "06", 1000))) { // TIME_WAIT
			t.Fatal("TIME_WAIT row accepted")
		}
	})
	t.Run("v4-mapped dual-stack row matches", func(t *testing.T) {
		if !establishedPeerOwnedByUID(58627, 40000, 1000, table(row(v6Mapped+":E503", v6Mapped+":9C40", "01", 1000))) {
			t.Fatal("v4-mapped established row rejected")
		}
	})
}

// The macOS lsof -F pun parser: process blocks (p/u) then per-fd name lines.
func TestLsofEstablishedPeerOwnedBy(t *testing.T) {
	out := "p100\nu501\nf3\nn127.0.0.1:58627->127.0.0.1:40000 (ESTABLISHED)\n"
	if !lsofEstablishedPeerOwnedBy(out, 58627, 40000, 501) {
		t.Fatal("own server-direction row rejected")
	}
	foreign := "p100\nu65534\nf3\nn127.0.0.1:58627->127.0.0.1:40000 (ESTABLISHED)\n"
	if lsofEstablishedPeerOwnedBy(foreign, 58627, 40000, 501) {
		t.Fatal("foreign server-direction row accepted")
	}
	// Client-direction row (our own) must not count as the peer.
	clientOnly := "p99\nu501\nf5\nn127.0.0.1:40000->127.0.0.1:58627 (ESTABLISHED)\n"
	if lsofEstablishedPeerOwnedBy(clientOnly, 58627, 40000, 501) {
		t.Fatal("client-direction row accepted as peer proof")
	}
	if lsofEstablishedPeerOwnedBy("", 58627, 40000, 501) {
		t.Fatal("empty output accepted")
	}
	// Port prefix must not collide: asking for 5000 must not match 50001,
	// and the ephemeral side is exact too.
	collision := "p100\nu501\nf3\nn127.0.0.1:50001->127.0.0.1:40000 (ESTABLISHED)\n"
	if lsofEstablishedPeerOwnedBy(collision, 5000, 40000, 501) {
		t.Fatal("port 50001 accepted for a 5000 query (prefix collision)")
	}
	collisionEph := "p100\nu501\nf3\nn127.0.0.1:58627->127.0.0.1:400001 (ESTABLISHED)\n"
	if lsofEstablishedPeerOwnedBy(collisionEph, 58627, 40000, 501) {
		t.Fatal("ephemeral 400001 accepted for a 40000 query (prefix collision)")
	}
	nonLoopback := "p100\nu501\nf3\nn192.168.1.5:58627->127.0.0.1:40000 (ESTABLISHED)\n"
	if lsofEstablishedPeerOwnedBy(nonLoopback, 58627, 40000, 501) {
		t.Fatal("non-loopback server endpoint accepted")
	}
}

// Collector level: LISTEN proof fine, established-peer proof fails → zero
// credential delivery (deterministic, platform-independent).
func TestKimiCollect_EstablishedPeerMustMatchProof(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
	collector.verifyConnPeer = func(net.Conn) bool { return false }
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail when the established peer is unprovable")
	}
	if gotAuth != "" {
		t.Fatalf("credential delivered to unproven peer: %q", gotAuth)
	}
}
