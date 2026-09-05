package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemonws"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// fakeMachineMetricsStore records Put calls so heartbeat tests can assert
// what would have landed in Redis without running one.
type fakeMachineMetricsStore struct {
	mu       sync.Mutex
	puts     map[string]*protocol.HostMetrics
	samples  map[string]*protocol.HostMetrics
	putCalls int
}

func (f *fakeMachineMetricsStore) Available() bool { return true }

func (f *fakeMachineMetricsStore) Put(_ context.Context, daemonID string, metrics *protocol.HostMetrics) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.putCalls++
	if f.puts == nil {
		f.puts = map[string]*protocol.HostMetrics{}
	}
	f.puts[daemonID] = metrics
	return nil
}

func (f *fakeMachineMetricsStore) GetBatch(_ context.Context, daemonIDs []string) map[string]*protocol.HostMetrics {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]*protocol.HostMetrics{}
	for _, id := range daemonIDs {
		if sample, ok := f.samples[id]; ok {
			out[id] = sample
		}
	}
	return out
}

func (f *fakeMachineMetricsStore) putCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.putCalls
}

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

func validPlanLimitsPayload(observedAt int64) *protocol.RuntimePlanQuota {
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
// normalization, and the required fields.
func TestValidateRuntimePlanQuota(t *testing.T) {
	t.Parallel()

	t.Run("valid payload normalizes empty status", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		q.Status = ""
		if err := validateRuntimePlanQuota(q); err != nil {
			t.Fatalf("validate: %v", err)
		}
		if q.Status != protocol.PlanQuotaStatusOK {
			t.Fatalf("status = %q, want ok", q.Status)
		}
	})

	t.Run("provider required", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		q.Provider = ""
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for empty provider")
		}
	})

	t.Run("observed_at must be positive", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(0)
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for observed_at=0")
		}
	})

	t.Run("bogus status rejected", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		q.Status = "exhausted"
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for unknown status")
		}
	})

	t.Run("too many windows", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		for len(q.Windows) < protocol.PlanQuotaMaxWindows+1 {
			q.Windows = append(q.Windows, protocol.RuntimePlanQuotaWindow{Name: "w"})
		}
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for >8 windows")
		}
	})

	t.Run("window name bounds", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		q.Windows[0].Name = ""
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for empty window name")
		}
		q.Windows[0].Name = strings.Repeat("x", protocol.PlanQuotaMaxWindowName+1)
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for oversized window name")
		}
	})

	t.Run("window minutes range", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		zero := int64(0)
		q.Windows[0].WindowMinutes = &zero
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for window_minutes=0")
		}
		over := int64(protocol.PlanQuotaMaxWindowMinutes + 1)
		q.Windows[0].WindowMinutes = &over
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for oversized window_minutes")
		}
	})

	t.Run("used percent range", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		negative := -1.0
		q.Windows[0].UsedPercent = &negative
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for negative used_percent")
		}
		over := float64(protocol.PlanQuotaMaxUsedPercent + 1)
		q.Windows[0].UsedPercent = &over
		if err := validateRuntimePlanQuota(q); err == nil {
			t.Fatal("expected error for oversized used_percent")
		}
	})

	t.Run("real zero values are accepted", func(t *testing.T) {
		t.Parallel()
		q := validPlanLimitsPayload(100)
		zeroPercent := 0.0
		q.Windows[0].UsedPercent = &zeroPercent
		if err := validateRuntimePlanQuota(q); err != nil {
			t.Fatalf("validate: %v", err)
		}
	})
}

// TestApplyRuntimePlanQuotaConditionalWrite drives the SQL contract directly:
// write-on-change, newer observed_at wins, stale rejected.
func TestApplyRuntimePlanQuotaConditionalWrite(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
	rt := loadRuntime(t, runtimeID)
	ctx := context.Background()

	// First write lands.
	updated, err := testHandler.applyRuntimePlanQuota(ctx, rt, validPlanLimitsPayload(1000))
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if !updated {
		t.Fatal("first write reported updated=false")
	}
	stored := readPlanQuotaColumn(t, runtimeID)
	if stored["observed_at"] != float64(1000) || stored["provider"] != "codex" {
		t.Fatalf("stored = %v", stored)
	}

	// Byte-identical rewrite is a no-op (write-on-change).
	updated, err = testHandler.applyRuntimePlanQuota(ctx, rt, validPlanLimitsPayload(1000))
	if err != nil {
		t.Fatalf("identical apply: %v", err)
	}
	if updated {
		t.Fatal("identical payload reported updated=true")
	}

	// Older observed_at is rejected; the stored snapshot is untouched.
	updated, err = testHandler.applyRuntimePlanQuota(ctx, rt, validPlanLimitsPayload(500))
	if err != nil {
		t.Fatalf("stale apply: %v", err)
	}
	if updated {
		t.Fatal("stale observed_at reported updated=true")
	}
	if got := readPlanQuotaColumn(t, runtimeID)["observed_at"]; got != float64(1000) {
		t.Fatalf("stored observed_at = %v, want 1000 after stale write", got)
	}

	// Newer observed_at with a changed payload lands.
	fresh := validPlanLimitsPayload(1500)
	fresh.Status = protocol.PlanQuotaStatusLimited
	updated, err = testHandler.applyRuntimePlanQuota(ctx, rt, fresh)
	if err != nil {
		t.Fatalf("fresh apply: %v", err)
	}
	if !updated {
		t.Fatal("newer payload reported updated=false")
	}
	stored = readPlanQuotaColumn(t, runtimeID)
	if stored["observed_at"] != float64(1500) || stored["status"] != "limited" {
		t.Fatalf("stored = %v", stored)
	}
}

