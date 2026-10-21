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
	"sync"
	"testing"
	"time"
)

const testKey = "sk-test-secret-DO-NOT-LEAK"
const dashscopeTestKey = "sk-test-dashscope-DO-NOT-LEAK"

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
	srv     *httptest.Server
	count   int
	lastRaw string

	mu      sync.Mutex
	handler func(r *http.Request, body []byte) (int, string)
}

func newRecordingServer(t *testing.T, handler func(r *http.Request, body []byte) (int, string)) *recordingServer {
	t.Helper()
	rs := &recordingServer{handler: handler}
	rs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(r.Body)
		// Run the handler OUTSIDE rs.mu: tests use blocking handlers
		// (gates) that must not hold the recording lock.
		rs.mu.Lock()
		rs.count++
		rs.lastRaw = string(buf)
		h := rs.handler
		rs.mu.Unlock()
		code, body := h(r, buf)
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(rs.srv.Close)
	return rs
}

func (rs *recordingServer) hits() int {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.count
}

func (rs *recordingServer) lastBody() string {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.lastRaw
}

func (rs *recordingServer) setHandler(h func(r *http.Request, body []byte) (int, string)) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.handler = h
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
	if !strings.Contains(rs.lastBody(), `"criteria":{"low":"mechanical","high":"deep"}`) {
		t.Fatalf("criteria order not preserved: %s", rs.lastBody())
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
	var mu sync.Mutex
	var auths []string
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		auths = append(auths, r.Header.Get("Authorization"))
		return 200, okBody("low")
	})

	// Authenticated opencode first: bearer key, only one hit on success.
	auths = nil
	c := New(Options{Sources: []Source{
		{Name: "opencode", BaseURL: rs.srv.URL, Model: "jev-1.13", BearerToken: testKey},
		{Name: "opencode-free", BaseURL: rs.srv.URL, Model: "jev-1.13-free"},
	}})
	if _, err := c.Decide(context.Background(), testReq()); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if len(auths) != 1 || auths[0] != "Bearer "+testKey {
		t.Fatalf("opencode captures = %v", auths)
	}

	// Dashscope source: its own bearer key on the wire.
	auths = nil
	c2 := New(Options{Sources: []Source{
		{Name: "dashscope", BaseURL: rs.srv.URL, Model: "decision-model-preview", BearerToken: dashscopeTestKey},
	}})
	if _, err := c2.Decide(context.Background(), testReq()); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if len(auths) != 1 || auths[0] != "Bearer "+dashscopeTestKey {
		t.Fatalf("dashscope captures = %v", auths)
	}

	// Free source first: no Authorization header at all.
	auths = nil
	c3 := New(Options{Sources: []Source{
		{Name: "opencode-free", BaseURL: rs.srv.URL, Model: "jev-1.13-free"},
	}})
	if _, err := c3.Decide(context.Background(), testReq()); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if len(auths) != 1 || auths[0] != "" {
		t.Fatalf("free captures = %v", auths)
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
		{"trailingGarbage", 200, okBody("low") + " THIS IS NOT JSON", ReasonInvalid},
		{"secondJSONValue", 200, okBody("low") + `{"answers":null}`, ReasonInvalid},
		{"oversized", 200, strings.Repeat(" ", maxResponseBytes+2) + okBody("low"), ReasonInvalid},
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

func TestDecide_ResponseBodyTimeoutIsTimeout(t *testing.T) {
	// 200 + partial JSON, then the server stalls until the request context
	// dies: the body-read deadline must classify as timeout, not invalid.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"answers":`)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	c := New(Options{Timeout: 40 * time.Millisecond, Sources: []Source{{Name: "slow-body", BaseURL: srv.URL}}})
	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonTimeout {
		t.Fatalf("err = %v, want timeout fallback", err)
	}
}

func TestDecide_LatencyIncludesFailoverAttempts(t *testing.T) {
	// Injected clock: the primary burns 120ms failing, the secondary takes
	// 30ms succeeding — the reported latency must be the whole 150ms.
	var elapsed int64
	var mu sync.Mutex
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/primary" {
			elapsed += 120
			return 500, "boom"
		}
		elapsed += 30
		return 200, okBody("low")
	})
	c := New(Options{
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return time.UnixMilli(elapsed)
		},
		Sources: []Source{
			{Name: "primary", BaseURL: rs.srv.URL + "/primary"},
			{Name: "secondary", BaseURL: rs.srv.URL + "/secondary"},
		},
	})
	dec, err := c.Decide(context.Background(), testReq())
	if err != nil {
		t.Fatal(err)
	}
	if dec.LatencyMS != 150 {
		t.Fatalf("latency = %dms, want 150ms including the failed primary attempt", dec.LatencyMS)
	}
	if c.Snapshot().LastLatencyMS != 150 {
		t.Fatalf("snapshot latency = %dms, want 150ms", c.Snapshot().LastLatencyMS)
	}
}

