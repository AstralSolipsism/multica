package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
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

func writeAntigravityTestToken(t *testing.T, home, token string) {
	t.Helper()
	inner, err := json.Marshal(map[string]string{"access_token": token, "refresh_token": "private-refresh"})
	if err != nil {
		t.Fatal(err)
	}
	outer, err := json.Marshal(map[string]any{"token": json.RawMessage(inner), "email": "private@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, antigravityOAuthTokenFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, outer, 0o600); err != nil {
		t.Fatal(err)
	}
}

// Skeleton of the agy 1.3.0 retrieveUserQuotaSummary response captured live
// in OL-141: same field names and shape, fictional timestamps, no account
// data. The trailing email/project keys exist to prove they never reach the
// snapshot.
func antigravitySummaryFixture() string {
	return `{"groups":[
		{"displayName":"Gemini Models","description":"private group blurb","buckets":[
			{"bucketId":"gemini-weekly","window":"weekly","displayName":"Weekly Limit Remaining","remainingFraction":0.8008515,"resetTime":"2031-02-03T04:05:06Z","description":"private usage text"},
			{"bucketId":"gemini-5h","window":"5h","displayName":"Five Hour Limit Remaining","remainingFraction":0.9916125,"resetTime":"2031-02-03T07:08:09Z","description":"private usage text"}]},
		{"displayName":"Claude and GPT models","buckets":[
			{"bucketId":"3p-weekly","window":"weekly","displayName":"Weekly Limit Remaining","remainingFraction":0,"resetTime":"2031-02-06T10:11:12Z","description":"private usage text"},
			{"bucketId":"3p-5h","window":"5h","displayName":"Five Hour Limit Remaining","remainingFraction":1,"resetTime":"2031-02-03T06:54:32Z","description":"private usage text","disabled":true}]}],
	"email":"private@example.com","cloudaicompanionProject":"private-project"}`
}

func TestAntigravityCollectRequestAndTokenRotation(t *testing.T) {
	home := t.TempDir()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		wantToken, wantVersion := "ya29.first", "1.3.0"
		if n == 2 {
			wantToken, wantVersion = "ya29.refreshed", "1.3.1"
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1internal:retrieveUserQuotaSummary" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("User-Agent") != "antigravity-cli/"+wantVersion {
			t.Error("missing CLI User-Agent would cause HTTP 403")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+wantToken || r.Header.Get("Content-Type") != "application/json" {
			t.Error("wrong authorization or content type")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "{}" {
			t.Errorf("request body = %q; metadata fields cause HTTP 400", body)
		}
		_, _ = io.WriteString(w, antigravitySummaryFixture())
	}))
	defer srv.Close()
	c := newAntigravityPlanQuotaCollector(home)
	c.endpoint = srv.URL + "/v1internal:retrieveUserQuotaSummary"
	for i, token := range []string{"ya29.first", "ya29.refreshed"} {
		writeAntigravityTestToken(t, home, token)
		version := []string{"agy version 1.3.0", "antigravity-cli v1.3.1"}[i]
		started := time.Now().Unix()
		quota, err := c.collect(context.Background(), version)
		if err != nil {
			t.Fatal(err)
		}
		if quota.ObservedAt < started || quota.Provider != "antigravity" || quota.Source != protocol.PlanQuotaSourceDaemon || quota.Status != protocol.PlanQuotaStatusLimited || len(quota.Windows) != 4 {
			t.Fatalf("snapshot = %+v", quota)
		}
		wantResets := map[string]int64{
			"gemini_5h":         time.Date(2031, 2, 3, 7, 8, 9, 0, time.UTC).Unix(),
			"gemini_weekly":     time.Date(2031, 2, 3, 4, 5, 6, 0, time.UTC).Unix(),
			"claude_gpt_5h":     0, // fully replenished: rolling reset dropped
			"claude_gpt_weekly": time.Date(2031, 2, 6, 10, 11, 12, 0, time.UTC).Unix(),
		}
		wantUsed := map[string]float64{"gemini_5h": 0.84, "gemini_weekly": 19.91, "claude_gpt_5h": 0, "claude_gpt_weekly": 100}
		wantMinutes := map[string]int64{"gemini_5h": 300, "gemini_weekly": 10080, "claude_gpt_5h": 300, "claude_gpt_weekly": 10080}
		wantGroup := map[string]string{"gemini_5h": "gemini", "gemini_weekly": "gemini", "claude_gpt_5h": "claude_gpt", "claude_gpt_weekly": "claude_gpt"}
		for _, window := range quota.Windows {
			if window.Group != wantGroup[window.Name] {
				t.Fatalf("window %s group = %q", window.Name, window.Group)
			}
			if used, ok := wantUsed[window.Name]; !ok || window.UsedPercent == nil || math.Abs(*window.UsedPercent-used) > 1e-8 {
				t.Fatalf("window %s used = %v, want %v", window.Name, window.UsedPercent, wantUsed[window.Name])
			}
			if minutes, ok := wantMinutes[window.Name]; !ok || window.WindowMinutes == nil || *window.WindowMinutes != minutes {
				t.Fatalf("window %s minutes = %v", window.Name, window.WindowMinutes)
			}
			want, ok := wantResets[window.Name]
			if !ok {
				t.Fatalf("unexpected window %q", window.Name)
			}
			if want == 0 && window.ResetsAt != nil {
				t.Fatalf("window %s invented a reset: %+v", window.Name, window)
			}
			if want != 0 && (window.ResetsAt == nil || *window.ResetsAt != want) {
				t.Fatalf("window %s reset = %v, want %d", window.Name, window.ResetsAt, want)
			}
		}
		if err := protocol.ValidateRuntimePlanQuota(quota, time.Now()); err != nil {
			t.Fatalf("collector violates heartbeat contract: %v", err)
		}
		encoded, err := json.Marshal(quota)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{token, "private", "Limit Remaining", "usage text", "disabled", "email", "cloudaicompanion", "bucketId", "resetTime"} {
			if strings.Contains(string(encoded), forbidden) {
				t.Errorf("snapshot contains response or account field %q: %s", forbidden, encoded)
			}
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("requests = %d, want one per observation", calls.Load())
	}
}

func TestAntigravityCollectUnknownVersionSendsNothing(t *testing.T) {
	for _, version := range []string{"", "initializing plugins"} {
		c := newAntigravityPlanQuotaCollector(t.TempDir())
		c.endpoint = "invalid endpoint must not be used"
		if quota, err := c.collect(context.Background(), version); quota != nil || !errors.Is(err, errAntigravityQuotaVersion) {
			t.Fatalf("version=%q quota=%+v err=%v", version, quota, err)
		}
	}
}

func TestAntigravityTokenMalformedOrMissingSendsNothing(t *testing.T) {
	for _, body := range []string{"missing-file", "", `{}`, `{"token":null}`, `{"token":{}}`, `{"token":{"access_token":""}}`, `{"token":{"access_token":"  "}}`} {
		t.Run(body, func(t *testing.T) {
			home := t.TempDir()
			writeAntigravityTestToken(t, home, "ya29.placeholder")
			if body == "missing-file" {
				home = t.TempDir()
			} else if err := os.WriteFile(filepath.Join(home, antigravityOAuthTokenFile), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer srv.Close()
			c := newAntigravityPlanQuotaCollector(home)
			c.endpoint = srv.URL
			quota, err := c.collect(context.Background(), "1.3.0")
			if quota != nil || !errors.Is(err, errAntigravityQuotaToken) || calls.Load() != 0 {
				t.Fatalf("quota=%+v err=%v requests=%d", quota, err, calls.Load())
			}
		})
	}
}

func TestAntigravityCollectHTTPFailures(t *testing.T) {
	for _, status := range []int{400, 401, 403, 429, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			home := t.TempDir()
			writeAntigravityTestToken(t, home, "ya29.secret")
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":"private response ya29.secret"}`)
			}))
			defer srv.Close()
			c := newAntigravityPlanQuotaCollector(home)
			c.endpoint = srv.URL
			quota, err := c.collect(context.Background(), "1.3.0")
			if err == nil || quota != nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private") {
				t.Fatalf("quota=%+v err=%v", quota, err)
			}
			var rateLimited *rateLimitError
			if errors.As(err, &rateLimited) != (status == 429) {
				t.Fatalf("HTTP %d did not map to the correct backoff signal: %v", status, err)
			}
			if errors.Is(err, errAntigravityQuotaAuth) != (status == 401 || status == 403) {
				t.Fatalf("HTTP %d did not map to the correct auth diagnostic: %v", status, err)
			}
		})
	}
}

