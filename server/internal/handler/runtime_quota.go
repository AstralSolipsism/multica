package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// planQuotaMaxFutureSkew bounds how far a snapshot's observed_at may run
// ahead of the server clock. Without it one reporter with a bad clock could
// pin the row to a far-future observed_at and suppress every later snapshot
// (the conditional write is "newer observed_at wins").
const planQuotaMaxFutureSkew = 10 * time.Minute

// planQuotaFreshnessThrottle caps how often a snapshot whose CONTENT is
// unchanged (only observed_at moved — e.g. an external poller re-observing
// the same values) rewrites the row. Content changes always write
// immediately; freshness-only refreshes land at most once per window.
const planQuotaFreshnessThrottleSeconds = 300

// validateRuntimePlanQuota normalizes and validates an incoming plan-quota
// snapshot against the wire contract. On success the quota's Status is
// normalized ("ok" when empty) and nil is returned; any violation is a hard
// error — callers either reject the request (push endpoint) or drop the
// field (heartbeat).
//
// Provider defaulting is NOT done here: the heartbeat requires the daemon
// to name its provider, while the push endpoint defaults it from the
// runtime row before calling this.
func validateRuntimePlanQuota(q *protocol.RuntimePlanQuota, now time.Time) error {
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
	if q.ObservedAt > now.Add(planQuotaMaxFutureSkew).Unix() {
		return errors.New("plan quota: observed_at is too far in the future")
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
		if len(w.Group) > protocol.PlanQuotaMaxGroupName {
			return fmt.Errorf("plan quota: window %q group must be at most %d chars", w.Name, protocol.PlanQuotaMaxGroupName)
		}
	}
	return nil
}

// applyRuntimePlanQuota persists a validated plan-quota snapshot through the
// conditional write (newer observed_at wins, content-change or throttled
// freshness refresh) and, only when the row actually changed, broadcasts
// runtime:telemetry_updated so clients refetch runtime state. The
// workspaceID comes from the runtime row, never from the request payload.
func (h *Handler) applyRuntimePlanQuota(ctx context.Context, rt db.AgentRuntime, quota *protocol.RuntimePlanQuota) (bool, error) {
	body, err := json.Marshal(quota)
	if err != nil {
		return false, fmt.Errorf("marshal plan quota: %w", err)
	}
	// The content-only comparison payload: same snapshot minus observed_at,
	// so a re-observation of unchanged values can be told apart from a real
	// change without jsonb arithmetic on the SQL parameter (which sqlc's
	// named-parameter rewriter cannot express).
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return false, fmt.Errorf("decode plan quota: %w", err)
	}
	delete(decoded, "observed_at")
	content, err := json.Marshal(decoded)
	if err != nil {
		return false, fmt.Errorf("marshal plan quota content: %w", err)
	}
	rows, err := h.Queries.UpdateAgentRuntimePlanQuota(ctx, db.UpdateAgentRuntimePlanQuotaParams{
		ID:              rt.ID,
		PlanQuota:       body,
		ObservedAt:      quota.ObservedAt,
		Content:         content,
		FreshnessBefore: quota.ObservedAt - planQuotaFreshnessThrottleSeconds,
	})
	if err != nil {
		return false, fmt.Errorf("update plan quota: %w", err)
	}
	if rows == 0 {
		// Stale observed_at, unchanged content within the freshness window —
		// nothing to announce.
		return false, nil
	}
	h.publish(protocol.EventRuntimeTelemetryUpdated, uuidToString(rt.WorkspaceID), "system", "", map[string]any{
		"runtime_id": uuidToString(rt.ID),
	})
	return true, nil
}

