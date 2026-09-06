package agent

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// antigravityQuotaFixtureNow pins "now" for reset-time expectations.
var antigravityQuotaFixtureNow = time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)

// antigravityQuotaFourBuckets is the documented response shape: two groups,
// each with a five-hour and a weekly bucket.
const antigravityQuotaFourBuckets = `{
  "response": {
    "groups": [
      {
        "displayName": "Gemini Models",
        "buckets": [
          {
            "bucketId": "gemini.weekly",
            "displayName": "Weekly limit",
            "description": "Resets Monday",
            "remaining": { "remainingFraction": 0.5, "resetTime": "2026-09-07T00:00:00Z" }
          },
          {
            "bucketId": "gemini.five_hour",
            "displayName": "Five-hour limit",
            "description": "Resets at 14:23",
            "remaining": { "remainingFraction": 0.25 }
          }
        ]
      },
      {
        "displayName": "Claude and GPT models",
        "buckets": [
          {
            "bucketId": "claude_gpt.weekly",
            "displayName": "Weekly limit",
            "remaining": { "remainingFraction": 0.75 }
          },
          {
            "bucketId": "claude_gpt.five_hour",
            "displayName": "Five-hour limit",
            "remaining": { "remainingFraction": 0.5 }
          }
        ]
      }
    ]
  }
}`

func TestAntigravityQuotaProbeSupported(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"1.0.0", true},
		{"1.1.11", true},
		{"1.99.99", true},
		{"agy 1.0.14", true},
		{"v1.0.6", true},
		{"0.9.9", false},
		{"2.0.0", false},
		{"2.1.0", false},
		{"", false},
		{"not-a-version", false},
	}
	for _, tc := range cases {
		if got := AntigravityQuotaProbeSupported(tc.version); got != tc.want {
			t.Errorf("AntigravityQuotaProbeSupported(%q) = %v, want %v", tc.version, got, tc.want)
		}
	}
}

func TestParseAntigravityQuotaSummaryFourBuckets(t *testing.T) {
	quota, err := parseAntigravityQuotaSummary([]byte(antigravityQuotaFourBuckets), antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("parseAntigravityQuotaSummary: %v", err)
	}
	if quota.Provider != "antigravity" || quota.Source != protocol.PlanQuotaSourceDaemon {
		t.Fatalf("provider/source = %q/%q, want antigravity/daemon", quota.Provider, quota.Source)
	}
	if quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("status = %q, want ok", quota.Status)
	}
	if quota.ObservedAt != antigravityQuotaFixtureNow.Unix() {
		t.Fatalf("observed_at = %d, want %d", quota.ObservedAt, antigravityQuotaFixtureNow.Unix())
	}
	if len(quota.Windows) != 4 {
		t.Fatalf("got %d windows, want 4: %+v", len(quota.Windows), quota.Windows)
	}

	weeklyReset := time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC).Unix()
	want := []protocol.RuntimePlanQuotaWindow{
		{Name: "gemini_weekly", Group: "gemini", UsedPercent: float64Pointer(50), WindowMinutes: int64Pointer(10080), ResetsAt: &weeklyReset},
		{Name: "gemini_5h", Group: "gemini", UsedPercent: float64Pointer(75), WindowMinutes: int64Pointer(300), ResetsAt: nil},
		{Name: "claude_gpt_weekly", Group: "claude_gpt", UsedPercent: float64Pointer(25), WindowMinutes: int64Pointer(10080), ResetsAt: nil},
		{Name: "claude_gpt_5h", Group: "claude_gpt", UsedPercent: float64Pointer(50), WindowMinutes: int64Pointer(300), ResetsAt: nil},
	}
	for i, w := range want {
		got := quota.Windows[i]
		if got.Name != w.Name || got.Group != w.Group {
			t.Errorf("window %d = %s/%s, want %s/%s", i, got.Group, got.Name, w.Group, w.Name)
		}
		if got.UsedPercent == nil || *got.UsedPercent != *w.UsedPercent {
			t.Errorf("window %s used_percent = %v, want %v", w.Name, got.UsedPercent, w.UsedPercent)
		}
		if w.WindowMinutes == nil || got.WindowMinutes == nil || *got.WindowMinutes != *w.WindowMinutes {
			t.Errorf("window %s window_minutes = %v, want %v", w.Name, got.WindowMinutes, w.WindowMinutes)
		}
		if w.ResetsAt == nil {
			if got.ResetsAt != nil {
				t.Errorf("window %s resets_at = %v, want nil", w.Name, got.ResetsAt)
			}
			continue
		}
		if got.ResetsAt == nil || *got.ResetsAt != *w.ResetsAt {
			t.Errorf("window %s resets_at = %v, want %v", w.Name, got.ResetsAt, w.ResetsAt)
		}
	}
}