func TestAntigravityCollectRefusesRedirect(t *testing.T) {
	var leaked atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	home := t.TempDir()
	writeAntigravityTestToken(t, home, "ya29.secret")
	c := newAntigravityPlanQuotaCollector(home)
	c.endpoint = srv.URL
	if quota, err := c.collect(context.Background(), "1.3.0"); err == nil || quota != nil || leaked.Load() != 0 {
		t.Fatalf("redirect followed: quota=%+v err=%v target requests=%d", quota, err, leaked.Load())
	}
}

func TestAntigravityCollectCancellation(t *testing.T) {
	home := t.TempDir()
	writeAntigravityTestToken(t, home, "ya29.secret")
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer srv.Close()
	c := newAntigravityPlanQuotaCollector(home)
	c.endpoint = srv.URL
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := c.collect(ctx, "1.3.0"); done <- err }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want cancellation", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("request ignored cancellation")
	}
}

func TestAntigravityQuotaSummaryLiveSkeletonMapping(t *testing.T) {
	now := time.Unix(1791050400, 0)
	quota, err := parseAntigravityQuotaSummary(strings.NewReader(antigravitySummaryFixture()), now)
	if err != nil {
		t.Fatal(err)
	}
	if quota.ObservedAt != now.Unix() || quota.Status != protocol.PlanQuotaStatusLimited || len(quota.Windows) != 4 {
		t.Fatalf("quota = %+v", quota)
	}
	wantOrder := []string{"gemini_5h", "gemini_weekly", "claude_gpt_5h", "claude_gpt_weekly"}
	for i, name := range wantOrder {
		if quota.Windows[i].Name != name {
			t.Fatalf("order = %+v, want %v", quota.Windows, wantOrder)
		}
	}
	if err := protocol.ValidateRuntimePlanQuota(quota, time.Unix(now.Unix(), 0)); err != nil {
		t.Fatalf("summary snapshot violates heartbeat contract: %v", err)
	}
}