// storeHeartbeatPlanQuota is the heartbeat-path entry point: a malformed
// plan_quota field must never fail the beat, so validation and persistence
// failures are logged at debug and swallowed. The daemon's own observations
// always win the source label, whatever the payload claims.
func (h *Handler) storeHeartbeatPlanQuota(ctx context.Context, rt db.AgentRuntime, quota *protocol.RuntimePlanQuota) {
	if quota == nil {
		return
	}
	quota.Source = protocol.PlanQuotaSourceDaemon
	if err := validateRuntimePlanQuota(quota, time.Now()); err != nil {
		slog.Debug("heartbeat plan_quota dropped: invalid",
			"runtime_id", uuidToString(rt.ID), "error", err)
		return
	}
	if _, err := h.applyRuntimePlanQuota(ctx, rt, quota); err != nil {
		slog.Warn("heartbeat plan_quota persist failed",
			"runtime_id", uuidToString(rt.ID), "error", err)
	}
}

// requireRuntimeQuotaPushAccess authorizes the external quota push endpoint.
// It is deliberately stricter than requireDaemonRuntimeAccess (which any
// workspace member's PAT passes): a quota snapshot overwrites what every
// workspace member sees for that runtime, so writes are limited to
//
//   - the mdt_ daemon token matching the runtime's workspace AND daemon id
//     (daemon ids are machine-provided and not globally unique), or
//   - the runtime owner's user token (PAT/JWT), still membership-checked.
//
// Everything else gets a 404 — the same "not found" the workspace check
// returns — so the endpoint does not confirm a runtime id exists.
func (h *Handler) requireRuntimeQuotaPushAccess(w http.ResponseWriter, r *http.Request, rt db.AgentRuntime) bool {
	if middleware.DaemonAuthPathFromContext(r.Context()) == middleware.DaemonAuthPathDaemonToken {
		// The token's workspace AND daemon id must both match the runtime:
		// daemon ids are machine-provided strings and can collide (or be
		// reused) across workspaces, so neither factor alone is sufficient.
		if middleware.DaemonWorkspaceIDFromContext(r.Context()) != uuidToString(rt.WorkspaceID) ||
			!rt.DaemonID.Valid ||
			!strings.EqualFold(rt.DaemonID.String, middleware.DaemonIDFromContext(r.Context())) {
			writeError(w, http.StatusNotFound, "not found")
			return false
		}
		return true
	}
	userID := requestUserID(r)
	if userID == "" || !rt.OwnerID.Valid || uuidToString(rt.OwnerID) != userID {
		writeError(w, http.StatusNotFound, "not found")
		return false
	}
	_, ok := h.requireWorkspaceMember(w, r, uuidToString(rt.WorkspaceID), "not found")
	return ok
}

// runtimeQuotaPushMaxBody caps the push endpoint's request body. The largest
// legitimate snapshot (8 windows) is well under 2KB; 32KB leaves headroom
// without letting a caller stream garbage into the decoder.
const runtimeQuotaPushMaxBody = 32 << 10

// ReportRuntimeQuota handles POST /api/daemon/runtimes/{runtimeId}/quota —
// the external push endpoint for plan-quota snapshots (the BYO extension
// surface: built-in providers report through the daemon heartbeat instead).
// Write access is restricted to the runtime's own daemon token or the
// runtime owner's user token. The payload is validated, its source is
// forced to "external", the provider defaults from the runtime row, and the
// write is the same conditional observed_at-wins update the heartbeat path
// uses.
func (h *Handler) ReportRuntimeQuota(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, runtimeQuotaPushMaxBody)
	var quota protocol.RuntimePlanQuota
	if err := json.NewDecoder(r.Body).Decode(&quota); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	runtimeUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "runtimeId"), "runtime_id")
	if !ok {
		return
	}
	rt, err := h.getAgentRuntime(r.Context(), obsmetrics.RuntimeLookupSourceDaemonAPI, runtimeUUID)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "runtime not found")
			return
		}
		slog.Warn("get agent runtime failed", "runtime_id", chi.URLParam(r, "runtimeId"), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load runtime")
		return
	}
	if !h.requireRuntimeQuotaPushAccess(w, r, rt) {
		return
	}

	quota.Source = protocol.PlanQuotaSourceExternal
	if quota.Provider == "" {
		quota.Provider = rt.Provider
	}
	if err := validateRuntimePlanQuota(&quota, time.Now()); err != nil {
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
