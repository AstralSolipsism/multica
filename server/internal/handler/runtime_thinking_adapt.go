package handler

import (
	"context"
	"log/slog"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/agent"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// validateThinkingAdapt checks a heartbeat thinking_adapt snapshot: a known
// status and a usable recency stamp. The stamp (updated_at, RFC3339) drives
// the set-if-newer comparison, so a missing or wildly-future value must be
// rejected rather than pinned over every later sample.
func validateThinkingAdapt(snap *protocol.ThinkingAdaptSnapshot, now time.Time) error {
	switch snap.Status {
	case jev.StatusIdle, jev.StatusAvailable, jev.StatusDegraded, jev.StatusUnavailable:
	default:
		return errThinkingAdapt("unknown status")
	}
	if snap.UpdatedAt.IsZero() {
		return errThinkingAdapt("missing updated_at")
	}
	if snap.UpdatedAt.After(now.Add(hostMetricsMaxFutureSkew)) {
		return errThinkingAdapt("updated_at too far in the future")
	}
	return nil
}

type errThinkingAdapt string

func (e errThinkingAdapt) Error() string { return "thinking adapt: " + string(e) }

// storeHeartbeatThinkingAdapt hands a heartbeat thinking_adapt snapshot to
// the store and, when its content changes, publishes runtime:telemetry_updated
// (throttled per machine exactly like host metrics). Same non-fatal contract
// as storeHeartbeatMetrics: failures are logged and swallowed.
func (h *Handler) storeHeartbeatThinkingAdapt(ctx context.Context, workspaceID, daemonID string, snap *protocol.ThinkingAdaptSnapshot) {
	h.storeHeartbeatThinkingAdaptAt(ctx, workspaceID, daemonID, snap, time.Now())
}

func (h *Handler) storeHeartbeatThinkingAdaptAt(ctx context.Context, workspaceID, daemonID string, snap *protocol.ThinkingAdaptSnapshot, now time.Time) {
	if snap == nil {
		return
	}
	if daemonID == "" {
		slog.Debug("heartbeat thinking_adapt dropped: runtime has no daemon id", "workspace_id", workspaceID)
		return
	}
	if !h.ThinkingAdaptStore.Available() {
		return
	}
	if err := validateThinkingAdapt(snap, now); err != nil {
		slog.Debug("heartbeat thinking_adapt dropped: invalid",
			"workspace_id", workspaceID, "daemon_id", daemonID, "error", err)
		return
	}
	_, storedKey, err := h.ThinkingAdaptStore.PutIfNewer(ctx, MachineRef{WorkspaceID: workspaceID, DaemonID: daemonID}, snap)
	if err != nil {
		slog.Warn("heartbeat thinking_adapt store failed",
			"workspace_id", workspaceID, "daemon_id", daemonID, "error", err)
		return
	}
	if storedKey == "" {
		return
	}
	if h.hostMetricsPublish == nil || !h.hostMetricsPublish.shouldPublish(workspaceID+":"+daemonID, "ta:"+storedKey, now) {
		return
	}
	h.publish(protocol.EventRuntimeTelemetryUpdated, workspaceID, "system", "", map[string]any{
		"daemon_id": daemonID,
	})
}

// thinkingAdaptForRuntimes reads the latest snapshots for the machines
// behind runtimes, keyed by daemon id. Mirrors systemStatsForRuntimes.
func (h *Handler) thinkingAdaptForRuntimes(ctx context.Context, workspaceID string, runtimes []db.AgentRuntime) map[string]*protocol.ThinkingAdaptSnapshot {
	out := map[string]*protocol.ThinkingAdaptSnapshot{}
	if !h.ThinkingAdaptStore.Available() || len(runtimes) == 0 {
		return out
	}
	seen := map[string]bool{}
	refs := make([]MachineRef, 0, len(runtimes))
	for _, rt := range runtimes {
		if !rt.DaemonID.Valid || rt.DaemonID.String == "" || seen[rt.DaemonID.String] {
			continue
		}
		seen[rt.DaemonID.String] = true
		refs = append(refs, MachineRef{WorkspaceID: workspaceID, DaemonID: rt.DaemonID.String})
	}
	for ref, snap := range h.ThinkingAdaptStore.GetBatch(ctx, refs) {
		out[ref.DaemonID] = snap
	}
	return out
}

// thinkingAdaptForRuntime reports whether a runtime row may expose the
// thinking_adapt field: only providers with an effort dial at all
// (contract §8) — mirrors the daemon-side attachment rule.
func thinkingAdaptForRuntime(provider string) bool {
	return agent.ThinkingControlSupported(provider)
}
