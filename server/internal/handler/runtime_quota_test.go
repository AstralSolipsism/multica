package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemonws"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func readPlanQuotaColumn(t *testing.T, runtimeID string) map[string]any {
	t.Helper()
	var raw []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT plan_quota FROM agent_runtime WHERE id = $1`, runtimeID,
	).Scan(&raw); err != nil {
		t.Fatalf("read plan_quota: %v", err)
	}
	if raw == nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode plan_quota: %v", err)
	}
	return out
}

func validPlanQuotaPayload(observedAt int64) *protocol.RuntimePlanQuota {
	used := 42.5
	minutes := int64(300)
	return &protocol.RuntimePlanQuota{
		Provider: "codex",
		Status:   protocol.PlanQuotaStatusOK,
		Windows: []protocol.RuntimePlanQuotaWindow{
			{Name: "primary", UsedPercent: &used, WindowMinutes: &minutes},
		},
		ObservedAt: observedAt,
		Source:     protocol.PlanQuotaSourceDaemon,
	}
}

// TestValidateRuntimePlanQuota pins the wire-contract validation: bounds,
// normalization, the required fields, and the future-clock skew guard.
func TestValidateRuntimePlanQuota(t *testing.T) {
	t.Parallel()
	now := time.Now()

	t.Run("valid payload normalizes empty status", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Status = ""
		if err := validateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if q.Status != protocol.PlanQuotaStatusOK {
			t.Fatalf("status = %q, want ok", q.Status)
		}
	})

	t.Run("provider required", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Provider = ""
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for empty provider")
		}
	})

	t.Run("observed_at must be positive", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(0)
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for observed_at=0")
		}
	})

	t.Run("observed_at within the skew allowance is accepted", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Add(planQuotaMaxFutureSkew).Unix())
		if err := validateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate at skew boundary: %v", err)
		}
	})

	t.Run("observed_at beyond the skew allowance is rejected", func(t *testing.T) {
		t.Parallel()
		// A far-future timestamp would otherwise pin the row and suppress
		// every later snapshot ("newer observed_at wins").
		q := validPlanQuotaPayload(now.Add(planQuotaMaxFutureSkew + time.Hour).Unix())
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for far-future observed_at")
		}
	})

	t.Run("bogus status rejected", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Status = "exhausted"
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for unknown status")
		}
	})

	t.Run("too many windows", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		for len(q.Windows) < protocol.PlanQuotaMaxWindows+1 {
			q.Windows = append(q.Windows, protocol.RuntimePlanQuotaWindow{Name: "w"})
		}
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for >8 windows")
		}
	})

	t.Run("window name bounds", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		q.Windows[0].Name = ""
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for empty window name")
		}
		q.Windows[0].Name = strings.Repeat("x", protocol.PlanQuotaMaxWindowName+1)
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized window name")
		}
	})

	t.Run("window minutes range", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		zero := int64(0)
		q.Windows[0].WindowMinutes = &zero
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for window_minutes=0")
		}
		over := int64(protocol.PlanQuotaMaxWindowMinutes + 1)
		q.Windows[0].WindowMinutes = &over
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized window_minutes")
		}
	})

	t.Run("used percent range", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		negative := -1.0
		q.Windows[0].UsedPercent = &negative
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for negative used_percent")
		}
		over := float64(protocol.PlanQuotaMaxUsedPercent + 1)
		q.Windows[0].UsedPercent = &over
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized used_percent")
		}
	})

	t.Run("group label bounds", func(t *testing.T) {
		t.Parallel()
		// The optional group labels providers with several quota pools
		// (antigravity's gemini / claude_gpt) are free-form but bounded, and
		// omission stays legal for single-pool providers.
		q := validPlanQuotaPayload(now.Unix())
		q.Windows[0].Group = "gemini"
		if err := validateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate with group: %v", err)
		}
		q.Windows[0].Group = strings.Repeat("x", protocol.PlanQuotaMaxGroupName+1)
		if err := validateRuntimePlanQuota(q, now); err == nil {
			t.Fatal("expected error for oversized group")
		}
	})

	t.Run("real zero values are accepted", func(t *testing.T) {
		t.Parallel()
		q := validPlanQuotaPayload(now.Unix())
		zeroPercent := 0.0
		q.Windows[0].UsedPercent = &zeroPercent
		if err := validateRuntimePlanQuota(q, now); err != nil {
			t.Fatalf("validate: %v", err)
		}
	})
}

// TestApplyRuntimePlanQuotaConditionalWrite drives the SQL contract directly:
// newer observed_at wins, content changes write immediately, freshness-only
// refreshes are throttled, and a broadcast fires exactly when the row changed.
func TestApplyRuntimePlanQuotaConditionalWrite(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
	rt := loadRuntime(t, runtimeID)
	ctx := context.Background()

	bus := events.New()
	var published []string
	bus.SubscribeAll(func(event events.Event) { published = append(published, event.Type) })
	handler := *testHandler
	handler.Bus = bus

	// First write lands and broadcasts.
	updated, err := handler.applyRuntimePlanQuota(ctx, rt, validPlanQuotaPayload(1000))
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if !updated {
		t.Fatal("first write reported updated=false")
	}
	if len(published) != 1 || published[0] != protocol.EventRuntimeTelemetryUpdated {
		t.Fatalf("published = %v, want one %s", published, protocol.EventRuntimeTelemetryUpdated)
	}
	stored := readPlanQuotaColumn(t, runtimeID)
	if stored["observed_at"] != float64(1000) || stored["provider"] != "codex" {
		t.Fatalf("stored = %v", stored)
	}

	// Byte-identical rewrite is a no-op (write-on-change), no broadcast.
	updated, err = handler.applyRuntimePlanQuota(ctx, rt, validPlanQuotaPayload(1000))
	if err != nil {
		t.Fatalf("identical apply: %v", err)
	}
	if updated {
		t.Fatal("identical payload reported updated=true")
	}
	if len(published) != 1 {
		t.Fatalf("identical payload broadcast: published = %v", published)
	}

	// Same content with a newer observed_at inside the freshness window is
	// throttled: no write, no broadcast, stored observed_at untouched.
	updated, err = handler.applyRuntimePlanQuota(ctx, rt, validPlanQuotaPayload(1000+planQuotaFreshnessThrottleSeconds-1))
	if err != nil {
		t.Fatalf("freshness apply: %v", err)
	}
	if updated {
		t.Fatal("freshness-only refresh inside the throttle window reported updated=true")
	}
	if got := readPlanQuotaColumn(t, runtimeID)["observed_at"]; got != float64(1000) {
		t.Fatalf("stored observed_at = %v, want 1000 after throttled refresh", got)
	}

	// The same refresh past the throttle window lands (and broadcasts —
	// freshness is user-visible through the snapshot age).
	updated, err = handler.applyRuntimePlanQuota(ctx, rt, validPlanQuotaPayload(1000+planQuotaFreshnessThrottleSeconds+1))
	if err != nil {
		t.Fatalf("throttled apply: %v", err)
	}
	if !updated {
		t.Fatal("freshness refresh past the throttle window reported updated=false")
	}
	if got := readPlanQuotaColumn(t, runtimeID)["observed_at"]; got != float64(1000+planQuotaFreshnessThrottleSeconds+1) {
		t.Fatalf("stored observed_at = %v, want refreshed value", got)
	}

	// Older observed_at is rejected; the stored snapshot is untouched.
	updated, err = handler.applyRuntimePlanQuota(ctx, rt, validPlanQuotaPayload(500))
	if err != nil {
		t.Fatalf("stale apply: %v", err)
	}
	if updated {
		t.Fatal("stale observed_at reported updated=true")
	}

	// Newer observed_at with a changed payload lands and broadcasts.
	fresh := validPlanQuotaPayload(2000)
	fresh.Status = protocol.PlanQuotaStatusLimited
	updated, err = handler.applyRuntimePlanQuota(ctx, rt, fresh)
	if err != nil {
		t.Fatalf("fresh apply: %v", err)
	}
	if !updated {
		t.Fatal("newer payload reported updated=false")
	}
	stored = readPlanQuotaColumn(t, runtimeID)
	if stored["observed_at"] != float64(2000) || stored["status"] != "limited" {
		t.Fatalf("stored = %v", stored)
	}
}

// TestDaemonHeartbeatPlanQuota pins the heartbeat integration: a valid
// plan_quota field is stored with source forced to "daemon" even when the
// body claims otherwise, and an invalid field is dropped without failing
// the beat.
func TestDaemonHeartbeatPlanQuota(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	t.Run("valid field stored with daemon source", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			"runtime_id": runtimeID,
			"plan_quota": map[string]any{
				"provider":    "codex",
				"status":      "ok",
				"windows":     []map[string]any{{"name": "primary", "used_percent": 42.5, "window_minutes": 300}},
				"observed_at": time.Now().Unix(),
				// A heartbeat must never be able to impersonate the push endpoint.
				"source": "external",
			},
		}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, "quota-heartbeat-daemon")
		testutil.Call(t, testHandler.DaemonHeartbeat, req).Want(http.StatusOK)

		stored := readPlanQuotaColumn(t, runtimeID)
		if stored == nil {
			t.Fatal("plan_quota not stored from heartbeat")
		}
		if stored["source"] != "daemon" {
			t.Fatalf("stored source = %v, want daemon", stored["source"])
		}
	})

	t.Run("invalid field dropped, beat still acked", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			"runtime_id": runtimeID,
			"plan_quota": map[string]any{
				"provider":    "codex",
				"status":      "ok",
				"observed_at": 0, // invalid: must be positive
			},
		}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, "quota-heartbeat-daemon")
		testutil.Call(t, testHandler.DaemonHeartbeat, req).Want(http.StatusOK)

		if stored := readPlanQuotaColumn(t, runtimeID); stored != nil {
			t.Fatalf("invalid plan_quota was stored: %v", stored)
		}
	})

	t.Run("far-future observed_at dropped, beat still acked", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			"runtime_id": runtimeID,
			"plan_quota": map[string]any{
				"provider":    "codex",
				"status":      "ok",
				"observed_at": time.Now().Add(2 * time.Hour).Unix(),
			},
		}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, "quota-heartbeat-daemon")
		testutil.Call(t, testHandler.DaemonHeartbeat, req).Want(http.StatusOK)

		if stored := readPlanQuotaColumn(t, runtimeID); stored != nil {
			t.Fatalf("far-future plan_quota was stored: %v", stored)
		}
	})
}

// TestHandleDaemonWSHeartbeatPlanQuota covers the WebSocket twin: the extra
// on the WS payload takes the lease path to the same storage.
func TestHandleDaemonWSHeartbeatPlanQuota(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
	identity := daemonws.ClientIdentity{
		WorkspaceID: testWorkspaceID,
		RuntimeLeases: map[string]*daemonws.RuntimeLease{
			runtimeID: daemonws.NewRuntimeLease(testWorkspaceID, "online", time.Now(), true),
		},
	}
	payload := protocol.DaemonHeartbeatRequestPayload{
		RuntimeID: runtimeID,
		PlanQuota: validPlanQuotaPayload(time.Now().Unix()),
	}
	ack, err := testHandler.HandleDaemonWSHeartbeat(context.Background(), identity, payload)
	if err != nil {
		t.Fatalf("HandleDaemonWSHeartbeat: %v", err)
	}
	if ack == nil || ack.Status != "ok" {
		t.Fatalf("ack = %+v", ack)
	}

	stored := readPlanQuotaColumn(t, runtimeID)
	if stored == nil || stored["provider"] != "codex" {
		t.Fatalf("plan_quota = %v after WS heartbeat", stored)
	}
}

// TestReportRuntimeQuota covers the external push endpoint: happy path with
// provider defaulting and forced external source, stale/unchanged acks,
// validation 400s, and the hardened write-access rules.
func TestReportRuntimeQuota(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	// newDaemonQuotaRequest authenticates with the daemon token of the
	// runtime's OWN daemon (the access rule the endpoint enforces).
	newDaemonQuotaRequest := func(runtimeID string, body map[string]any) *http.Request {
		rt := loadRuntime(t, runtimeID)
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", body, testWorkspaceID, rt.DaemonID.String)
		return withURLParam(req, "runtimeId", runtimeID)
	}

	t.Run("happy path defaults provider and forces external source", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			// No provider: the runtime row's provider must fill in.
			"status":      "ok",
			"windows":     []map[string]any{{"name": "primary", "used_percent": 42.5, "window_minutes": 300, "resets_at": 1757000000}},
			"observed_at": time.Now().Unix(),
			"source":      "daemon", // must be overridden to external
		}
		w := testutil.Call(t, testHandler.ReportRuntimeQuota, newDaemonQuotaRequest(runtimeID, body)).Want(http.StatusOK)
		var resp map[string]any
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode ack: %v", err)
		}
		if resp["updated"] != true {
			t.Fatalf("ack = %v, want updated=true", resp)
		}
		stored := readPlanQuotaColumn(t, runtimeID)
		if stored == nil {
			t.Fatal("plan_quota not stored from push endpoint")
		}
		if stored["source"] != "external" {
			t.Fatalf("stored source = %v, want external", stored["source"])
		}
		if stored["provider"] != "claude" {
			t.Fatalf("stored provider = %v, want runtime row's claude", stored["provider"])
		}
	})

	t.Run("stale observed_at acks updated=false", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		now := time.Now().Unix()
		freshBody := map[string]any{"status": "ok", "observed_at": now}
		testutil.Call(t, testHandler.ReportRuntimeQuota, newDaemonQuotaRequest(runtimeID, freshBody)).Want(http.StatusOK)

		staleBody := map[string]any{"status": "limited", "observed_at": now - 3600}
		w := testutil.Call(t, testHandler.ReportRuntimeQuota, newDaemonQuotaRequest(runtimeID, staleBody)).Want(http.StatusOK)
		var resp map[string]any
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode ack: %v", err)
		}
		if resp["updated"] != false {
			t.Fatalf("ack = %v, want updated=false", resp)
		}
		if got := readPlanQuotaColumn(t, runtimeID)["observed_at"]; got != float64(now) {
			t.Fatalf("stored observed_at = %v, want %d", got, now)
		}
	})

	t.Run("validation failure is a 400", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		for name, body := range map[string]map[string]any{
			"missing observed_at": {"status": "ok"},
			"bad status":          {"status": "throttled", "observed_at": time.Now().Unix()},
			"future observed_at":  {"status": "ok", "observed_at": time.Now().Add(2 * time.Hour).Unix()},
			"empty window name":   {"status": "ok", "observed_at": time.Now().Unix(), "windows": []map[string]any{{"name": ""}}},
			"too many windows": {"status": "ok", "observed_at": time.Now().Unix(), "windows": []map[string]any{
				{"name": "1"}, {"name": "2"}, {"name": "3"}, {"name": "4"},
				{"name": "5"}, {"name": "6"}, {"name": "7"}, {"name": "8"}, {"name": "9"},
			}},
		} {
			t.Run(name, func(t *testing.T) {
				testutil.Call(t, testHandler.ReportRuntimeQuota, newDaemonQuotaRequest(runtimeID, body)).Want(http.StatusBadRequest)
			})
		}
		if stored := readPlanQuotaColumn(t, runtimeID); stored != nil {
			t.Fatalf("invalid bodies stored plan_quota: %v", stored)
		}
	})

	t.Run("malformed body is a 400", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		// nil body encodes to an empty body, which fails JSON decoding.
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", nil, testWorkspaceID, "quota-push-daemon")
		req = withURLParam(req, "runtimeId", runtimeID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusBadRequest)
	})

	t.Run("cross-workspace daemon token is a 404", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{"status": "ok", "observed_at": time.Now().Unix()}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", body,
			"00000000-0000-0000-0000-000000000000", "attacker-daemon")
		req = withURLParam(req, "runtimeId", runtimeID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusNotFound)
	})

	t.Run("same-workspace daemon token for ANOTHER daemon is a 404", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{"status": "ok", "observed_at": time.Now().Unix()}
		// Workspace matches, but the token's daemon id does not own the
		// runtime: without this check any daemon in the workspace could
		// rewrite another machine's quota display.
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", body, testWorkspaceID, "other-daemon")
		req = withURLParam(req, "runtimeId", runtimeID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusNotFound)
		if stored := readPlanQuotaColumn(t, runtimeID); stored != nil {
			t.Fatalf("cross-daemon push stored plan_quota: %v", stored)
		}
	})

	t.Run("runtime owner's user token may push", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{"status": "limited", "observed_at": time.Now().Unix()}
		req := newRequestAsUser(testUserID, http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", body)
		req = withURLParam(req, "runtimeId", runtimeID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusOK)
		stored := readPlanQuotaColumn(t, runtimeID)
		if stored == nil || stored["status"] != "limited" {
			t.Fatalf("stored = %v after owner push", stored)
		}
	})

	t.Run("non-owner user token is a 404", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{"status": "ok", "observed_at": time.Now().Unix()}
		// A workspace member who does not own the runtime must not be able
		// to overwrite what everyone sees for it.
		req := newRequestAsUser("00000000-0000-0000-0000-00000000beef", http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", body)
		req = withURLParam(req, "runtimeId", runtimeID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusNotFound)
	})

	t.Run("unknown runtime is a 404", func(t *testing.T) {
		missingID := "00000000-0000-0000-0000-000000000001"
		body := map[string]any{"status": "ok", "observed_at": time.Now().Unix()}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+missingID+"/quota", body, testWorkspaceID, "quota-push-daemon")
		req = withURLParam(req, "runtimeId", missingID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusNotFound)
	})
}

// TestApplyRuntimePlanQuotaClearMarkerGuard pins the S2b rule: a windowless
// snapshot is a clear marker ("back to not reported") and may only overwrite
// a row that is empty or already belongs to the same provider+source — never
// another source's live data.
func TestApplyRuntimePlanQuotaClearMarkerGuard(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()

	clearMarker := func(provider, source string, observedAt int64) *protocol.RuntimePlanQuota {
		return &protocol.RuntimePlanQuota{
			Provider:   provider,
			Status:     protocol.PlanQuotaStatusOK,
			ObservedAt: observedAt,
			Source:     source,
		}
	}

	t.Run("clear lands on an empty row", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		rt := loadRuntime(t, runtimeID)
		updated, err := testHandler.applyRuntimePlanQuota(ctx, rt, clearMarker("zenmux", protocol.PlanQuotaSourceDaemon, 1000))
		if err != nil || !updated {
			t.Fatalf("clear on empty row: updated=%v err=%v", updated, err)
		}
		stored := readPlanQuotaColumn(t, runtimeID)
		if stored["provider"] != "zenmux" || stored["windows"] != nil {
			t.Fatalf("stored = %v", stored)
		}
	})

	t.Run("clear overwrites the same source's snapshot", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		rt := loadRuntime(t, runtimeID)
		if _, err := testHandler.applyRuntimePlanQuota(ctx, rt, &protocol.RuntimePlanQuota{
			Provider: "zenmux", Status: protocol.PlanQuotaStatusOK, ObservedAt: 1000, Source: protocol.PlanQuotaSourceDaemon,
			Windows: []protocol.RuntimePlanQuotaWindow{{Name: "primary"}},
		}); err != nil {
			t.Fatal(err)
		}
		updated, err := testHandler.applyRuntimePlanQuota(ctx, rt, clearMarker("zenmux", protocol.PlanQuotaSourceDaemon, 2000))
		if err != nil || !updated {
			t.Fatalf("clear on own row: updated=%v err=%v", updated, err)
		}
		if stored := readPlanQuotaColumn(t, runtimeID); stored["windows"] != nil || stored["observed_at"] != float64(2000) {
			t.Fatalf("stored = %v", stored)
		}
	})

	t.Run("clear cannot erase an external BYO snapshot", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		rt := loadRuntime(t, runtimeID)
		if _, err := testHandler.applyRuntimePlanQuota(ctx, rt, &protocol.RuntimePlanQuota{
			Provider: "zenmux", Status: protocol.PlanQuotaStatusOK, ObservedAt: 1000, Source: protocol.PlanQuotaSourceExternal,
			Windows: []protocol.RuntimePlanQuotaWindow{{Name: "primary"}},
		}); err != nil {
			t.Fatal(err)
		}
		updated, err := testHandler.applyRuntimePlanQuota(ctx, rt, clearMarker("zenmux", protocol.PlanQuotaSourceDaemon, 2000))
		if err != nil {
			t.Fatal(err)
		}
		if updated {
			t.Fatal("daemon clear overwrote an external snapshot")
		}
		stored := readPlanQuotaColumn(t, runtimeID)
		if stored["source"] != "external" || stored["windows"] == nil {
			t.Fatalf("external snapshot clobbered: %v", stored)
		}
	})

	t.Run("clear cannot erase another provider's snapshot", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		rt := loadRuntime(t, runtimeID)
		if _, err := testHandler.applyRuntimePlanQuota(ctx, rt, validPlanQuotaPayload(1000)); err != nil { // codex/daemon
			t.Fatal(err)
		}
		updated, err := testHandler.applyRuntimePlanQuota(ctx, rt, clearMarker("zenmux", protocol.PlanQuotaSourceDaemon, 2000))
		if err != nil {
			t.Fatal(err)
		}
		if updated {
			t.Fatal("zenmux clear overwrote a codex snapshot")
		}
		if stored := readPlanQuotaColumn(t, runtimeID); stored["provider"] != "codex" || stored["windows"] == nil {
			t.Fatalf("codex snapshot clobbered: %v", stored)
		}
	})

	t.Run("normal reports still supersede other sources", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		rt := loadRuntime(t, runtimeID)
		if _, err := testHandler.applyRuntimePlanQuota(ctx, rt, &protocol.RuntimePlanQuota{
			Provider: "kimi", Status: protocol.PlanQuotaStatusOK, ObservedAt: 1000, Source: protocol.PlanQuotaSourceExternal,
			Windows: []protocol.RuntimePlanQuotaWindow{{Name: "primary"}},
		}); err != nil {
			t.Fatal(err)
		}
		// A real daemon report (with windows) at a newer observed_at still
		// wins — the guard only constrains windowless clear markers.
		updated, err := testHandler.applyRuntimePlanQuota(ctx, rt, validPlanQuotaPayload(2000))
		if err != nil || !updated {
			t.Fatalf("normal write over external row: updated=%v err=%v", updated, err)
		}
	})

	t.Run("clear refresh stays throttleable", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		rt := loadRuntime(t, runtimeID)
		if _, err := testHandler.applyRuntimePlanQuota(ctx, rt, clearMarker("zenmux", protocol.PlanQuotaSourceDaemon, 1000)); err != nil {
			t.Fatal(err)
		}
		// Same empty content within the freshness window: no write.
		updated, err := testHandler.applyRuntimePlanQuota(ctx, rt, clearMarker("zenmux", protocol.PlanQuotaSourceDaemon, 1000+60))
		if err != nil {
			t.Fatal(err)
		}
		if updated {
			t.Fatal("clear refresh inside throttle window reported updated=true")
		}
		// Past the window the freshness refresh lands, so a held clear marker
		// never ages into the stale UI state while the daemon keeps sending it.
		updated, err = testHandler.applyRuntimePlanQuota(ctx, rt, clearMarker("zenmux", protocol.PlanQuotaSourceDaemon, 1000+planQuotaFreshnessThrottleSeconds+60))
		if err != nil || !updated {
			t.Fatalf("clear refresh past throttle: updated=%v err=%v", updated, err)
		}
	})
}