func TestDecide_Breaker(t *testing.T) {
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		return 500, "down"
	})
	now := time.Now()
	var mu sync.Mutex
	c := New(Options{
		Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}},
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return now
		},
	})

	// Three consecutive all-source failures open the breaker.
	for i := 0; i < 3; i++ {
		if _, err := c.Decide(context.Background(), testReq()); err == nil {
			t.Fatal("expected failure")
		}
	}
	if got := rs.hits(); got != 3 {
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
	if got := rs.hits(); got != 3 {
		t.Fatalf("server hits during open breaker = %d, want 3", got)
	}

	// After cooldown: exactly one trial request goes through.
	mu.Lock()
	now = now.Add(breakerCooldown + time.Second)
	mu.Unlock()
	_, err = c.Decide(context.Background(), testReq())
	if !errors.As(err, &fb) || fb.Reason != ReasonError {
		t.Fatalf("err = %v, want http error fallback from trial", err)
	}
	if got := rs.hits(); got != 4 {
		t.Fatalf("server hits after cooldown = %d, want 4 (single trial)", got)
	}

	// Trial failed → open again immediately, no new request.
	_, err = c.Decide(context.Background(), testReq())
	if !errors.As(err, &fb) || fb.Reason != ReasonBreaker {
		t.Fatalf("err = %v, want breaker reopened", err)
	}
	if got := rs.hits(); got != 4 {
		t.Fatalf("server hits after reopened breaker = %d, want 4", got)
	}

	// A successful trial after the next cooldown closes the breaker.
	mu.Lock()
	now = now.Add(breakerCooldown + time.Second)
	mu.Unlock()
	rs.setHandler(func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") })
	dec, err := c.Decide(context.Background(), testReq())
	if err != nil || dec.Level != "low" {
		t.Fatalf("decide = %+v, err = %v", dec, err)
	}
	if s := c.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available after recovery", s)
	}
}

func TestDecide_HalfOpenAllowsSingleTrial(t *testing.T) {
	// While the half-open trial is still in flight, a second concurrent
	// Decide must get the breaker fallback without touching the source.
	trialStarted := make(chan struct{})
	releaseTrial := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseTrial) }) }
	// Always release the in-flight handler, even when an assertion fails
	// mid-test, so httptest.Server.Close does not block for 10 minutes.
	t.Cleanup(release)
	var once sync.Once
	var hits int // counts requests inside this handler (test-local)
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		hits++
		if hits == 4 { // the half-open trial: hold it in flight
			once.Do(func() { close(trialStarted) })
			select {
			case <-releaseTrial:
			case <-r.Context().Done(): // request abandoned; don't stall Close
			}
		}
		return 500, "down"
	})
	now := time.Now()
	var mu sync.Mutex
	c := New(Options{
		Timeout: 500 * time.Millisecond,
		Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}},
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return now
		},
	})

	for i := 0; i < 3; i++ {
		_, _ = c.Decide(context.Background(), testReq())
	}
	mu.Lock()
	now = now.Add(breakerCooldown + time.Second)
	mu.Unlock()

	first := make(chan error, 1)
	go func() {
		_, err := c.Decide(context.Background(), testReq())
		first <- err
	}()
	<-trialStarted

	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonBreaker {
		t.Fatalf("second call during half-open trial: %v, want breaker fallback", err)
	}
	if got := rs.hits(); got != 4 {
		t.Fatalf("server hits = %d, want 4 (trial only)", got)
	}

	release()
	if err := <-first; err == nil {
		t.Fatal("trial should have failed")
	}
}