func TestParseAntigravityQuotaSummaryLimitedWhenPoolEmpty(t *testing.T) {
	body := `{"response":{"groups":[{"displayName":"Gemini Models","buckets":[
		{"bucketId":"gemini.five_hour","remaining":{"remainingFraction":0}},
		{"bucketId":"gemini.weekly","remaining":{"remainingFraction":0.5}}]}]}}`
	quota, err := parseAntigravityQuotaSummary([]byte(body), antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("parseAntigravityQuotaSummary: %v", err)
	}
	if quota.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("status = %q, want limited when a pool reports 0 remaining", quota.Status)
	}
	if used := *quota.Windows[0].UsedPercent; used != 100 {
		t.Fatalf("exhausted bucket used_percent = %v, want 100", used)
	}
}

func TestParseAntigravityQuotaSummaryAcceptsTopLevelGroups(t *testing.T) {
	body := `{"groups":[{"displayName":"Claude and GPT models","buckets":[
		{"bucketId":"claude.weekly","remaining":{"remainingFraction":0.8}}]}]}`
	quota, err := parseAntigravityQuotaSummary([]byte(body), antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("parseAntigravityQuotaSummary: %v", err)
	}
	if len(quota.Windows) != 1 || quota.Windows[0].Group != "claude_gpt" {
		t.Fatalf("windows = %+v, want one claude_gpt window", quota.Windows)
	}
}

func TestParseAntigravityQuotaSummaryUnknownGroupKeepsSlug(t *testing.T) {
	body := `{"response":{"groups":[{"displayName":"Codex Models","buckets":[
		{"bucketId":"codex.weekly","remaining":{"remainingFraction":0.8}}]}]}}`
	quota, err := parseAntigravityQuotaSummary([]byte(body), antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("parseAntigravityQuotaSummary: %v", err)
	}
	// A third pool the parser has no translation for degrades to a stable
	// slug instead of being folded into a documented group it does not
	// belong to.
	if quota.Windows[0].Group != "codex_models" {
		t.Fatalf("group = %q, want codex_models", quota.Windows[0].Group)
	}
	if quota.Windows[0].Name != "codex_models_weekly" {
		t.Fatalf("name = %q, want codex_models_weekly", quota.Windows[0].Name)
	}
}

func TestParseAntigravityQuotaSummaryDropsUnusableBuckets(t *testing.T) {
	// Buckets without a remaining fraction (reset metadata only) and buckets
	// outside the 0..1 contract must both be dropped, never rendered.
	body := `{"response":{"groups":[
		{"displayName":"Gemini Models","buckets":[
			{"bucketId":"gemini.weekly","description":"resets soon"},
			{"bucketId":"gemini.five_hour","remaining":{"remainingFraction":1.5}},
			{"bucketId":"gemini.session","remaining":{"remainingFraction":0.3}}]}]}}`
	quota, err := parseAntigravityQuotaSummary([]byte(body), antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("parseAntigravityQuotaSummary: %v", err)
	}
	if len(quota.Windows) != 1 || quota.Windows[0].Name != "gemini_5h" {
		t.Fatalf("windows = %+v, want only the 0.3-fraction bucket", quota.Windows)
	}
}

