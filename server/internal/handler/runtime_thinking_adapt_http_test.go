package handler

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemonws"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// adaptRuntime inserts a runtime row on a specific daemon id and provider.
// The (workspace_id, daemon_id, provider) triple is unique, so callers vary
// provider or daemon per row.
func adaptRuntime(t *testing.T, daemonID, provider string) string {
	t.Helper()
	return dbfx.Runtime(t, "adapt-runtime-"+provider, testutil.Cols{
		"daemon_id":    daemonID,
		"runtime_mode": "local",
		"provider":     provider,
		"device_info":  "Thinking Adapt Test",
	})
}

// newThinkingAdaptTestHandler returns a shallow copy of the shared test
// handler wired to a real Redis thinking-adapt store plus an event capture.
func newThinkingAdaptTestHandler(t *testing.T) (*Handler, *[]string) {
	t.Helper()
	rdb := newRedisTestClient(t)
	h := *testHandler
	h.ThinkingAdaptStore = NewRedisThinkingAdaptStore(rdb)
	h.hostMetricsPublish = newHostMetricsPublishTracker()
	bus := events.New()
	var published []string
	bus.SubscribeAll(func(event events.Event) { published = append(published, event.Type) })
	h.Bus = bus
	return &h, &published
}

// TestDaemonHeartbeatThinkingAdapt covers the HTTP heartbeat path: the
// snapshot is stored under the runtime row's workspace + daemon, an invalid
// snapshot drops the field but the beat is still acked, and a store change
// publishes one telemetry event.
func TestDaemonHeartbeatThinkingAdapt(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	now := time.Now()

	t.Run("stored under the runtime row's workspace and daemon", func(t *testing.T) {
		h, published := newThinkingAdaptTestHandler(t)
		daemonID := fmt.Sprintf("adapt-daemon-%d", time.Now().UnixNano())
		runtimeID := adaptRuntime(t, daemonID, "claude")

		snap := protocol.ThinkingAdaptSnapshot{
			Status:        "available",
			ActiveSource:  "opencode-free",
			LastLatencyMS: 290,
			DecisionsOK:   8,
			Since:         now.Add(-time.Hour),
			UpdatedAt:     now,
		}
		body := map[string]any{
			"runtime_id":     runtimeID,
			"thinking_adapt": snap,
		}
		req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat", body, testWorkspaceID, daemonID)
		testutil.Call(t, h.DaemonHeartbeat, req).Want(http.StatusOK)

		got := h.ThinkingAdaptStore.GetBatch(context.Background(),
			[]MachineRef{{WorkspaceID: testWorkspaceID, DaemonID: daemonID}})
		stored := got[MachineRef{WorkspaceID: testWorkspaceID, DaemonID: daemonID}]
		if stored == nil || stored.Status != "available" || stored.DecisionsOK != 8 {
			t.Fatalf("stored snapshot = %+v", stored)
		}
		if len(*published) != 1 || (*published)[0] != protocol.EventRuntimeTelemetryUpdated {
			t.Fatalf("published = %v, want one %s", *published, protocol.EventRuntimeTelemetryUpdated)
		}
	})

	t.Run("invalid snapshot dropped, beat still acked", func(t *testing.T) {
		h, _ := newThinkingAdaptTestHandler(t)
		daemonID := fmt.Sprintf("adapt-bad-daemon-%d", time.Now().UnixNano())
		runtimeID := adaptRuntime(t, daemonID, "claude")

		for _, snap := range []map[string]any{
			{"status": "bogus", "updated_at": now.Format(time.RFC3339)},
			{"status": "idle"}, // missing updated_at
		} {
			req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/heartbeat",
				map[string]any{"runtime_id": runtimeID, "thinking_adapt": snap}, testWorkspaceID, daemonID)
			testutil.Call(t, h.DaemonHeartbeat, req).Want(http.StatusOK)
		}
		got := h.ThinkingAdaptStore.GetBatch(context.Background(),
			[]MachineRef{{WorkspaceID: testWorkspaceID, DaemonID: daemonID}})
		if len(got) != 0 {
			t.Fatalf("invalid snapshots stored: %v", got)
		}
	})
}

