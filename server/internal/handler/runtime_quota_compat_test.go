package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemonws"
	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// The deployed daemon omitted names. A server-only update must accept that
// exact wire shape and refresh unchanged content through either transport.
func TestHeartbeatAcceptsUnnamedAntigravityGroups(t *testing.T) {
	for _, transport := range []string{"http", "ws"} {
		t.Run(transport, func(t *testing.T) {
			runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
			identity := daemonws.ClientIdentity{
				WorkspaceID: testWorkspaceID,
				RuntimeLeases: map[string]*daemonws.RuntimeLease{
					runtimeID: daemonws.NewRuntimeLease(testWorkspaceID, "online", time.Now(), true),
				},
			}
			now := time.Now().Unix()
			for _, observed := range []int64{now - 11*3600, now} {
				body := map[string]any{
					"runtime_id": runtimeID,
					"plan_quota": map[string]any{
						"provider": "antigravity", "status": "ok", "observed_at": observed,
						"windows": []map[string]any{
							{"name": "", "group": "gemini", "used_percent": 40},
							{"name": "", "group": "claude_gpt", "used_percent": 20},
						},
					},
				}
				if transport == "http" {
					req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, "quota-compat-daemon")
					testutil.Call(t, testHandler.DaemonHeartbeat, req).Want(http.StatusOK)
				} else {
					raw, err := json.Marshal(body)
					if err != nil {
						t.Fatal(err)
					}
					var payload protocol.DaemonHeartbeatRequestPayload
					if err := json.Unmarshal(raw, &payload); err != nil {
						t.Fatal(err)
					}
					ack, err := testHandler.HandleDaemonWSHeartbeat(context.Background(), identity, payload)
					if err != nil || ack == nil || ack.Status != "ok" {
						t.Fatalf("ack=%+v error=%v", ack, err)
					}
				}
				stored := readPlanQuotaColumn(t, runtimeID)
				if stored["observed_at"] != float64(observed) || stored["provider"] != "antigravity" || stored["source"] != "daemon" {
					t.Fatalf("snapshot did not refresh: %+v", stored)
				}
				windows := stored["windows"].([]any)
				if len(windows) != 2 || windows[0].(map[string]any)["group"] != "gemini" || windows[1].(map[string]any)["group"] != "claude_gpt" {
					t.Fatalf("lost quota groups: %+v", windows)
				}
			}
		})
	}
}

func TestHeartbeatQuotaDropsCountEveryTimeAndWarnPerRuntime(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	h := &Handler{Metrics: obsmetrics.NewBusinessMetrics(), planQuotaDropLogs: &planQuotaDropLogLimiter{}}
	rt := db.AgentRuntime{ID: parseUUID("00000000-0000-0000-0000-000000000001")}
	now := time.Now()
	invalid := &protocol.RuntimePlanQuota{Provider: "antigravity", ObservedAt: 0}
	h.storeHeartbeatPlanQuotaAt(context.Background(), rt, nil, now)
	for _, delay := range []time.Duration{0, time.Second, planQuotaDropLogInterval - time.Nanosecond, planQuotaDropLogInterval} {
		h.storeHeartbeatPlanQuotaAt(context.Background(), rt, invalid, now.Add(delay))
	}
	rt.ID = parseUUID("00000000-0000-0000-0000-000000000002")
	h.storeHeartbeatPlanQuotaAt(context.Background(), rt, invalid, now)
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("wanted 3 warnings for 5 drops, got %s", logs.String())
	}
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		runtimeID, _ := record["runtime_id"].(string)
		reason, _ := record["error"].(string)
		if record["level"] != "WARN" || record["provider"] != "antigravity" || runtimeID == "" || !strings.Contains(reason, "observed_at") {
			t.Fatalf("missing diagnostic context: %v", record)
		}
	}
	family := obsmetrics.GatherForTest(t, h.Metrics)["multica_runtime_plan_quota_dropped_total"]
	if family == nil || len(family.GetMetric()) != 1 || family.GetMetric()[0].GetCounter().GetValue() != 5 {
		t.Fatalf("missing drops (including suppressed warnings): %v", family)
	}
}

func TestPlanQuotaDropLogLimiterConcurrentAndExpiry(t *testing.T) {
	l := &planQuotaDropLogLimiter{}
	now := time.Now()
	var logged atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.allow("runtime", now) {
				logged.Add(1)
			}
		}()
	}
	wg.Wait()
	if logged.Load() != 1 {
		t.Fatalf("concurrent warnings: %d", logged.Load())
	}
	if !l.allow("another", now.Add(planQuotaDropLogInterval)) {
		t.Fatal("new runtime suppressed")
	}
	if _, exists := l.next["runtime"]; exists {
		t.Fatal("expired runtime retained")
	}
}