func TestParseAntigravityQuotaSummaryDegradations(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"truncated json", `{"response":{"groups":[`},
		{"not json", `<html>gateway error</html>`},
		{"empty object", `{}`},
		{"no groups", `{"response":{"groups":[]}}`},
		{"groups without buckets", `{"response":{"groups":[{"displayName":"Gemini Models"}]}}`},
		{"buckets without fractions", `{"response":{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini.weekly"}]}]}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if quota, err := parseAntigravityQuotaSummary([]byte(tc.body), antigravityQuotaFixtureNow); err == nil {
				t.Fatalf("expected error, got %+v", quota)
			}
		})
	}
}

func TestParseAntigravityQuotaSummaryResetShapes(t *testing.T) {
	epoch := antigravityQuotaFixtureNow.Add(24 * time.Hour).Unix()
	body := `{"response":{"groups":[{"displayName":"Gemini Models","buckets":[
		{"bucketId":"a","remaining":{"resetTime":"` + strconv.FormatInt(epoch, 10) + `"},"remainingFraction":0.5},
		{"bucketId":"b","remaining":{"remainingFraction":0.5},"description":"usage resets 2026-09-08T14:23:01Z soon"},
		{"bucketId":"c","remaining":{"remainingFraction":0.5},"description":"no time here"},
		{"bucketId":"d","remaining":{"remainingFraction":0.5},"description":"bare number 1788316800 maybe"}]}]}}`
	quota, err := parseAntigravityQuotaSummary([]byte(body), antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("parseAntigravityQuotaSummary: %v", err)
	}
	if got := quota.Windows[0].ResetsAt; got == nil || *got != epoch {
		t.Errorf("epoch resetTime = %v, want %d", got, epoch)
	}
	if got := quota.Windows[1].ResetsAt; got == nil || *got != time.Date(2026, 9, 8, 14, 23, 1, 0, time.UTC).Unix() {
		t.Errorf("prose ISO reset = %v", got)
	}
	if got := quota.Windows[2].ResetsAt; got != nil {
		t.Errorf("prose without a timestamp produced %v, want nil", got)
	}
	if got := quota.Windows[3].ResetsAt; got != nil {
		t.Errorf("bare number inside prose produced %v, want nil (not a documented shape)", got)
	}
}

func TestParseAntigravityQuotaSummaryNeverCarriesIdentity(t *testing.T) {
	// The backend is also documented to return account email, plan name and
	// credits. None of that may survive into the snapshot — the wire shape
	// has nowhere to put it, and the parser must not grow one.
	body := `{
		"accountEmail": "person@example.com",
		"planName": "Ultra",
		"monthlyPromptCredits": 12000,
		"response": {"groups": [{"displayName": "Gemini Models", "buckets": [
			{"bucketId": "gemini.weekly", "remaining": {"remainingFraction": 0.5}}]}]}
	}`
	quota, err := parseAntigravityQuotaSummary([]byte(body), antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("parseAntigravityQuotaSummary: %v", err)
	}
	wire, err := json.Marshal(quota)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, forbidden := range []string{"example.com", "ultra", "12000", "account", "plan", "credit"} {
		if strings.Contains(strings.ToLower(string(wire)), forbidden) {
			t.Errorf("snapshot wire shape leaked %q: %s", forbidden, wire)
		}
	}
}

// newQuotaProbeServer starts a self-signed TLS listener on loopback serving a
// canned answer with its status code, the same presentation agy's language
// server uses. Recorded requests are appended to the returned slices.
func newQuotaProbeServer(t *testing.T, status int, body string) (*httptest.Server, *[]http.Header, *[]string) {
	t.Helper()
	headers := &[]http.Header{}
	bodies := &[]string{}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		*headers = append(*headers, r.Header.Clone())
		*bodies = append(*bodies, string(raw))
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, headers, bodies
}

// stubDiscovery pins the probe's process/port discovery to the given values
// and counts process-scan invocations.
func stubDiscovery(t *testing.T, pids []int, ports func(pid int) []int) *int {
	t.Helper()
	origProcesses := antigravityQuotaProcesses
	origPorts := antigravityQuotaListeningPorts
	scans := 0
	antigravityQuotaProcesses = func(execPath string) []int {
		scans++
		return pids
	}
	antigravityQuotaListeningPorts = ports
	t.Cleanup(func() {
		antigravityQuotaProcesses = origProcesses
		antigravityQuotaListeningPorts = origPorts
	})
	return &scans
}

func TestProbeAntigravityQuotaEndToEnd(t *testing.T) {
	srv, headers, bodies := newQuotaProbeServer(t, http.StatusOK, antigravityQuotaFourBuckets)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	stubDiscovery(t, []int{4242}, func(int) []int { return []int{port} })

	quota, err := ProbeAntigravityQuota(context.Background(), "/usr/local/bin/agy", "1.1.11", antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("ProbeAntigravityQuota: %v", err)
	}
	if len(quota.Windows) != 4 {
		t.Fatalf("windows = %d, want 4", len(quota.Windows))
	}

	if len(*headers) != 1 {
		t.Fatalf("made %d RPC calls, want 1", len(*headers))
	}
	h := (*headers)[0]
	if got := h.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := h.Get("Connect-Protocol-Version"); got != "1" {
		t.Errorf("Connect-Protocol-Version = %q", got)
	}
	// The CSRF header is SENT (empty): both documented server behaviors —
	// "requires none" and "takes an empty token" — are satisfied, and the
	// daemon reads no token material to fill it.
	if values, ok := h["X-Codeium-Csrf-Token"]; !ok || len(values) != 1 || values[0] != "" {
		t.Errorf("X-Codeium-Csrf-Token = %v (present=%v), want one empty value", values, ok)
	}
	if len(*bodies) == 1 {
		var payload map[string]any
		if err := json.Unmarshal([]byte((*bodies)[0]), &payload); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		if _, ok := payload["metadata"]; !ok {
			t.Errorf("request body missing metadata object: %s", (*bodies)[0])
		}
	}
}

func TestProbeAntigravityQuotaVersionGate(t *testing.T) {
	scans := stubDiscovery(t, []int{1}, func(int) []int { return nil })
	if _, err := ProbeAntigravityQuota(context.Background(), "agy", "2.0.0", antigravityQuotaFixtureNow); err == nil {
		t.Fatal("expected error for an out-of-range agy version")
	}
	if *scans != 0 {
		t.Fatalf("out-of-range version still scanned processes %d time(s); the gate must precede discovery", *scans)
	}
}

func TestProbeAntigravityQuotaNoRunningAgy(t *testing.T) {
	stubDiscovery(t, nil, func(int) []int { return nil })
	if _, err := ProbeAntigravityQuota(context.Background(), "agy", "1.1.11", antigravityQuotaFixtureNow); err == nil {
		t.Fatal("expected error when agy is not running")
	}
}

func TestProbeAntigravityQuotaListenerRejects(t *testing.T) {
	// A live listener that refuses the call (wrong process, CSRF
	// enforcement, protocol drift) degrades to "not reported".
	srv, _, _ := newQuotaProbeServer(t, http.StatusForbidden, `{"error":"csrf"}`)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	stubDiscovery(t, []int{7}, func(int) []int { return []int{port} })

	if _, err := ProbeAntigravityQuota(context.Background(), "agy", "1.1.11", antigravityQuotaFixtureNow); err == nil {
		t.Fatal("expected error when the listener rejects the probe")
	}
}

func TestProbeAntigravityQuotaGarbageAnswer(t *testing.T) {
	srv, _, _ := newQuotaProbeServer(t, http.StatusOK, `<html>not the protocol</html>`)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	stubDiscovery(t, []int{7}, func(int) []int { return []int{port} })

	if _, err := ProbeAntigravityQuota(context.Background(), "agy", "1.1.11", antigravityQuotaFixtureNow); err == nil {
		t.Fatal("expected error when the listener does not speak the quota protocol")
	}
}

func TestProbeAntigravityQuotaCancelledContext(t *testing.T) {
	// The time-boxed contract: an unresponsive listener must not hold the
	// caller. A cancelled context surfaces as a plain probe failure.
	srv, _, _ := newQuotaProbeServer(t, http.StatusOK, antigravityQuotaFourBuckets)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	stubDiscovery(t, []int{7}, func(int) []int { return []int{port} })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ProbeAntigravityQuota(ctx, "agy", "1.1.11", antigravityQuotaFixtureNow); err == nil {
		t.Fatal("expected error from a cancelled probe context")
	}
}

func TestProbeAntigravityQuotaSecondPortAnswers(t *testing.T) {
	// agy binds several loopback ports; the round must walk candidates until
	// one speaks the protocol.
	dead, _, _ := newQuotaProbeServer(t, http.StatusNotFound, "")
	live, _, _ := newQuotaProbeServer(t, http.StatusOK, antigravityQuotaFourBuckets)
	deadPort := dead.Listener.Addr().(*net.TCPAddr).Port
	livePort := live.Listener.Addr().(*net.TCPAddr).Port
	stubDiscovery(t, []int{9}, func(int) []int { return []int{deadPort, livePort} })

	quota, err := ProbeAntigravityQuota(context.Background(), "agy", "1.1.11", antigravityQuotaFixtureNow)
	if err != nil {
		t.Fatalf("ProbeAntigravityQuota: %v", err)
	}
	if len(quota.Windows) != 4 {
		t.Fatalf("windows = %d, want 4", len(quota.Windows))
	}
}

func TestAntigravityExecutableMatches(t *testing.T) {
	cases := []struct {
		name   string
		tokens []string
		want   bool
	}{
		{"absolute path", []string{"/usr/local/bin/agy", "-i"}, true},
		{"bare name from PATH shell", []string{"agy", "-i"}, true},
		{"relative path", []string{"./bin/agy"}, true},
		{"different binary with shared prefix", []string{"/usr/local/bin/agy-old"}, false},
		{"flag value mentioning agy", []string{"tail", "-f", "agy.log"}, false},
		{"wrapper with agy subcommand only", []string{"ccms", "agy"}, false},
		{"empty argv", []string{""}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := antigravityExecutableMatches(tc.tokens, "/usr/local/bin/agy", "agy"); got != tc.want {
				t.Errorf("match = %v, want %v", got, tc.want)
			}
		})
	}
}