func TestDecide_CancelledHalfOpenTrialReturnsSlot(t *testing.T) {
	// #15: if the call holding the half-open trial is cancelled mid-request,
	// the slot must go back so the next call retries the trial instead of
	// the breaker being stranded in half-open forever.
	healthy := false
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		if healthy {
			return 200, okBody("low")
		}
		return 500, "x"
	})
	now := time.Now()
	var mu sync.Mutex
	c := New(Options{
		Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}},
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return now
		},
	})
	for i := 0; i < 3; i++ {
		_, _ = c.Decide(context.Background(), testReq())
	}
	hitsAfterOpen := rs.hits()

	// Cooldown expires; the trial goes to a caller whose ctx is cancelled.
	mu.Lock()
	now = now.Add(breakerCooldown + time.Second)
	mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Decide(ctx, testReq()); err == nil {
		t.Fatal("want fallback on cancelled trial")
	}

	// Source recovers; the next Decide must hit the server (trial retried)
	// and succeed — not return breaker with zero requests.
	healthy = true
	dec, err := c.Decide(context.Background(), testReq())
	if err != nil || dec.Level != "low" {
		t.Fatalf("decide after cancelled trial = %+v, err = %v", dec, err)
	}
	if got := rs.hits(); got != hitsAfterOpen+1 {
		t.Fatalf("server hits = %d, want %d (the retried trial)", got, hitsAfterOpen+1)
	}
	if s := c.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available", s)
	}
}

func TestDecide_Disabled(t *testing.T) {
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") })
	c := New(Options{Disabled: true, Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}}})
	// A disabled engine is unavailable from the start and stays that way.
	if s := c.Snapshot().Status; s != StatusUnavailable {
		t.Fatalf("initial status = %s, want unavailable", s)
	}
	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonDisabled {
		t.Fatalf("err = %v, want disabled fallback", err)
	}
	if got := rs.hits(); got != 0 {
		t.Fatalf("server hits = %d, want 0", got)
	}
	if err := c.Probe(context.Background()); err == nil {
		t.Fatal("probe on disabled client should fail")
	}
	if s := c.Snapshot().Status; s != StatusUnavailable {
		t.Fatalf("status after Decide and Probe = %s, want unavailable", s)
	}
}

func TestSnapshot_StatusTransitionsSameClient(t *testing.T) {
	// One client, one flippable backend: idle → available → degraded →
	// available → unavailable → available, all on the same instance.
	healthy := true
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		if healthy {
			return 200, okBody("low")
		}
		return 500, "x"
	})
	now := time.Now()
	c := New(Options{
		Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}},
		Now:     func() time.Time { return now },
	})

	if s := c.Snapshot().Status; s != StatusIdle {
		t.Fatalf("initial status = %s, want idle", s)
	}
	if _, err := c.Decide(context.Background(), testReq()); err != nil {
		t.Fatal(err)
	}
	if s := c.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available", s)
	}

	// available → degraded: one failure below the breaker threshold.
	healthy = false
	if _, err := c.Decide(context.Background(), testReq()); err == nil {
		t.Fatal("expected fallback error")
	}
	if s := c.Snapshot().Status; s != StatusDegraded {
		t.Fatalf("status = %s, want degraded", s)
	}

	// degraded → available: recovery on the same client.
	healthy = true
	if _, err := c.Decide(context.Background(), testReq()); err != nil {
		t.Fatal(err)
	}
	if s := c.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available after recovery", s)
	}

	// available → unavailable: three consecutive failures open the breaker.
	healthy = false
	for i := 0; i < 3; i++ {
		_, _ = c.Decide(context.Background(), testReq())
	}
	if s := c.Snapshot().Status; s != StatusUnavailable {
		t.Fatalf("status = %s, want unavailable", s)
	}

	// unavailable → available: a successful trial after cooldown.
	now = now.Add(breakerCooldown + time.Second)
	healthy = true
	if _, err := c.Decide(context.Background(), testReq()); err != nil {
		t.Fatal(err)
	}
	if s := c.Snapshot().Status; s != StatusAvailable {
		t.Fatalf("status = %s, want available after breaker recovery", s)
	}
}

func TestSnapshot_SinceIsCounterEpoch(t *testing.T) {
	// Since is the immutable epoch the counters started at; only
	// updated_at moves.
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 500, "x" })
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	c := New(Options{
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return now
		},
		Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}},
	})
	start := c.Snapshot().Since
	mu.Lock()
	now = now.Add(time.Hour)
	mu.Unlock()
	_, _ = c.Decide(context.Background(), testReq())
	snap := c.Snapshot()
	if !snap.Since.Equal(start) {
		t.Fatalf("since moved from %s to %s while counters kept accumulating", start, snap.Since)
	}
	if snap.UpdatedAt.Equal(start) {
		t.Fatalf("updated_at never moved from %s", snap.UpdatedAt)
	}
}

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

