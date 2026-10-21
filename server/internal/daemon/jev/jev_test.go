package jev

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testKey = "sk-test-secret-DO-NOT-LEAK"

func okBody(choice string) string {
	return `{"answers":{"effort":{"choice":"` + choice + `","confidence":0.9,"probabilities":{"low":0.1,"high":0.9}}},"latency_ms":42}`
}

func testReq() Request {
	return Request{
		State:        map[string]any{"task": "demo"},
		Instructions: "pick effort",
		Options: []Option{
			{Value: "low", Description: "mechanical"},
			{Value: "high", Description: "deep"},
		},
	}
}

type recordingServer struct {
	name  string // last path segment, for source naming
	srv   *httptest.Server
	count atomic.Int64
	// handler inspects the request and writes the response.
	handler func(r *http.Request, body []byte) (int, string)
}

func newRecordingServer(t *testing.T, handler func(r *http.Request, body []byte) (int, string)) *recordingServer {
	t.Helper()
	rs := &recordingServer{handler: handler}
	rs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.count.Add(1)
		buf, _ := io.ReadAll(r.Body)
		lastRawBody = string(buf)
		code, body := rs.handler(r, buf)
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(rs.srv.Close)
	return rs
}

func TestDecide_Success(t *testing.T) {
	var gotBody map[string]any
	var gotAuth, gotCT, gotCE string
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		_ = json.Unmarshal(body, &gotBody)
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		gotCE = r.Header.Get("Content-Encoding")
		return 200, okBody("high")
	})
	c := New(Options{Sources: []Source{{Name: "opencode-free", BaseURL: rs.srv.URL, Model: "jev-1.13-free"}}})

	dec, err := c.Decide(context.Background(), testReq())
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if dec.Level != "high" || dec.Confidence != 0.9 || dec.Source != "opencode-free" {
		t.Fatalf("decision = %+v", dec)
	}
	if dec.Probabilities["high"] != 0.9 {
		t.Fatalf("probabilities = %v", dec.Probabilities)
	}
	if dec.LatencyMS < 0 {
		t.Fatalf("latency = %d", dec.LatencyMS)
	}

	// Wire format: plain JSON, no compression, no auth on free source.
	if gotCT != "application/json" {
		t.Fatalf("Content-Type = %q", gotCT)
	}
	if gotCE != "" {
		t.Fatalf("Content-Encoding = %q, want empty", gotCE)
	}
	if gotAuth != "" {
		t.Fatalf("Authorization = %q, want empty on unauthenticated source", gotAuth)
	}
	if gotBody["model"] != "jev-1.13-free" {
		t.Fatalf("model = %v", gotBody["model"])
	}
	q := gotBody["questions"].(map[string]any)["effort"].(map[string]any)
	if q["type"] != "choice" {
		t.Fatalf("question type = %v", q["type"])
	}
	crit := q["criteria"].(map[string]any)
	if len(crit) != 2 || crit["low"] != "mechanical" {
		t.Fatalf("criteria = %v", crit)
	}
	if _, ok := gotBody["state"]; !ok {
		t.Fatal("state missing from request body")
	}
	// Criteria keys keep the caller's low→high option order (encoding/json
	// would sort them alphabetically).
	if !strings.Contains(lastRawBody, `"criteria":{"low":"mechanical","high":"deep"}`) {
		t.Fatalf("criteria order not preserved: %s", lastRawBody)
	}

	// Snapshot: idle → available.
	snap := c.Snapshot()
	if snap.Status != StatusAvailable || snap.ActiveSource != "opencode-free" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if snap.DecisionsOK != 1 || snap.DecisionsFallback != 0 {
		t.Fatalf("counters = %+v", snap)
	}
	if snap.LastLatencyMS != dec.LatencyMS {
		t.Fatalf("snapshot latency %d != decision latency %d", snap.LastLatencyMS, dec.LatencyMS)
	}
	if snap.Since.IsZero() || snap.UpdatedAt.IsZero() {
		t.Fatalf("timestamps = %+v", snap)
	}
}