// TestDaemonHeartbeatPlanLimits pins the heartbeat integration: a valid
// plan_limits field is stored with source forced to "daemon" even when the
// body claims otherwise, and an invalid field is dropped without failing
// the beat.
func TestDaemonHeartbeatPlanLimits(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	t.Run("valid field stored with daemon source", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			"runtime_id": runtimeID,
			"plan_limits": map[string]any{
				"provider":    "codex",
				"status":      "ok",
				"windows":     []map[string]any{{"name": "primary", "used_percent": 42.5, "window_minutes": 300}},
				"observed_at": 1757000100,
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
		if stored["observed_at"] != float64(1757000100) {
			t.Fatalf("stored observed_at = %v", stored["observed_at"])
		}
	})

	t.Run("invalid field dropped, beat still acked", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			"runtime_id": runtimeID,
			"plan_limits": map[string]any{
				"provider":    "codex",
				"status":      "ok",
				"observed_at": 0, // invalid: must be positive
			},
		}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, "quota-heartbeat-daemon")
		testutil.Call(t, testHandler.DaemonHeartbeat, req).Want(http.StatusOK)

		if stored := readPlanQuotaColumn(t, runtimeID); stored != nil {
			t.Fatalf("invalid plan_limits was stored: %v", stored)
		}
	})
}

// TestDaemonHeartbeatMetrics pins the metrics half of the beat: valid samples
// reach the MachineMetricsStore keyed by daemon id; invalid ones are dropped
// without failing the beat.
func TestDaemonHeartbeatMetrics(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	fake := &fakeMachineMetricsStore{}
	orig := testHandler.MachineMetricsStore
	testHandler.MachineMetricsStore = fake
	t.Cleanup(func() { testHandler.MachineMetricsStore = orig })

	t.Run("valid sample stored by daemon id", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		rt := loadRuntime(t, runtimeID)
		body := map[string]any{
			"runtime_id": runtimeID,
			"metrics":    map[string]any{"cpu_percent": 42.0, "memory_percent": 68.0, "captured_at": 1757000100},
		}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, "quota-heartbeat-daemon")
		testutil.Call(t, testHandler.DaemonHeartbeat, req).Want(http.StatusOK)

		fake.mu.Lock()
		sample := fake.puts[rt.DaemonID.String]
		fake.mu.Unlock()
		if sample == nil {
			t.Fatalf("no metrics stored for daemon %q", rt.DaemonID.String)
		}
		if sample.CPUPercent == nil || *sample.CPUPercent != 42.0 || sample.MemoryPercent == nil || *sample.MemoryPercent != 68.0 {
			t.Fatalf("sample = %+v", sample)
		}
	})

	t.Run("out-of-range percent dropped", func(t *testing.T) {
		before := fake.putCount()
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			"runtime_id": runtimeID,
			"metrics":    map[string]any{"cpu_percent": 150.0, "captured_at": 1757000100},
		}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, "quota-heartbeat-daemon")
		testutil.Call(t, testHandler.DaemonHeartbeat, req).Want(http.StatusOK)
		if got := fake.putCount(); got != before {
			t.Fatalf("invalid metrics stored: put calls %d -> %d", before, got)
		}
	})
}

// TestHandleDaemonWSHeartbeatPlanLimits covers the WebSocket twin: extras on
// the WS payload take the lease path to the same storage.
func TestHandleDaemonWSHeartbeatPlanLimits(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	fake := &fakeMachineMetricsStore{}
	orig := testHandler.MachineMetricsStore
	testHandler.MachineMetricsStore = fake
	t.Cleanup(func() { testHandler.MachineMetricsStore = orig })

	runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
	rt := loadRuntime(t, runtimeID)
	identity := daemonws.ClientIdentity{
		WorkspaceID: testWorkspaceID,
		RuntimeLeases: map[string]*daemonws.RuntimeLease{
			runtimeID: daemonws.NewRuntimeLease(testWorkspaceID, "online", time.Now(), true).
				WithDaemonID(rt.DaemonID.String),
		},
	}
	cpuPercent := 12.5
	payload := protocol.DaemonHeartbeatRequestPayload{
		RuntimeID:  runtimeID,
		PlanLimits: validPlanLimitsPayload(1757000200),
		Metrics:    &protocol.HostMetrics{CPUPercent: &cpuPercent, CapturedAt: 1757000200},
	}
	ack, err := testHandler.HandleDaemonWSHeartbeat(context.Background(), identity, payload)
	if err != nil {
		t.Fatalf("HandleDaemonWSHeartbeat: %v", err)
	}
	if ack == nil || ack.Status != "ok" {
		t.Fatalf("ack = %+v", ack)
	}

	stored := readPlanQuotaColumn(t, runtimeID)
	if stored == nil || stored["observed_at"] != float64(1757000200) {
		t.Fatalf("plan_quota = %v after WS heartbeat", stored)
	}
	fake.mu.Lock()
	sample := fake.puts[rt.DaemonID.String]
	fake.mu.Unlock()
	if sample == nil || sample.CPUPercent == nil || *sample.CPUPercent != 12.5 {
		t.Fatalf("metrics sample = %+v after WS heartbeat", sample)
	}
}