func TestProbe_DoesNotMaskOpenBreaker(t *testing.T) {
	// A probe that succeeds while the breaker has since opened must not
	// flip the snapshot to available — the breaker's unavailable verdict
	// wins, and the next Decide still falls back with breaker.
	probeStarted := make(chan struct{})
	finishProbe := make(chan struct{})
	var once sync.Once
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		if strings.Contains(string(body), "health-probe") {
			once.Do(func() { close(probeStarted) })
			<-finishProbe
			return 200, okBody("low")
		}
		return 500, "x"
	})
	c := New(Options{Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}}})

	finished := make(chan error, 1)
	go func() { finished <- c.Probe(context.Background()) }()
	<-probeStarted
	for i := 0; i < 3; i++ {
		_, _ = c.Decide(context.Background(), testReq())
	}
	close(finishProbe)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}

	if s := c.Snapshot().Status; s != StatusUnavailable {
		t.Fatalf("snapshot after successful probe vs open breaker = %s, want unavailable", s)
	}
	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonBreaker {
		t.Fatalf("err = %v, want breaker fallback", err)
	}
}

func TestProbe_BlockedWhileBreakerOpen(t *testing.T) {
	// M6: while the breaker is open, Probe must return breaker WITHOUT
	// sending a request — the server hit count must not move.
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 500, "x" })
	c := New(Options{Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}}})
	for i := 0; i < 3; i++ {
		_, _ = c.Decide(context.Background(), testReq())
	}
	hitsBefore := rs.hits()

	err := c.Probe(context.Background())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason != ReasonBreaker {
		t.Fatalf("probe while breaker open = %v, want breaker fallback", err)
	}
	if got := rs.hits(); got != hitsBefore {
		t.Fatalf("probe sent a request while breaker open: hits %d -> %d", hitsBefore, got)
	}
}

func TestProbe_DoesNotConsumeHalfOpenTrial(t *testing.T) {
	// M4: after the cooldown expires the half-open trial belongs to the
	// next Decide; a Probe in that window must stay blocked rather than
	// burn the single trial slot.
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 500, "x" })
	now := time.Now()
	var mu sync.Mutex
	c := New(Options{
		Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}},
		Now: func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return now
		},
	})
	for i := 0; i < 3; i++ {
		_, _ = c.Decide(context.Background(), testReq())
	}
	mu.Lock()
	now = now.Add(breakerCooldown + time.Second)
	mu.Unlock()

	if err := c.Probe(context.Background()); err == nil {
		t.Fatal("probe against a failing source should not report success")
	}
	// The trial slot is still available to Decide: it goes through and
	// fails against the (failing) source instead of getting breaker.
	// (3 warmups + the probe itself + this one trial = 5 hits.)
	_, err := c.Decide(context.Background(), testReq())
	var fb *FallbackError
	if !errors.As(err, &fb) || fb.Reason == ReasonBreaker {
		t.Fatalf("decide after probe in half-open window = %v, want the trial to still be available", err)
	}
	if got := rs.hits(); got != 5 {
		t.Fatalf("server hits = %d, want 5 (probe + trial)", got)
	}
}

func TestDecide_CallerContextCancelDoesNotCountAsFailure(t *testing.T) {
	// A cancelled caller context fails sources instantly; it must not
	// count against the breaker or flip the snapshot.
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") })
	c := New(Options{Sources: []Source{{Name: "s", BaseURL: rs.srv.URL}}})
	for i := 0; i < 5; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := c.Decide(ctx, testReq())
		if err == nil {
			t.Fatal("want fallback on cancelled context")
		}
	}
	snap := c.Snapshot()
	if snap.Status != StatusIdle {
		t.Fatalf("status = %s, want idle (cancellation is not a source failure)", snap.Status)
	}
	if snap.DecisionsFallback != 0 {
		t.Fatalf("decisions_fallback = %d, want 0", snap.DecisionsFallback)
	}
	// And the breaker never opened: a healthy Decide still succeeds.
	if _, err := c.Decide(context.Background(), testReq()); err != nil {
		t.Fatalf("healthy decide after cancellations: %v", err)
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

	// Undocumented regions are skipped instead of silently DNS-failing.
	if got := ResolveSources("dashscope", SourceEnv{DashScopeAPIKey: dashscopeTestKey, DashScopeWorkspaceID: "ws-3", DashScopeRegion: "us-mars-1"}); len(got) != 0 {
		t.Fatalf("sources = %+v, want skipped for unknown region", got)
	}
}