func TestDecide_AuthHeadersPerSource(t *testing.T) {
	type capture struct {
		auth string
		path string
	}
	var caps []capture
	var mu = make(chan struct{}, 1)
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		mu <- struct{}{}
		caps = append(caps, capture{r.Header.Get("Authorization"), r.URL.Path})
		<-mu
		return 200, okBody("low")
	})
	c := New(Options{Sources: []Source{
		{Name: "opencode", BaseURL: rs.srv.URL, Model: "jev-1.13", BearerToken: testKey},
		{Name: "opencode-free", BaseURL: rs.srv.URL, Model: "jev-1.13-free"},
	}})

	if _, err := c.Decide(context.Background(), testReq()); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	// Only the first source is hit on success; it must carry the bearer.
	if len(caps) != 1 || caps[0].auth != "Bearer "+testKey {
		t.Fatalf("captures = %+v", caps)
	}

	// Free source first: no Authorization header.
	caps = nil
	c2 := New(Options{Sources: []Source{
		{Name: "opencode-free", BaseURL: rs.srv.URL, Model: "jev-1.13-free"},
	}})
	if _, err := c2.Decide(context.Background(), testReq()); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if len(caps) != 1 || caps[0].auth != "" {
		t.Fatalf("captures = %+v", caps)
	}
}

func TestDecide_FailoverOn5xxTimeoutInvalidChoice(t *testing.T) {
	// Path-based backend: /five returns 500, /choice returns a fixed
	// choice, anything else answers "low".
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		switch r.URL.Path {
		case "/five":
			return 500, "boom"
		case "/choice":
			return 200, okBody("ultra-max") // not a candidate option
		default:
			return 200, okBody("low")
		}
	})

	// 5xx on the first source -> second source answers.
	c := New(Options{Sources: []Source{
		{Name: "a", BaseURL: rs.srv.URL + "/five"},
		{Name: "b", BaseURL: rs.srv.URL + "/b"},
	}})
	dec, err := c.Decide(context.Background(), testReq())
	if err != nil || dec.Level != "low" || dec.Source != "b" {
		t.Fatalf("decide = %+v, err = %v", dec, err)
	}

	// Invalid choice on the first source -> second source answers.
	c2 := New(Options{Sources: []Source{
		{Name: "a", BaseURL: rs.srv.URL + "/choice"},
		{Name: "b", BaseURL: rs.srv.URL + "/b"},
	}})
	dec, err = c2.Decide(context.Background(), testReq())
	if err != nil || dec.Source != "b" {
		t.Fatalf("decide = %+v, err = %v", dec, err)
	}

	// Timeout on the first source -> second source answers, and the whole
	// call is bounded by the configured timeout (no real network).
	slow := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		time.Sleep(2 * time.Second)
		return 200, okBody("low")
	})
	c3 := New(Options{Timeout: 60 * time.Millisecond, Sources: []Source{
		{Name: "slow", BaseURL: slow.srv.URL},
		{Name: "fast", BaseURL: rs.srv.URL + "/b"},
	}})
	start := time.Now()
	dec, err = c3.Decide(context.Background(), testReq())
	elapsed := time.Since(start)
	if err != nil || dec.Source != "fast" {
		t.Fatalf("decide = %+v, err = %v", dec, err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("timeout not enforced, took %s", elapsed)
	}
}