func TestAntigravityQuotaSummaryParsing(t *testing.T) {
	const unknownPool = `{"groups":[{"buckets":[
		{"bucketId":"future-pool-5h","window":"5h","remainingFraction":0.5},
		{"bucketId":"gemini-5h","window":"5h","remainingFraction":0.5,"resetTime":"2031-02-03T04:05:06Z"}]}]}`
	for _, tc := range []struct {
		name   string
		body   string
		verify func(*testing.T, *protocol.RuntimePlanQuota)
	}{
		{"unknown pool skipped", unknownPool, func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			if len(quota.Windows) != 1 || quota.Windows[0].Name != "gemini_5h" {
				t.Fatalf("windows = %+v", quota.Windows)
			}
		}},
		{"reversed groups and buckets keep order", reverseAntigravityGroups(antigravitySummaryFixture()), func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			want := []string{"gemini_5h", "gemini_weekly", "claude_gpt_5h", "claude_gpt_weekly"}
			for i, name := range want {
				if quota.Windows[i].Name != name {
					t.Fatalf("order = %+v, want %v", quota.Windows, want)
				}
			}
		}},
		{"unknown window type keeps bucket without length", `{"groups":[{"buckets":[{"bucketId":"gemini-monthly","window":"monthly","remainingFraction":0.5,"resetTime":"2031-02-03T04:05:06Z"}]}]}`, func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			if len(quota.Windows) != 1 || quota.Windows[0].Name != "gemini-monthly" || quota.Windows[0].WindowMinutes != nil || quota.Windows[0].Group != "gemini" || quota.Windows[0].ResetsAt == nil {
				t.Fatalf("window = %+v", quota.Windows[0])
			}
		}},
		{"missing window type keeps bucket without length", `{"groups":[{"buckets":[{"bucketId":"3p-quarterly","remainingFraction":0.5}]}]}`, func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			if len(quota.Windows) != 1 || quota.Windows[0].Name != "3p-quarterly" || quota.Windows[0].WindowMinutes != nil {
				t.Fatalf("window = %+v", quota.Windows[0])
			}
		}},
		{"fractional second reset parses", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":0.5,"resetTime":"2031-02-03T04:05:06.125Z"}]}]}`, func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			want := time.Date(2031, 2, 3, 4, 5, 6, 0, time.UTC).Unix()
			if quota.Windows[0].ResetsAt == nil || *quota.Windows[0].ResetsAt != want {
				t.Fatalf("reset = %v", quota.Windows[0].ResetsAt)
			}
		}},
		{"missing or invalid reset on used window tolerated", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":0.5},{"bucketId":"3p-5h","window":"5h","remainingFraction":0.4,"resetTime":"invalid"},{"bucketId":"3p-weekly","window":"weekly","remainingFraction":0.3,"resetTime":null}]}]}`, func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			for _, window := range quota.Windows {
				if window.ResetsAt != nil {
					t.Fatalf("reset metadata invented: %+v", window)
				}
			}
		}},
		{"zero remaining sets limited", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":0,"resetTime":"2031-02-03T04:05:06Z"}]}]}`, func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			if quota.Status != protocol.PlanQuotaStatusLimited {
				t.Fatalf("status = %s", quota.Status)
			}
		}},
		{"full remaining stays ok", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":1,"resetTime":"2031-02-03T04:05:06Z"}]}]}`, func(t *testing.T, quota *protocol.RuntimePlanQuota) {
			if quota.Status != protocol.PlanQuotaStatusOK || quota.Windows[0].ResetsAt != nil || *quota.Windows[0].UsedPercent != 0 {
				t.Fatalf("quota = %+v", quota)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			quota, err := parseAntigravityQuotaSummary(strings.NewReader(tc.body), time.Unix(1791050400, 0))
			if err != nil || quota == nil {
				t.Fatalf("quota=%+v err=%v", quota, err)
			}
			tc.verify(t, quota)
		})
	}
}