// TestHandleDaemonWSHeartbeatThinkingAdapt covers the WebSocket twin: the
// machine is keyed by the lease's workspace plus the runtime row's daemon id.
func TestHandleDaemonWSHeartbeatThinkingAdapt(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h, published := newThinkingAdaptTestHandler(t)

	daemonID := fmt.Sprintf("adapt-ws-daemon-%d", time.Now().UnixNano())
	runtimeID := adaptRuntime(t, daemonID, "claude")
	identity := daemonws.ClientIdentity{
		WorkspaceID: testWorkspaceID,
		// DaemonID intentionally empty: user-PAT daemon connections.
		RuntimeLeases: map[string]*daemonws.RuntimeLease{
			runtimeID: daemonws.NewRuntimeLease(testWorkspaceID, "online", time.Now(), true).WithDaemonID(daemonID),
		},
	}
	now := time.Now()
	payload := protocol.DaemonHeartbeatRequestPayload{
		RuntimeID: runtimeID,
		ThinkingAdapt: &protocol.ThinkingAdaptSnapshot{
			Status:    "idle",
			Since:     now,
			UpdatedAt: now,
		},
	}
	ack, err := h.HandleDaemonWSHeartbeat(context.Background(), identity, payload)
	if err != nil {
		t.Fatalf("HandleDaemonWSHeartbeat: %v", err)
	}
	if ack == nil || ack.Status != "ok" {
		t.Fatalf("ack = %+v", ack)
	}

	got := h.ThinkingAdaptStore.GetBatch(context.Background(),
		[]MachineRef{{WorkspaceID: testWorkspaceID, DaemonID: daemonID}})
	if stored := got[MachineRef{WorkspaceID: testWorkspaceID, DaemonID: daemonID}]; stored == nil || stored.Status != "idle" {
		t.Fatalf("stored snapshot = %+v", stored)
	}
	if len(*published) != 1 || (*published)[0] != protocol.EventRuntimeTelemetryUpdated {
		t.Fatalf("published = %v, want one %s", *published, protocol.EventRuntimeTelemetryUpdated)
	}
}

// TestListAgentRuntimesThinkingAdapt covers the read side: the field rides
// only rows whose provider has thinking control; everything else is null.
func TestListAgentRuntimesThinkingAdapt(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	h, _ := newThinkingAdaptTestHandler(t)
	now := time.Now()

	thinkingDaemon := fmt.Sprintf("adapt-list-think-%d", now.UnixNano())
	plainDaemon := fmt.Sprintf("adapt-list-plain-%d", now.UnixNano())
	thinkingRuntime := adaptRuntime(t, thinkingDaemon, "claude")
	plainRuntime := adaptRuntime(t, plainDaemon, "copilot")

	snap := protocol.ThinkingAdaptSnapshot{
		Status:       "available",
		ActiveSource: "self-hosted",
		Since:        now.Add(-time.Hour),
		UpdatedAt:    now,
	}
	for _, daemon := range []string{thinkingDaemon, plainDaemon} {
		if _, _, err := h.ThinkingAdaptStore.PutIfNewer(context.Background(),
			MachineRef{WorkspaceID: testWorkspaceID, DaemonID: daemon}, &snap); err != nil {
			t.Fatalf("seed %s: %v", daemon, err)
		}
	}

	w := testutil.Call(t, h.ListAgentRuntimes,
		newRequestAs(testUserID, http.MethodGet, "/api/runtimes", nil),
	).Want(http.StatusOK)
	var runtimes []AgentRuntimeResponse
	w.JSON(&runtimes)

	byID := map[string]AgentRuntimeResponse{}
	for _, rt := range runtimes {
		byID[rt.ID] = rt
	}
	got := byID[thinkingRuntime].ThinkingAdapt
	if got == nil || got.Status != "available" || got.ActiveSource != "self-hosted" {
		t.Fatalf("thinking-capable runtime thinking_adapt = %+v", got)
	}
	if plain := byID[plainRuntime].ThinkingAdapt; plain != nil {
		t.Fatalf("non-thinking runtime thinking_adapt = %+v, want nil", plain)
	}
}