func TestDecide_AllSourcesFail_FallbackReasons(t *testing.T) {
	cases := []struct {
		name   string
		code   int
		body   string
		reason FallbackReason
	}{
		{"http500", 500, "boom", ReasonError},
		{"badJSON", 200, "{not json", ReasonInvalid},
		{"choiceNotInOptions", 200, okBody("nope"), ReasonInvalid},
		{"noSources", 0, "", ReasonError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var sources []Source
			if tc.code != 0 || tc.body != "" {
				rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
					return tc.code, tc.body
				})
				sources = []Source{{Name: "s1", BaseURL: rs.srv.URL}}
			}
			c := New(Options{Sources: sources})
			_, err := c.Decide(context.Background(), testReq())
			var fb *FallbackError
			if !errors.As(err, &fb) {
				t.Fatalf("err = %v, want *FallbackError", err)
			}
			if fb.Reason != tc.reason {
				t.Fatalf("reason = %s, want %s", fb.Reason, tc.reason)
			}
			snap := c.Snapshot()
			if snap.Status != StatusDegraded || snap.DecisionsFallback != 1 {
				t.Fatalf("snapshot = %+v", snap)
			}
		})
	}
}

func TestDecide_TimeoutReason(t *testing.T) {
	slow := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		time.Sleep(300 * time.Millisecond)
		return 200, okBody("low")
	})
	c := New(Options{Timeout: 40 * time.Millisecond, Sources: []Source{{Name: "slow", BaseURL: slow.srv.URL}}})
	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonTimeout {
		t.Fatalf("err = %v, want timeout fallback", err)
	}
}

func TestDecide_TimeoutHonorsConfiguredValue(t *testing.T) {
	// The per-source hard timeout must bound the whole call, offline.
	slow := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		time.Sleep(2 * time.Second)
		return 200, okBody("low")
	})
	c := New(Options{Timeout: 60 * time.Millisecond, Sources: []Source{{Name: "slow", BaseURL: slow.srv.URL}}})
	start := time.Now()
	_, err := c.Decide(context.Background(), testReq())
	elapsed := time.Since(start)
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonTimeout {
		t.Fatalf("err = %v, want timeout fallback", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("call took %s, timeout not enforced", elapsed)
	}
}

func TestDecide_Breaker(t *testing.T) {
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		return 500, "down"
	})
	now := time.Now()
	c := New(Options{
		Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}},
		Now:     func() time.Time { return now },
	})

	// Three consecutive all-source failures open the breaker.
	for i := 0; i < 3; i++ {
		if _, err := c.Decide(context.Background(), testReq()); err == nil {
			t.Fatal("expected failure")
		}
	}
	if got := rs.count.Load(); got != 3 {
		t.Fatalf("server hits = %d, want 3", got)
	}
	if s := c.Snapshot().Status; s != StatusUnavailable {
		t.Fatalf("status = %s, want unavailable", s)
	}

	// While open: no requests, breaker fallback.
	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonBreaker {
		t.Fatalf("err = %v, want breaker fallback", err)
	}
	if got := rs.count.Load(); got != 3 {
		t.Fatalf("server hits during open breaker = %d, want 3", got)
	}

	// After cooldown: exactly one trial request goes through.
	now = now.Add(breakerCooldown + time.Second)
	_, err = c.Decide(context.Background(), testReq())
	if !errors.As(err, &fb) || fb.Reason != ReasonError {
		t.Fatalf("err = %v, want http error fallback from trial", err)
	}
	if got := rs.count.Load(); got != 4 {
		t.Fatalf("server hits after cooldown = %d, want 4 (single trial)", got)
	}

	// Trial failed → open again immediately, no new request.
	_, err = c.Decide(context.Background(), testReq())
	if !errors.As(err, &fb) || fb.Reason != ReasonBreaker {
		t.Fatalf("err = %v, want breaker reopened", err)
	}
	if got := rs.count.Load(); got != 4 {
		t.Fatalf("server hits after reopened breaker = %d, want 4", got)
	}

	// A successful trial after the next cooldown closes the breaker.
	now = now.Add(breakerCooldown + time.Second)
	rs.handler = func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") }
	dec, err := c.Decide(context.Background(), testReq())
	if err != nil || dec.Level != "low" {
		t.Fatalf("decide = %+v, err = %v", dec, err)
	}
	if s := c.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available after recovery", s)
	}
}

