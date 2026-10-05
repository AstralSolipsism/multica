package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

func TestAntigravityCollectRequestAndTokenRotation(t *testing.T) {
	home := t.TempDir()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		wantToken, wantVersion := "ya29.first", "1.2.16"
		if n == 2 {
			wantToken, wantVersion = "ya29.refreshed", "1.2.17"
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1internal:retrieveUserQuota" {
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
		_, _ = io.WriteString(w, `{"buckets":[
			{"tokenType":"WTUS","modelId":"gemini-2.5-pro","remainingFraction":0.9464724},
			{"tokenType":"WTUS","modelId":"claude-sonnet-4-6","remainingFraction":0}
		],"email":"private@example.com","plan":"private-plan","credits":12345}`)
	}))
	defer srv.Close()
	c := newAntigravityPlanQuotaCollector(home)
	c.endpoint = srv.URL + "/v1internal:retrieveUserQuota"
	for i, token := range []string{"ya29.first", "ya29.refreshed"} {
		writeAntigravityTestToken(t, home, token)
		version := []string{"agy version 1.2.16", "antigravity-cli v1.2.17"}[i]
		started := time.Now().Unix()
		quota, err := c.collect(context.Background(), version)
		if err != nil {
			t.Fatal(err)
		}
		if quota.ObservedAt < started || quota.Provider != "antigravity" || quota.Source != protocol.PlanQuotaSourceDaemon || quota.Status != protocol.PlanQuotaStatusLimited || len(quota.Windows) != 2 {
			t.Fatalf("snapshot = %+v", quota)
		}
		if math.Abs(*quota.Windows[0].UsedPercent-5.35276) > 1e-8 || *quota.Windows[1].UsedPercent != 100 {
			t.Fatalf("wrong remaining-to-used conversion: %+v", quota.Windows)
		}
		if err := protocol.ValidateRuntimePlanQuota(quota, time.Now()); err != nil {
			t.Fatalf("collector violates heartbeat contract: %v", err)
		}
		for _, window := range quota.Windows {
			if window.Name == "" {
				t.Fatal("new daemon must name windows for older servers")
			}
		}
		encoded, err := json.Marshal(quota)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{token, "private", "credits", "email", "claude-sonnet", "reset", "window_minutes"} {
			if strings.Contains(string(encoded), forbidden) {
				t.Errorf("snapshot contains private or invented field %q: %s", forbidden, encoded)
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
			quota, err := c.collect(context.Background(), "1.2.16")
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
			quota, err := c.collect(context.Background(), "1.2.16")
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
	if quota, err := c.collect(context.Background(), "1.2.16"); err == nil || quota != nil || leaked.Load() != 0 {
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
	go func() { _, err := c.collect(ctx, "1.2.16"); done <- err }()
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

func TestAntigravityRemoteBucketAggregation(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want map[string]float64
	}{
		{"minimum per group", `{"buckets":[
			{"modelId":"gemini-pro","remainingFraction":0.9},
			{"modelId":"claude-sonnet","remainingFraction":0.6},
			{"modelId":"gemini-flash","remainingFraction":0.3},
			{"modelId":"gpt-oss","remainingFraction":0.2},
			{"modelId":"other-model","remainingFraction":0}
		]}`, map[string]float64{"gemini": 70, "claude_gpt": 80}},
		{"explicit zero and one", `{"buckets":[{"modelId":"gemini-pro","remainingFraction":1},{"modelId":"claude-sonnet","remainingFraction":0}]}`, map[string]float64{"gemini": 0, "claude_gpt": 100}},
		{"missing group stays absent", `{"buckets":[{"modelId":"gpt-oss","remainingFraction":0.5}]}`, map[string]float64{"claude_gpt": 50}},
		{"invalid rows ignored", `{"buckets":[{"modelId":"gemini-pro"},{"modelId":"gemini-pro","remainingFraction":null},{"modelId":"gemini-pro","remainingFraction":-1},{"modelId":"claude-sonnet","remainingFraction":2},{"modelId":"gpt-oss","remainingFraction":0.4}]}`, map[string]float64{"claude_gpt": 60}},
		{"unknown models", `{"buckets":[{"modelId":"not-gemini-pro","remainingFraction":0}]}`, nil},
		{"no fraction", `{"buckets":[{"modelId":"gemini-pro"}]}`, nil},
		{"empty buckets", `{"buckets":[]}`, nil},
		{"shape drift", `{"groups":[]}`, nil},
		{"malformed JSON", `{`, nil},
		{"wrong fraction type", `{"buckets":[{"modelId":"gemini-pro","remainingFraction":"0.5"}]}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Unix(1791050400, 0)
			quota, err := parseAntigravityRemoteQuota(strings.NewReader(tc.body), now)
			if tc.want == nil {
				if err == nil || quota != nil {
					t.Fatalf("unusable response returned quota=%+v err=%v", quota, err)
				}
				return
			}
			if err != nil || quota == nil || len(quota.Windows) != len(tc.want) || quota.ObservedAt != now.Unix() {
				t.Fatalf("quota=%+v err=%v", quota, err)
			}
			limited := false
			for _, window := range quota.Windows {
				want, ok := tc.want[window.Group]
				if !ok || window.UsedPercent == nil || math.Abs(*window.UsedPercent-want) > 1e-8 || window.WindowMinutes != nil || window.ResetsAt != nil {
					t.Fatalf("window=%+v, want=%v", window, tc.want)
				}
				limited = limited || want == 100
			}
			if len(quota.Windows) == 2 && quota.Windows[0].Group != "gemini" {
				t.Fatal("unstable group order")
			}
			if (quota.Status == protocol.PlanQuotaStatusLimited) != limited {
				t.Fatalf("status = %s", quota.Status)
			}
		})
	}
}

func TestAntigravityRemoteEarliestResetPerGroup(t *testing.T) {
	observedAt := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	buckets := []string{
		`{"modelId":"gemini-pro","remainingFraction":0.2,"resetTime":"2020-01-01T05:00:00Z"}`,
		`{"modelId":"gemini-flash","remainingFraction":0.6,"resetTime":"2020-01-01T02:00:00Z"}`,
		`{"modelId":"gemini-lite","remainingFraction":0.8,"resetTime":"2020-01-01T04:00:00Z"}`,
		`{"modelId":"claude-sonnet","remainingFraction":0.4,"resetTime":"2020-01-08T00:00:00Z"}`,
		`{"modelId":"gpt-oss","remainingFraction":0.6,"resetTime":"2020-01-03T00:00:00Z"}`,
		`{"modelId":"claude-opus","remainingFraction":0.3,"resetTime":"2020-01-06T00:00:00Z"}`,
		`{"modelId":"gemini-invalid","remainingFraction":-1,"resetTime":"2020-01-01T01:00:00Z"}`,
		`{"modelId":"claude-missing","resetTime":"2020-01-01T01:00:00Z"}`,
		`{"modelId":"unknown-model","remainingFraction":0,"resetTime":"2020-01-01T01:00:00Z"}`,
		`{"modelId":"gemini-no-reset","remainingFraction":0.5,"resetTime":"invalid"}`,
	}
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprintf("reverse=%v", reverse), func(t *testing.T) {
			ordered := append([]string(nil), buckets...)
			if reverse {
				for i, j := 0, len(ordered)-1; i < j; i, j = i+1, j-1 {
					ordered[i], ordered[j] = ordered[j], ordered[i]
				}
			}
			body := `{"buckets":[` + strings.Join(ordered, ",") + `]}`
			quota, err := parseAntigravityRemoteQuota(strings.NewReader(body), observedAt)
			if err != nil {
				t.Fatal(err)
			}
			if len(quota.Windows) != 2 || quota.ObservedAt != observedAt.Unix() {
				t.Fatalf("quota = %+v", quota)
			}
			for i, want := range []struct {
				group   string
				used    float64
				reset   time.Time
				minutes int64
			}{
				{"gemini", 80, observedAt.Add(2 * time.Hour), 300},
				{"claude_gpt", 70, observedAt.Add(48 * time.Hour), 10080},
			} {
				window := quota.Windows[i]
				if window.Group != want.group || window.UsedPercent == nil || math.Abs(*window.UsedPercent-want.used) > 1e-8 {
					t.Errorf("window = %+v, want %s used=%v", window, want.group, want.used)
				}
				if window.ResetsAt == nil || *window.ResetsAt != want.reset.Unix() {
					t.Errorf("%s reset = %v, want earliest reset %s", want.group, window.ResetsAt, want.reset)
				}
				if window.WindowMinutes == nil || *window.WindowMinutes != want.minutes {
					t.Errorf("%s window minutes = %v, want %d", want.group, window.WindowMinutes, want.minutes)
				}
			}
		})
	}
}

func TestAntigravityRemoteResetWindowBoundaries(t *testing.T) {
	// A historical observation makes any accidental use of time.Now/Until fail.
	observedAt := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name    string
		until   time.Duration
		minutes int64 // zero means no inferred window
	}{
		{"past reset", -time.Second, 0},
		{"reset now", 0, 0},
		{"positive reset", time.Second, 300},
		{"below six hours", 6*time.Hour - time.Second, 300},
		{"exactly six hours", 6 * time.Hour, 300},
		{"above six hours", 6*time.Hour + time.Second, 10080},
		{"seven days", 7 * 24 * time.Hour, 10080},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reset := observedAt.Add(tc.until)
			body := fmt.Sprintf(`{"buckets":[{"modelId":"gemini-pro","remainingFraction":0.5,"resetTime":%q}]}`, reset.Format(time.RFC3339))
			quota, err := parseAntigravityRemoteQuota(strings.NewReader(body), observedAt)
			if err != nil {
				t.Fatal(err)
			}
			if len(quota.Windows) != 1 {
				t.Fatalf("windows = %+v", quota.Windows)
			}
			window := quota.Windows[0]
			if window.ResetsAt == nil || *window.ResetsAt != reset.Unix() {
				t.Errorf("reset = %v, want %d", window.ResetsAt, reset.Unix())
			}
			if tc.minutes == 0 {
				if window.WindowMinutes != nil {
					t.Errorf("nonfuture reset inferred a window: %d", *window.WindowMinutes)
				}
			} else if window.WindowMinutes == nil || *window.WindowMinutes != tc.minutes {
				t.Errorf("window minutes = %v, want %d", window.WindowMinutes, tc.minutes)
			}
		})
	}
}

func TestAntigravityRemoteMissingOrInvalidReset(t *testing.T) {
	for _, field := range []string{"", `,"resetTime":""`, `,"resetTime":"invalid"`, `,"resetTime":null`} {
		t.Run(field, func(t *testing.T) {
			body := `{"buckets":[{"modelId":"claude-sonnet","remainingFraction":0.5` + field + `}]}`
			quota, err := parseAntigravityRemoteQuota(strings.NewReader(body), time.Unix(1577836800, 0))
			if err != nil {
				t.Fatal(err)
			}
			if len(quota.Windows) != 1 || quota.Windows[0].ResetsAt != nil || quota.Windows[0].WindowMinutes != nil {
				t.Fatalf("reset metadata invented: %+v", quota.Windows)
			}
		})
	}
}