func TestAPINeverLeaked(t *testing.T) {
	// Capture the real default logger so anything this package logs goes
	// through the buffer; restore it when the test ends.
	var logBuf strings.Builder
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })

	// Exercise every path that can mention a source with credentials:
	// source resolution (warnings), an authenticated Decide failing with
	// 5xx, and an upstream echo attempt.
	echo := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		return 200, `{"answers":{"effort":{"choice":"` + r.Header.Get("Authorization") + `"}}}`
	})
	fail500 := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		return 500, "down"
	})
	c := New(Options{Sources: []Source{
		{Name: "opencode", BaseURL: fail500.srv.URL, Model: "jev-1.13", BearerToken: testKey},
		{Name: "dashscope", BaseURL: echo.srv.URL, Model: "m", BearerToken: dashscopeTestKey},
	}})
	_, err := c.Decide(context.Background(), testReq())
	if err == nil {
		t.Fatal("expected failure (echoed bearer is not a valid choice)")
	}
	_ = ResolveSources("opencode,dashscope", SourceEnv{OpenCodeAPIKey: testKey, DashScopeAPIKey: dashscopeTestKey, DashScopeWorkspaceID: "ws"})
	// Also trigger a warning WITHOUT the workspace id so a warn line is
	// guaranteed to land in the captured buffer.
	_ = ResolveSources("dashscope", SourceEnv{DashScopeAPIKey: dashscopeTestKey})
	snapBytes, _ := json.Marshal(c.Snapshot())

	if !strings.Contains(logBuf.String(), "jev source skipped") {
		t.Fatalf("log capture is empty — the no-key assertion below would be vacuous. log=%q", logBuf.String())
	}
	leaks := []string{err.Error(), logBuf.String(), string(snapBytes)}
	for _, leak := range leaks {
		for _, marker := range []string{testKey, dashscopeTestKey, "Bearer "} {
			if strings.Contains(leak, marker) {
				t.Fatalf("secret marker %q leaked into: %q", marker, leak)
			}
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

func TestDecide_ErrorDoesNotEchoUpstreamChoice(t *testing.T) {
	// A hostile/broken endpoint reflects the bearer key back as its
	// choice; the invalid-choice error must not echo that raw value.
	echo := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		return 200, `{"answers":{"effort":{"choice":"` + r.Header.Get("Authorization") + `"}}}`
	})
	c := New(Options{Sources: []Source{{Name: "authenticated", BaseURL: echo.srv.URL, BearerToken: testKey}}})
	_, err := c.Decide(context.Background(), testReq())
	if err == nil {
		t.Fatal("want invalid-choice failure")
	}
	if strings.Contains(err.Error(), testKey) || strings.Contains(err.Error(), "Bearer ") {
		t.Fatalf("invalid-choice error echoes upstream value: %v", err)
	}
}

