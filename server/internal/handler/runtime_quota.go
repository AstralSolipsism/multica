package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// validateRuntimePlanQuota normalizes and validates an incoming plan-quota
// snapshot against the wire contract. On success the quota's Status is
// normalized ("ok" when empty) and nil is returned; any violation is a hard
// error — callers either reject the request (push endpoint) or drop the
// field (heartbeat).
//
// Provider defaulting is NOT done here: the heartbeat requires the daemon
// to name its provider, while the push endpoint defaults it from the
// runtime row before calling this.
func validateRuntimePlanQuota(q *protocol.RuntimePlanQuota) error {
	if q == nil {
		return errors.New("plan quota: missing body")
	}
	if q.Provider == "" {
		return errors.New("plan quota: provider is required")
	}
	switch q.Status {
	case "":
		q.Status = protocol.PlanQuotaStatusOK
	case protocol.PlanQuotaStatusOK, protocol.PlanQuotaStatusLimited:
	default:
		return fmt.Errorf("plan quota: unsupported status %q", q.Status)
	}
	if q.ObservedAt <= 0 {
		return errors.New("plan quota: observed_at must be positive unix seconds")
	}
	if len(q.Windows) > protocol.PlanQuotaMaxWindows {
		return fmt.Errorf("plan quota: at most %d windows allowed", protocol.PlanQuotaMaxWindows)
	}
	for i := range q.Windows {
		w := &q.Windows[i]
		if w.Name == "" || len(w.Name) > protocol.PlanQuotaMaxWindowName {
			return fmt.Errorf("plan quota: window %d name must be 1..%d chars", i, protocol.PlanQuotaMaxWindowName)
		}
		if w.WindowMinutes != nil && (*w.WindowMinutes <= 0 || *w.WindowMinutes > protocol.PlanQuotaMaxWindowMinutes) {
			return fmt.Errorf("plan quota: window %q window_minutes out of range", w.Name)
		}
		if w.UsedPercent != nil && (*w.UsedPercent < 0 || *w.UsedPercent > protocol.PlanQuotaMaxUsedPercent) {
			return fmt.Errorf("plan quota: window %q used_percent out of range", w.Name)
		}
	}
	return nil
}

// validateHostMetrics checks a heartbeat host-metrics sample. Percentages,
// when present, must be real percentages; a nil pointer means "not sampled"
// and is always acceptable.
func validateHostMetrics(m *protocol.HostMetrics) error {
	if m == nil {
		return errors.New("host metrics: missing body")
	}
	if m.CPUPercent != nil && (*m.CPUPercent < 0 || *m.CPUPercent > 100) {
		return errors.New("host metrics: cpu_percent out of range")
	}
	if m.MemoryPercent != nil && (*m.MemoryPercent < 0 || *m.MemoryPercent > 100) {
		return errors.New("host metrics: memory_percent out of range")
	}
	return nil
}

// applyRuntimePlanQuota persists a validated plan-quota snapshot through the
// conditional write (newer observed_at wins, write-on-change) and, only when
// the row actually changed, broadcasts the runtime-refresh event clients
// already listen to. The workspaceID comes from the runtime row, never from
// the request payload.
func (h *Handler) applyRuntimePlanQuota(ctx context.Context, rt db.AgentRuntime, quota *protocol.RuntimePlanQuota) (bool, error) {
	body, err := json.Marshal(quota)
	if err != nil {
		return false, fmt.Errorf("marshal plan quota: %w", err)
	}
	rows, err := h.Queries.UpdateAgentRuntimePlanQuota(ctx, db.UpdateAgentRuntimePlanQuotaParams{
		ID:         rt.ID,
		PlanQuota:  body,
		ObservedAt: quota.ObservedAt,
	})
	if err != nil {
		return false, fmt.Errorf("update plan quota: %w", err)
	}
	if rows == 0 {
		// Stale observed_at or byte-identical payload — nothing to announce.
		return false, nil
	}
	h.PublishRuntimeRefresh(uuidToString(rt.WorkspaceID), "system", "", "quota")
	return true, nil
}

// storeHeartbeatPlanLimits is the heartbeat-path entry point: a malformed
// plan_limits field must never fail the beat, so validation and persistence
// failures are logged at debug and swallowed. The daemon's own observations
// always win the source label, whatever the payload claims.
func (h *Handler) storeHeartbeatPlanLimits(ctx context.Context, rt db.AgentRuntime, quota *protocol.RuntimePlanQuota) {
	if quota == nil {
		return
	}
	quota.Source = protocol.PlanQuotaSourceDaemon
	if err := validateRuntimePlanQuota(quota); err != nil {
		slog.Debug("heartbeat plan_limits dropped: invalid",
			"runtime_id", uuidToString(rt.ID), "error", err)
		return
	}
	if _, err := h.applyRuntimePlanQuota(ctx, rt, quota); err != nil {
		slog.Warn("heartbeat plan_limits persist failed",
			"runtime_id", uuidToString(rt.ID), "error", err)
	}
}

// storeHeartbeatMetrics hands a heartbeat host-metrics sample to the metrics
// store. Same non-fatal contract as storeHeartbeatPlanLimits: the beat is
// acked regardless.
func (h *Handler) storeHeartbeatMetrics(ctx context.Context, runtimeID, daemonID string, metrics *protocol.HostMetrics) {
	if metrics == nil {
		return
	}
	if daemonID == "" {
		slog.Debug("heartbeat metrics dropped: runtime has no daemon id", "runtime_id", runtimeID)
		return
	}
	if !h.MachineMetricsStore.Available() {
		return
	}
	if err := validateHostMetrics(metrics); err != nil {
		slog.Debug("heartbeat metrics dropped: invalid",
			"runtime_id", runtimeID, "error", err)
		return
	}
	if err := h.MachineMetricsStore.Put(ctx, daemonID, metrics); err != nil {
		slog.Warn("heartbeat metrics store failed",
			"runtime_id", runtimeID, "error", err)
	}
}

// ReportRuntimeQuota handles POST /api/daemon/runtimes/{runtimeId}/quota —
// the external push endpoint for plan-quota snapshots. Auth is the daemon
// API's standard runtime access check, so both daemon tokens and workspace
// member PATs can report. The payload is validated, its source is forced to
// "external", the provider defaults from the runtime row, and the write is
// the same conditional observed_at-wins update the heartbeat path uses.
func (h *Handler) ReportRuntimeQuota(w http.ResponseWriter, r *http.Request) {
	var quota protocol.RuntimePlanQuota
	if err := json.NewDecoder(r.Body).Decode(&quota); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	rt, ok := h.requireDaemonRuntimeAccess(w, r, chi.URLParam(r, "runtimeId"))
	if !ok {
		return
	}

	quota.Source = protocol.PlanQuotaSourceExternal
	if quota.Provider == "" {
		quota.Provider = rt.Provider
	}
	if err := validateRuntimePlanQuota(&quota); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	updated, err := h.applyRuntimePlanQuota(r.Context(), rt, &quota)
	if err != nil {
		slog.Warn("report runtime quota failed", "runtime_id", uuidToString(rt.ID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to store plan quota")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "updated": updated})
}
