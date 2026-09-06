package daemon

import (
	"context"
	"encoding/json"
	"errors"
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

// newKimiTestServer serves the usage payload and records every request and
// Authorization header.
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
		if gotAuth != nil {
			if auth := r.Header.Get("Authorization"); auth != "" {
				*gotAuth = auth
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if usageStatus != 0 {
			w.WriteHeader(usageStatus)
		}
		_, _ = w.Write([]byte(usageBody))
	}))
}

// kimiTestHome builds a fake ~/.kimi-code: the token file and an instance
// registry entry pointing at the test server's port (discovery only).
func kimiTestHome(t *testing.T, port int) string {
	t.Helper()
	home := kimiTestHomeNoRegistry(t)
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

// newKimiTestCollector builds a collector with all platform probes stubbed
// to pass (real probes are covered by the linux live tests) and the scan
// pointed at the test server's port.
func newKimiTestCollector(home string, port int) *kimiPlanQuotaCollector {
	c := newKimiPlanQuotaCollector(home)
	c.identitySupported = func() bool { return true }
	c.enumerateOwnedListenPorts = func() map[int]struct{} { return map[int]struct{}{port: {}} }
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
// servers): candidates come from the documented 58627+0..99 range.
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
	// Token file exists but nothing listens: silent-degrade path — an error
	// for the loop to log, never a panic.
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, kimiServerTokenFile), []byte("tok"), 0o600); err != nil {
		t.Fatal(err)
	}
	collector := newKimiTestCollector(home, 59870) // nothing listens here
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected error when no server is running")
	}
}

func TestKimiCollect_MissingToken(t *testing.T) {
	collector := newKimiPlanQuotaCollector(t.TempDir())
	collector.identitySupported = func() bool { return true }
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

// Rate limiting maps to the shared backoff signal.
func TestKimiCollect_RateLimited(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, `{"code":42901,"msg":"banned"}`, http.StatusTooManyRequests, &gotAuth)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
	_, err := collector.collect(context.Background())
	var rl *rateLimitError
	if err == nil || !errors.As(err, &rl) {
		t.Fatalf("err = %v, want *rateLimitError", err)
	}
}

// A drifted (experimental-API-changed) response must fail the round, not
// crash the daemon. The usage response itself is the drift guard.
func TestKimiCollect_DriftedShape(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, `{"code":0,"data":{"totally":"different"}}`, 0, &gotAuth)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
	quota, err := collector.collect(context.Background())
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

// --- R1 regressions (converged design: one per-connection gate) ---

// A port with no listener owned by this user is never even dialed (the
// round's owned-set fast-fail), let alone sent credentials.
func TestKimiCollect_PortNotOwnedByUserGetsNoToken(t *testing.T) {
	var hits atomic.Int64
	srv := newKimiTestServerCounted(t, kimiLimitsJSON(), 0, nil, &hits)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
	collector.enumerateOwnedListenPorts = func() map[int]struct{} { return map[int]struct{}{} }
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail with no owned listener")
	}
	if hits.Load() != 0 {
		t.Fatalf("foreign-owned port received %d requests", hits.Load())
	}
}

// The credential gate: a connection whose accepting process cannot be proven
// to be this user's is closed before a byte is written.
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

// Same for a registry-discovered port: discovery is not identity.
func TestKimiCollect_RegistryPortForeignPeerGetsNoToken(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHome(t, port), port)
	collector.verifyConnPeer = func(net.Conn) bool { return false }
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("expected collection to fail for a registry port with foreign peer")
	}
	if gotAuth != "" {
		t.Fatalf("registry-discovered port got credentials without peer proof: %q", gotAuth)
	}
}

// The trust boundary is the local user account: a SAME-user unrelated
// service may receive the token (it could read the 0600 file anyway) — but
// its non-Kimi payload fails parsing, so nothing is reported.
func TestKimiCollect_SameUserUnrelatedService(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("unrelated local HTTP service"))
	}))
	defer srv.Close()
	port := serverPort(t, srv)

	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
	quota, err := collector.collect(context.Background())
	if err == nil || quota != nil {
		t.Fatalf("unrelated service produced quota %+v, err %v", quota, err)
	}
}