func TestLive(t *testing.T) {
	if os.Getenv("MULTICA_RUN_JEV_LIVE") != "1" {
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

const selfHostedTestKey = "sk-selfhosted-LEAK"

func TestResolveSources_SelfHosted(t *testing.T) {
	// Valid URL, default model, no key.
	got := ResolveSources("self-hosted", SourceEnv{SelfHostedURL: "http://127.0.0.1:8009/v1/systemone"})
	if len(got) != 1 || got[0].Name != "self-hosted" {
		t.Fatalf("sources = %+v", got)
	}
	if got[0].BaseURL != "http://127.0.0.1:8009/v1/systemone" {
		t.Fatalf("base URL = %q", got[0].BaseURL)
	}
	if got[0].Model != "self-hosted" || got[0].BearerToken != "" {
		t.Fatalf("source = %+v, want model self-hosted and no bearer", got[0])
	}

	// Custom model and API key.
	got = ResolveSources("self-hosted", SourceEnv{
		SelfHostedURL:    "https://jev.internal:8443/systemone",
		SelfHostedModel:  "jev-finetune-1",
		SelfHostedAPIKey: selfHostedTestKey,
	})
	if len(got) != 1 || got[0].Model != "jev-finetune-1" || got[0].BearerToken != selfHostedTestKey {
		t.Fatalf("source = %+v", got)
	}

	// Missing or non-http(s) URLs skip the source (whitespace-only counts as missing).
	for _, bad := range []string{"", "   ", "ftp://127.0.0.1:8009/v1/systemone", "127.0.0.1:8009/v1/systemone", "://no-scheme", "http://", "http:///v1/systemone"} {
		if got := ResolveSources("self-hosted", SourceEnv{SelfHostedURL: bad}); len(got) != 0 {
			t.Fatalf("url %q: sources = %+v, want skipped", bad, got)
		}
	}
}

func TestDecide_SelfHostedWireFormat(t *testing.T) {
	var gotBody map[string]any
	var gotAuth, gotCT, gotCE string
	rs := newRecordingServer(t, func(r *http.Request, body []byte) (int, string) {
		_ = json.Unmarshal(body, &gotBody)
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		gotCE = r.Header.Get("Content-Encoding")
		return 200, okBody("high")
	})
	src := ResolveSources("self-hosted", SourceEnv{
		SelfHostedURL:    rs.srv.URL + "/v1/systemone",
		SelfHostedModel:  "jev-finetune-1",
		SelfHostedAPIKey: selfHostedTestKey,
	})
	if len(src) != 1 {
		t.Fatalf("sources = %+v", src)
	}
	c := New(Options{Sources: src})

	dec, err := c.Decide(context.Background(), testReq())
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if dec.Source != "self-hosted" {
		t.Fatalf("decision source = %q, want self-hosted", dec.Source)
	}
	if gotBody["model"] != "jev-finetune-1" {
		t.Fatalf("model = %v", gotBody["model"])
	}
	if gotAuth != "Bearer "+selfHostedTestKey {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotCT != "application/json" || gotCE != "" {
		t.Fatalf("Content-Type = %q, Content-Encoding = %q", gotCT, gotCE)
	}
	q := gotBody["questions"].(map[string]any)["effort"].(map[string]any)
	if q["type"] != "choice" || q["instructions"] != "pick effort" {
		t.Fatalf("question = %v", q)
	}
	crit := q["criteria"].(map[string]any)
	if len(crit) != 2 || crit["low"] != "mechanical" || crit["high"] != "deep" {
		t.Fatalf("criteria = %v", crit)
	}
	if _, ok := gotBody["state"]; !ok {
		t.Fatal("request body has no state")
	}
	if snap := c.Snapshot(); snap.ActiveSource != "self-hosted" || snap.Status != StatusAvailable {
		t.Fatalf("snapshot = %+v, want active self-hosted/available", snap)
	}

	// Default model and no Authorization header without a key.
	rs.setHandler(func(r *http.Request, body []byte) (int, string) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Authorization = %q, want empty without a key", r.Header.Get("Authorization"))
		}
		return 200, okBody("low")
	})
	src = ResolveSources("self-hosted", SourceEnv{SelfHostedURL: rs.srv.URL + "/v1/systemone"})
	c2 := New(Options{Sources: src})
	if _, err := c2.Decide(context.Background(), testReq()); err != nil {
		t.Fatalf("Decide (default model): %v", err)
	}
	if !strings.Contains(rs.lastBody(), `"model":"self-hosted"`) {
		t.Fatalf("body = %s, want default model self-hosted", rs.lastBody())
	}
}

func TestDecide_SelfHostedFailover(t *testing.T) {
	// self-hosted first, opencode-free second: every failure class on the
	// first source must fall through to the next one, and a success sets
	// active_source to the fallback that answered.
	ok := func(r *http.Request, body []byte) (int, string) { return 200, okBody("low") }
	for _, tc := range []struct {
		name       string
		first      func(r *http.Request, body []byte) (int, string)
		closed     bool   // bind then close the server: connection refused
		wantSource string // expected Decision.Source / snapshot active_source
		secondHits int    // requests the fallback source must receive
	}{
		{name: "success", first: ok, wantSource: "self-hosted", secondHits: 0},
		{name: "timeout", first: func(r *http.Request, body []byte) (int, string) {
			time.Sleep(800 * time.Millisecond)
			return 200, okBody("low")
		}, wantSource: "opencode-free", secondHits: 1},
		{name: "http500", first: func(r *http.Request, body []byte) (int, string) { return 500, "down" }, wantSource: "opencode-free", secondHits: 1},
		{name: "http400", first: func(r *http.Request, body []byte) (int, string) { return 400, "bad" }, wantSource: "opencode-free", secondHits: 1},
		{name: "refused", first: ok, closed: true, wantSource: "opencode-free", secondHits: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first := newRecordingServer(t, tc.first)
			base := first.srv.URL
			if tc.closed {
				first.srv.Close()
				base = first.srv.URL // still set: URL resolves, nothing listens
			}
			second := newRecordingServer(t, ok)
			sources := ResolveSources("self-hosted,opencode-free", SourceEnv{
				SelfHostedURL:    base + "/v1/systemone",
				SelfHostedAPIKey: selfHostedTestKey,
			})
			if len(sources) != 2 {
				t.Fatalf("sources = %+v", sources)
			}
			// Point the built-in opencode-free endpoint at the local second server.
			sources[1].BaseURL = second.srv.URL
			c := New(Options{Sources: sources, Timeout: 300 * time.Millisecond})
			dec, err := c.Decide(context.Background(), testReq())
			if err != nil {
				t.Fatalf("Decide: %v", err)
			}
			if dec.Source != tc.wantSource {
				t.Fatalf("decision source = %q, want %q", dec.Source, tc.wantSource)
			}
			if snap := c.Snapshot(); snap.ActiveSource != tc.wantSource {
				t.Fatalf("snapshot active_source = %q, want %q", snap.ActiveSource, tc.wantSource)
			}
			if second.hits() != tc.secondHits {
				t.Fatalf("second source hits = %d, want %d", second.hits(), tc.secondHits)
			}
		})
	}
}