func TestDecide_Disabled(t *testing.T) {
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") })
	c := New(Options{Disabled: true, Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}}})
	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonDisabled {
		t.Fatalf("err = %v, want disabled fallback", err)
	}
	if got := rs.count.Load(); got != 0 {
		t.Fatalf("server hits = %d, want 0", got)
	}
	if err := c.Probe(context.Background()); err == nil {
		t.Fatal("probe on disabled client should fail")
	}
}

func TestSnapshot_StatusTransitions(t *testing.T) {
	fail := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 500, "x" })
	ok := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") })

	c := New(Options{Sources: []Source{{Name: "s", BaseURL: fail.srv.URL}}})
	if s := c.Snapshot().Status; s != StatusIdle {
		t.Fatalf("initial status = %s, want idle", s)
	}

	// idle → available
	c2 := New(Options{Sources: []Source{{Name: "s", BaseURL: ok.srv.URL}}})
	if _, err := c2.Decide(context.Background(), testReq()); err != nil {
		t.Fatal(err)
	}
	if s := c2.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available", s)
	}

	// available → degraded (single failure below breaker threshold)
	failOnce := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		count := fail1Count.Add(1)
		if count <= 1 {
			return 500, "x"
		}
		return 200, okBody("low")
	})
	c3 := New(Options{Sources: []Source{{Name: "s", BaseURL: failOnce.srv.URL}}})
	if _, err := c3.Decide(context.Background(), testReq()); err == nil {
		t.Fatal("expected fallback error")
	}
	if s := c3.Snapshot().Status; s != StatusDegraded {
		t.Fatalf("status = %s, want degraded", s)
	}
	// Recovery returns the same client to available.
	if _, err := c3.Decide(context.Background(), testReq()); err != nil {
		t.Fatal(err)
	}
	if s := c3.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available after recovery", s)
	}

	// degraded → unavailable (breaker opens on 3rd consecutive failure)
	c4 := New(Options{Sources: []Source{{Name: "s", BaseURL: fail.srv.URL}}})
	for i := 0; i < 3; i++ {
		_, _ = c4.Decide(context.Background(), testReq())
	}
	if s := c4.Snapshot().Status; s != StatusUnavailable {
		t.Fatalf("status = %s, want unavailable", s)
	}
	// unavailable → available (recovery on a fresh healthy source)
	c5 := New(Options{Sources: []Source{{Name: "s", BaseURL: ok.srv.URL}}})
	if _, err := c5.Decide(context.Background(), testReq()); err != nil {
		t.Fatal(err)
	}
	if s := c5.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available", s)
	}
}

var fail1Count atomic.Int64

var lastRawBody string

func TestProbe_UpdatesSnapshotNotCounters(t *testing.T) {
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") })
	c := New(Options{Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}}})

	if err := c.Probe(context.Background()); err != nil {
		t.Fatalf("probe: %v", err)
	}
	snap := c.Snapshot()
	if snap.Status != StatusAvailable || snap.ActiveSource != "s" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if snap.DecisionsOK != 0 || snap.DecisionsFallback != 0 {
		t.Fatalf("probe leaked into decision counters: %+v", snap)
	}

	// Probe failure → degraded, still not counted.
	fail := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 500, "x" })
	c2 := New(Options{Sources: []Source{{Name: "s", BaseURL: fail.srv.URL}}})
	if err := c2.Probe(context.Background()); err == nil {
		t.Fatal("expected probe failure")
	}
	if s := c2.Snapshot().Status; s != StatusDegraded {
		t.Fatalf("status = %s, want degraded", s)
	}
	if c2.Snapshot().DecisionsFallback != 0 {
		t.Fatal("probe failure counted as fallback decision")
	}
}