// Reconnection re-proves the peer: round 1 succeeds over a keep-alive
// connection; the server then dies, releases the port, and a different owner
// claims it. Round 2's request must re-dial (the pooled connection is dead)
// and the new connection's peer fails the proof — zero requests reach the
// new owner.
func TestKimiCollect_ReconnectRevalidatesPeer(t *testing.T) {
	var gotAuth string
	srv := newKimiTestServer(t, kimiLimitsJSON(), 0, &gotAuth)
	port := serverPort(t, srv)

	var peerOK atomic.Bool
	peerOK.Store(true)
	collector := newKimiTestCollector(kimiTestHomeNoRegistry(t), port)
	var proofs atomic.Int64
	collector.verifyConnPeer = func(net.Conn) bool { proofs.Add(1); return peerOK.Load() }

	// Round 1 succeeds (same-user peer).
	if _, err := collector.collect(context.Background()); err != nil {
		t.Fatalf("round 1: %v", err)
	}
	proofsAfterRound1 := proofs.Load()
	if proofsAfterRound1 == 0 {
		t.Fatal("proof never consulted in round 1")
	}

	// The original server dies; a "different owner" claims the port. Bind
	// manually: httptest cannot pick a fixed port, and a drifted bind would
	// silently invalidate the scenario (round-4 test-hygiene review).
	srv.Close()
	lnB, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("re-bind on %d: %v", port, err)
	}
	var hitsB atomic.Int64
	srvB := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hitsB.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"kind":"ok","limits":[]}}`))
	})}
	go func() { _ = srvB.Serve(lnB) }()
	defer func() { _ = srvB.Close() }()
	peerOK.Store(false)

	// Round 2: the transport must re-dial (the pooled connection is dead),
	// and the new peer is unprovable → refused before a byte is written.
	if _, err := collector.collect(context.Background()); err == nil {
		t.Fatal("round 2 succeeded against an unproven peer")
	}
	if hitsB.Load() != 0 {
		t.Fatalf("new owner received %d requests", hitsB.Load())
	}
	if proofs.Load() <= proofsAfterRound1 {
		t.Fatal("round 2 never re-proved the peer")
	}
}

// Redirects are never followed: a 307 must not bounce the bearer anywhere —
// not even to another loopback port, let alone off-box.
func TestKimiCollect_RedirectNotFollowed(t *testing.T) {
	var redirectHits atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
}

// Platforms that cannot prove the peer fail closed: no request at all.
func TestKimiCollect_UnsupportedPlatformSendsNothing(t *testing.T) {
	var hits atomic.Int64
	srv := newKimiTestServerCounted(t, kimiLimitsJSON(), 0, nil, &hits)
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

// The dialer itself: non-loopback targets refused, the round's owned set
// fast-fails, and the peer proof is consulted after connecting.
func TestKimiDialer(t *testing.T) {
	collector := newKimiTestCollector(t.TempDir(), 0)
	for _, addr := range []string{"203.0.113.10:443", "192.168.1.5:8080", "[::1]:58627"} {
		if _, err := collector.dial(context.Background(), "tcp", addr); err == nil {
			t.Fatalf("expected %s to be refused", addr)
		}
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port

	// Fast-fail: port not in the round's owned set.
	collector.roundOwned = map[int]struct{}{}
	if _, err := collector.dial(context.Background(), "tcp", ln.Addr().String()); err == nil {
		t.Fatal("dial not fast-failed for an unowned port")
	}

	// Peer proof consulted per dial: pass first, flip, refuse second.
	var peerOK atomic.Bool
	peerOK.Store(true)
	collector.roundOwned = map[int]struct{}{port: {}}
	collector.verifyConnPeer = func(net.Conn) bool { return peerOK.Load() }
	conn, err := collector.dial(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	_ = conn.Close()
	peerOK.Store(false)
	if _, err := collector.dial(context.Background(), "tcp", ln.Addr().String()); err == nil {
		t.Fatal("second dial not refused after the peer proof flipped")
	}
}

// --- Parser fixtures ---

// The owned-listen set builder: address-aware, same-uid only. Includes the
// round-3 shape (a foreign listener on the port never enters the set).
func TestOwnedLoopbackListenPorts(t *testing.T) {
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
	entry := func(hexAddr, hexPort, st string, uid int) string {
		return fmt.Sprintf("   0: %s:%s 00000000:0000 %s 00000000:00000000 00:00000000 00000000 %5d        0 12345 1 0000000000000000 100 0 0 10 0", hexAddr, hexPort, st, uid)
	}
	table := func(lines ...string) [][]byte { return [][]byte{[]byte(header + "\n" + strings.Join(lines, "\n"))} }

	const (
		v4Loopback = "0100007F"
		v4Wildcard = "00000000"
		v4Lan      = "AC150005" // 172.21.0.5
		v6Wildcard = "00000000000000000000000000000000"
		v6Loopback = "00000000000000000000000001000000" // ::1, host-order words
		v6MappedV4 = "0000000000000000FFFF00000100007F" // ::ffff:127.0.0.1, host-order words
	)

	got := ownedLoopbackListenPorts(1000, table(
		entry(v4Loopback, "E503", "0A", 1000),  // ours
		entry(v4Loopback, "E504", "0A", 65534), // foreign: excluded
		entry(v4Wildcard, "E505", "0A", 1000),  // v4 wildcard: serves loopback
		entry(v6Wildcard, "E506", "0A", 1000),  // dual-stack wildcard
		entry(v6MappedV4, "E507", "0A", 1000),  // v4-mapped loopback
		entry(v6Loopback, "E508", "0A", 1000),  // ::1-only: cannot serve v4 dial
		entry(v4Lan, "E509", "0A", 1000),       // LAN: cannot serve loopback
		entry(v4Loopback, "E50A", "08", 1000),  // non-LISTEN
	))
	want := map[int]bool{58627: true, 58628: false, 58629: true, 58630: true, 58631: true, 58632: false, 58633: false, 58634: false}
	for port, in := range want {
		_, has := got[port]
		if has != in {
			t.Fatalf("port %d in set = %v, want %v (set %v)", port, has, in, got)
		}
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
	t.Run("our re-bound LISTEN plus foreign ESTABLISHED fails", func(t *testing.T) {
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

// macOS lsof -F pun parsers: process blocks (p/u) then per-fd name lines.
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

func TestLsofOwnedListenPorts(t *testing.T) {
	out := "p100\nu501\nf3\nn127.0.0.1:58627 (LISTEN)\n" +
		"p101\nu501\nf4\nn*:59000 (LISTEN)\n" + // wildcard serves loopback
		"p102\nu501\nf5\nn[::]:59001 (LISTEN)\n" + // dual-stack
		"p103\nu501\nf6\nn[::1]:59002 (LISTEN)\n" + // ::1-only cannot serve v4
		"p104\nu65534\nf7\nn127.0.0.1:59003 (LISTEN)\n" // foreign uid
	got := lsofOwnedListenPorts(out, 501)
	for port, in := range map[int]bool{58627: true, 59000: true, 59001: true, 59002: false, 59003: false} {
		_, has := got[port]
		if has != in {
			t.Fatalf("port %d = %v, want %v (set %v)", port, has, in, got)
		}
	}
	if len(lsofOwnedListenPorts("", 501)) != 0 {
		t.Fatal("empty output produced ports")
	}
}