// TestReportRuntimeQuota covers the external push endpoint: happy path with
// provider defaulting and forced external source, stale/unchanged acks,
// validation 400s, and workspace auth.
func TestReportRuntimeQuota(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	newQuotaRequest := func(runtimeID string, body map[string]any) *http.Request {
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", body, testWorkspaceID, "quota-push-daemon")
		return withURLParam(req, "runtimeId", runtimeID)
	}

	t.Run("happy path defaults provider and forces external source", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		body := map[string]any{
			// No provider: the runtime row's provider must fill in.
			"status":      "ok",
			"windows":     []map[string]any{{"name": "primary", "used_percent": 42.5, "window_minutes": 300, "resets_at": 1757000000}},
			"observed_at": 1757000100,
			"source":      "daemon", // must be overridden to external
		}
		w := testutil.Call(t, testHandler.ReportRuntimeQuota, newQuotaRequest(runtimeID, body)).Want(http.StatusOK)
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
		freshBody := map[string]any{"status": "ok", "observed_at": 2000}
		testutil.Call(t, testHandler.ReportRuntimeQuota, newQuotaRequest(runtimeID, freshBody)).Want(http.StatusOK)

		staleBody := map[string]any{"status": "limited", "observed_at": 1000}
		w := testutil.Call(t, testHandler.ReportRuntimeQuota, newQuotaRequest(runtimeID, staleBody)).Want(http.StatusOK)
		var resp map[string]any
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode ack: %v", err)
		}
		if resp["updated"] != false {
			t.Fatalf("ack = %v, want updated=false", resp)
		}
		if got := readPlanQuotaColumn(t, runtimeID)["observed_at"]; got != float64(2000) {
			t.Fatalf("stored observed_at = %v, want 2000", got)
		}
	})

	t.Run("validation failure is a 400", func(t *testing.T) {
		runtimeID := createRuntimeLocalSkillTestRuntime(t, testUserID)
		for name, body := range map[string]map[string]any{
			"missing observed_at": {"status": "ok"},
			"bad status":          {"status": "throttled", "observed_at": 1000},
			"empty window name":   {"status": "ok", "observed_at": 1000, "windows": []map[string]any{{"name": ""}}},
			"too many windows": {"status": "ok", "observed_at": 1000, "windows": []map[string]any{
				{"name": "1"}, {"name": "2"}, {"name": "3"}, {"name": "4"},
				{"name": "5"}, {"name": "6"}, {"name": "7"}, {"name": "8"}, {"name": "9"},
			}},
		} {
			t.Run(name, func(t *testing.T) {
				testutil.Call(t, testHandler.ReportRuntimeQuota, newQuotaRequest(runtimeID, body)).Want(http.StatusBadRequest)
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
		body := map[string]any{"status": "ok", "observed_at": 1000}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/quota", body,
			"00000000-0000-0000-0000-000000000000", "attacker-daemon")
		req = withURLParam(req, "runtimeId", runtimeID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusNotFound)
	})

	t.Run("unknown runtime is a 404", func(t *testing.T) {
		missingID := "00000000-0000-0000-0000-000000000001"
		body := map[string]any{"status": "ok", "observed_at": 1000}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+missingID+"/quota", body, testWorkspaceID, "quota-push-daemon")
		req = withURLParam(req, "runtimeId", missingID)
		testutil.Call(t, testHandler.ReportRuntimeQuota, req).Want(http.StatusNotFound)
	})
}

// TestNoopMachineMetricsStore pins the disabled-store contract the handler
// relies on when Redis is not wired.
func TestNoopMachineMetricsStore(t *testing.T) {
	t.Parallel()
	store := NewNoopMachineMetricsStore()
	if store.Available() {
		t.Fatal("noop store reports available")
	}
	if err := store.Put(context.Background(), "daemon-1", &protocol.HostMetrics{}); err != nil {
		t.Fatalf("noop Put: %v", err)
	}
	if got := store.GetBatch(context.Background(), []string{"daemon-1"}); got != nil {
		t.Fatalf("noop GetBatch = %v, want nil", got)
	}
}