func TestAntigravityQuotaSummaryRejectsDrift(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"malformed json", `{`},
		{"legacy per-model shape", `{"buckets":[{"modelId":"gemini-pro","remainingFraction":0.5}]}`},
		{"wrong fraction type", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":"0.5"}]}]}`},
		{"missing fraction on known pool", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h"}]}]}`},
		{"fraction above one", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":2}]}]}`},
		{"fraction below zero", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":-1}]}]}`},
		{"null fraction on known pool", `{"groups":[{"buckets":[{"bucketId":"3p-5h","window":"5h","remainingFraction":null}]}]}`},
		{"no groups", `{"groups":[]}`},
		{"only unknown pools", `{"groups":[{"buckets":[{"bucketId":"future-pool-5h","window":"5h","remainingFraction":0.5}]}]}`},
		{"duplicate window", `{"groups":[{"buckets":[{"bucketId":"gemini-5h","window":"5h","remainingFraction":0.5},{"bucketId":"gemini-5h","window":"5h","remainingFraction":0.4}]}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			quota, err := parseAntigravityQuotaSummary(strings.NewReader(tc.body), time.Unix(1791050400, 0))
			if err == nil || quota != nil {
				t.Fatalf("drift accepted: quota=%+v err=%v", quota, err)
			}
			if !errors.Is(err, errAntigravityQuotaShape) {
				t.Fatalf("error = %v, want a shape diagnostic", err)
			}
		})
	}
}

// reverseAntigravityGroups decodes the fixture, reverses group and bucket
// slices, and re-encodes it: the parser must produce the same canonical order
// regardless of how the endpoint happens to serialize its lists.
func reverseAntigravityGroups(fixture string) string {
	var doc map[string]any
	if err := json.Unmarshal([]byte(fixture), &doc); err != nil {
		panic(err)
	}
	groups := doc["groups"].([]any)
	for i, j := 0, len(groups)-1; i < j; i, j = i+1, j-1 {
		groups[i], groups[j] = groups[j], groups[i]
	}
	for _, group := range groups {
		buckets := group.(map[string]any)["buckets"].([]any)
		for i, j := 0, len(buckets)-1; i < j; i, j = i+1, j-1 {
			buckets[i], buckets[j] = buckets[j], buckets[i]
		}
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}