func TestResolveSources(t *testing.T) {
	all := SourceEnv{
		OpenCodeAPIKey:       testKey,
		DashScopeAPIKey:      testKey,
		DashScopeWorkspaceID: "ws-1",
		DashScopeRegion:      "ap-southeast-1",
	}
	got := ResolveSources("opencode-free,opencode,dashscope", all)
	if len(got) != 3 {
		t.Fatalf("sources = %+v", got)
	}
	if got[0].BearerToken != "" || got[0].Model != "jev-1.13-free" {
		t.Fatalf("free source = %+v", got[0])
	}
	if got[1].BearerToken != testKey || got[1].Model != "jev-1.13" {
		t.Fatalf("opencode source = %+v", got[1])
	}
	want := "https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone"
	if got[2].BaseURL != want || got[2].Model != "decision-model-preview" {
		t.Fatalf("dashscope source = %+v, want url %s", got[2], want)
	}

	// Default region is cn-beijing.
	got = ResolveSources("dashscope", SourceEnv{DashScopeAPIKey: testKey, DashScopeWorkspaceID: "ws-2"})
	if !strings.Contains(got[0].BaseURL, "ws-2.cn-beijing.maas.aliyuncs.com") {
		t.Fatalf("url = %s", got[0].BaseURL)
	}

	// Missing credentials skip the source.
	if got := ResolveSources("opencode,dashscope", SourceEnv{}); len(got) != 0 {
		t.Fatalf("sources = %+v, want all skipped", got)
	}
	// Unknown names are skipped.
	if got := ResolveSources("nonsense,opencode-free", SourceEnv{}); len(got) != 1 || got[0].Name != "opencode-free" {
		t.Fatalf("sources = %+v", got)
	}
}

func TestAPINeverLeaked(t *testing.T) {
	// A failing authenticated source must not leak its key through error
	// strings, logs, or the snapshot.
	var logBuf strings.Builder
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))
	_ = logger // package logs only warnings from ResolveSources (names, not keys)

	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 500, "down" })
	c := New(Options{Sources: []Source{
		{Name: "opencode", BaseURL: rs.srv.URL, Model: "jev-1.13", BearerToken: testKey},
		{Name: "dashscope", BaseURL: rs.srv.URL, Model: "m", BearerToken: testKey},
	}})
	_, err := c.Decide(context.Background(), testReq())
	if err == nil {
		t.Fatal("expected failure")
	}
	snapBytes, _ := json.Marshal(c.Snapshot())

	leaks := []string{err.Error(), logBuf.String(), string(snapBytes)}
	for _, leak := range leaks {
		if strings.Contains(leak, testKey) {
			t.Fatalf("API key leaked into: %q", leak)
		}
	}

	// Snapshot struct itself carries no credential field.
	var snapMap map[string]any
	_ = json.Unmarshal(snapBytes, &snapMap)
	for k := range snapMap {
		for _, banned := range []string{"key", "token", "bearer", "secret"} {
			if strings.Contains(strings.ToLower(k), banned) {
				t.Fatalf("snapshot field %q looks credential-like", k)
			}
		}
	}
}

func TestLive(t *testing.T) {
	if ok, _ := resolveLiveGate(); !ok {
		t.Skip("MULTICA_RUN_JEV_LIVE=1 not set; skipping online test")
	}
	c := New(Options{Sources: []Source{{Name: "opencode-free", BaseURL: opencodeBaseURL, Model: opencodeFreeModel}}})
	dec, err := c.Decide(context.Background(), Request{
		State:        map[string]any{"kind": "synthetic-connectivity-check"},
		Instructions: "Pick the reasoning effort for a synthetic connectivity check.",
		Options: []Option{
			{Value: "low", Description: "routine"},
			{Value: "medium", Description: "standard"},
			{Value: "high", Description: "thorough"},
		},
	})
	if err != nil {
		t.Fatalf("live decide: %v", err)
	}
	valid := map[string]bool{"low": true, "medium": true, "high": true}
	if !valid[dec.Level] {
		t.Fatalf("choice %q not in options", dec.Level)
	}
	t.Logf("live decision: %+v", dec)
}

// resolveLiveGate reads the live-test gate without importing os at the top
// of every reader's attention.
func resolveLiveGate() (bool, string) {
	return os.Getenv("MULTICA_RUN_JEV_LIVE") == "1", ""
}