func TestSelfHostedSecretsAndURLHandling(t *testing.T) {
	var logBuf strings.Builder
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })

	// An authenticated self-hosted source failing with connection refused:
	// the *url.Error wrapped by trySource carries the request address (for
	// local diagnostics), never the bearer key.
	refused := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	refused.Close()
	c := New(Options{
		Sources: []Source{{Name: "self-hosted", BaseURL: refused.URL, BearerToken: selfHostedTestKey, Model: "self-hosted"}},
		Timeout: 300 * time.Millisecond,
	})
	_, err := c.Decide(context.Background(), testReq())
	if err == nil {
		t.Fatal("want fallback")
	}
	snapBytes, _ := json.Marshal(c.Snapshot())
	// Trigger both skip-warning paths (missing and non-http URLs) with a key
	// set: the warnings must still not carry it, and each skip must warn
	// exactly once. A valid-URL resolve must not warn at all.
	skipCount := func() int { return strings.Count(logBuf.String(), "jev source skipped") }
	_ = ResolveSources("self-hosted", SourceEnv{SelfHostedAPIKey: selfHostedTestKey})
	if n := skipCount(); n != 1 {
		t.Fatalf("missing URL: %d skip warnings, want exactly 1", n)
	}
	_ = ResolveSources("self-hosted", SourceEnv{SelfHostedURL: "ftp://x", SelfHostedAPIKey: selfHostedTestKey})
	if n := skipCount(); n != 2 {
		t.Fatalf("non-http URL: %d cumulative skip warnings, want exactly 2", n)
	}
	if got := ResolveSources("self-hosted", SourceEnv{
		SelfHostedURL:    "http://127.0.0.1:8000/v1/systemone",
		SelfHostedAPIKey: selfHostedTestKey,
	}); len(got) != 1 {
		t.Fatalf("valid URL with key: sources = %+v, want resolved", got)
	}
	if n := skipCount(); n != 2 {
		t.Fatalf("valid URL resolve warned: %d skip warnings, want still 2", n)
	}

	// Key never leaks into errors, logs, or the snapshot.
	for _, leak := range []string{err.Error(), logBuf.String(), string(snapBytes)} {
		if strings.Contains(leak, selfHostedTestKey) || strings.Contains(leak, "Bearer ") {
			t.Fatalf("key leaked into: %q", leak)
		}
	}
	// URL never leaks into the snapshot (it MAY appear in errors and local logs).
	if strings.Contains(string(snapBytes), refused.URL) {
		t.Fatalf("URL leaked into snapshot: %s", snapBytes)
	}
	// Skip warnings name only the source and the reason, not the value.
	if !strings.Contains(logBuf.String(), "jev source skipped") {
		t.Fatalf("log capture is empty — the assertions above would be vacuous. log=%q", logBuf.String())
	}
	for _, line := range strings.Split(logBuf.String(), "\n") {
		if strings.Contains(line, "ftp://") {
			t.Fatalf("skip warning echoes variable value: %q", line)
		}
	}
}
