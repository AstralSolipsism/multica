package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func newAntigravityCollectorTestDaemon() *Daemon {
	return &Daemon{
		cfg:           Config{Agents: map[string]AgentEntry{"antigravity": {Path: "/fake/agy"}}},
		logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		agentVersions: map[string]string{"antigravity": "agy version 1.2.16"},
		workspaces: map[string]*workspaceState{
			"ws-1": {runtimeIDs: []string{"rt-agy", "rt-codex"}},
			"ws-2": {runtimeIDs: []string{"rt-agy-2"}},
		},
		runtimeIndex: map[string]Runtime{
			"rt-agy":   {ID: "rt-agy", Provider: "antigravity"},
			"rt-agy-2": {ID: "rt-agy-2", Provider: "antigravity"},
			"rt-codex": {ID: "rt-codex", Provider: "codex"},
		},
	}
}

type antigravityTestTransport func(*http.Request) (*http.Response, error)

func (f antigravityTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAntigravityCollectorLoopRefreshesHeartbeatsWithoutTasks(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := newAntigravityCollectorTestDaemon()
		home := t.TempDir()
		writeAntigravityTestToken(t, home, "ya29.first")
		collector := newAntigravityPlanQuotaCollector(home)
		var calls atomic.Int32
		collector.client.Transport = antigravityTestTransport(func(r *http.Request) (*http.Response, error) {
			round := calls.Add(1)
			status := http.StatusOK
			if round == 2 {
				status = http.StatusUnauthorized
			}
			if round == 3 && (r.Header.Get("Authorization") != "Bearer ya29.refreshed" || r.Header.Get("User-Agent") != "antigravity-cli/1.2.17") {
				t.Error("collector did not reload refreshed token and discovered version")
			}
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"buckets":[{"modelId":"gemini-pro","remainingFraction":0.4}]}`))}, nil
		})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go d.runAntigravityPlanQuotaCollector(ctx, collector, defaultPlanQuotaPollInterval)
		time.Sleep(defaultPlanQuotaPollInterval)
		synctest.Wait()
		first := d.heartbeatExtrasFor("rt-agy").PlanQuota
		if first == nil || len(first.Windows) != 1 || first.Provider != "antigravity" || first.Source != protocol.PlanQuotaSourceDaemon || time.Now().Unix()-first.ObservedAt >= 300 {
			t.Fatalf("fresh quota missing from heartbeat: %+v", first)
		}
		if calls.Load() != 1 || d.heartbeatExtrasFor("rt-agy-2").PlanQuota != first || d.heartbeatExtrasFor("rt-codex").PlanQuota != nil {
			t.Fatal("one account request must fan out only to Antigravity runtimes")
		}
		success := d.antigravityQuotaDiagSnapshot()
		if success == nil || success.LastSuccessAt == "" || success.LastSkipReason != "" {
			t.Fatalf("success diagnostic = %+v", success)
		}
		time.Sleep(defaultPlanQuotaPollInterval)
		synctest.Wait()
		failed := d.antigravityQuotaDiagSnapshot()
		if calls.Load() != 2 || d.heartbeatExtrasFor("rt-agy").PlanQuota != first || failed.LastSkipReason != antigravityQuotaSkipAuth || failed.LastSuccessAt != success.LastSuccessAt {
			t.Fatal("an authorization failure must preserve the last observation and success timestamp")
		}
		writeAntigravityTestToken(t, home, "ya29.refreshed")
		d.setAgentVersion("antigravity", "agy version 1.2.17")
		time.Sleep(defaultPlanQuotaPollInterval)
		synctest.Wait()
		fresh := d.heartbeatExtrasFor("rt-agy").PlanQuota
		if calls.Load() != 3 || fresh.ObservedAt <= first.ObservedAt || d.antigravityQuotaDiagSnapshot().LastSkipReason != "" {
			t.Fatal("collector did not recover after token rotation")
		}
		cancel()
		synctest.Wait()
	})
}

func TestAntigravityCollectorLoopBacksOffRateLimits(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := newAntigravityCollectorTestDaemon()
		home := t.TempDir()
		writeAntigravityTestToken(t, home, "ya29.test")
		collector := newAntigravityPlanQuotaCollector(home)
		var calls atomic.Int32
		collector.client.Transport = antigravityTestTransport(func(*http.Request) (*http.Response, error) {
			round := calls.Add(1)
			status := http.StatusOK
			if round == 1 {
				status = http.StatusTooManyRequests
			}
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"buckets":[{"modelId":"gemini-pro","remainingFraction":1}]}`))}, nil
		})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go d.runAntigravityPlanQuotaCollector(ctx, collector, defaultPlanQuotaPollInterval)
		time.Sleep(defaultPlanQuotaPollInterval)
		synctest.Wait()
		if calls.Load() != 1 || d.antigravityQuotaDiagSnapshot().LastSkipReason != antigravityQuotaSkipRateLimited {
			t.Fatal("missing rate-limit diagnostic")
		}
		time.Sleep(defaultPlanQuotaPollInterval)
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatal("429 did not delay the next request")
		}
		time.Sleep(defaultPlanQuotaPollInterval)
		synctest.Wait()
		if calls.Load() != 2 {
			t.Fatal("collector did not recover after backoff")
		}
		time.Sleep(defaultPlanQuotaPollInterval)
		synctest.Wait()
		if calls.Load() != 3 {
			t.Fatal("success did not restore the base interval")
		}
		cancel()
		synctest.Wait()
	})
}

func TestAntigravityCollectorGatesAndHealth(t *testing.T) {
	for _, tc := range []struct {
		name   string
		setup  func(*Daemon)
		reason string
	}{
		{"no runtime", func(d *Daemon) { d.runtimeIndex = nil }, ""},
		{"no CLI", func(d *Daemon) { d.cfg.Agents = nil }, antigravityQuotaSkipNotRegistered},
		{"no version", func(d *Daemon) { d.agentVersions = nil }, antigravityQuotaSkipNoVersion},
		{"invalid version", func(d *Daemon) { d.agentVersions["antigravity"] = "initializing" }, antigravityQuotaSkipNoVersion},
		{"missing token", func(*Daemon) {}, antigravityQuotaSkipToken},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				d := newAntigravityCollectorTestDaemon()
				tc.setup(d)
				collector := newAntigravityPlanQuotaCollector(t.TempDir())
				collector.client.Transport = antigravityTestTransport(func(*http.Request) (*http.Response, error) {
					t.Error("unconfigured collector sent a request")
					return nil, context.Canceled
				})
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				go d.runAntigravityPlanQuotaCollector(ctx, collector, defaultPlanQuotaPollInterval)
				time.Sleep(defaultPlanQuotaPollInterval)
				synctest.Wait()
				cancel()
				synctest.Wait()
				rec := httptest.NewRecorder()
				d.healthHandler(time.Now()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
				var body struct {
					Quota *healthAntigravityQuota `json:"antigravity_quota"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if tc.reason == "" {
					if body.Quota != nil {
						t.Fatal("machine without Antigravity gained quota diagnostics")
					}
				} else if body.Quota == nil || body.Quota.LastSkipReason != tc.reason || body.Quota.LastAttemptAt == "" || body.Quota.LastSuccessAt != "" {
					t.Fatalf("health=%+v, want reason %s", body.Quota, tc.reason)
				}
			})
		})
	}
}
