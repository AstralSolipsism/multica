package handler

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Read the current switch after the status endpoint's workspace authorization.
// No optional task-source lookup belongs on this hot path. The daemon ignores
// this workspace-wide signal for runs that did not install the mod.
func (h *Handler) labrastroYSKTaskEnabled(r *http.Request, workspaceID pgtype.UUID) *bool {
	if !requestHasClientCapability(r, protocol.DaemonCapabilityYouShouldKnowV1) {
		return nil
	}
	enabled, err := h.Queries.LabrastroYSKWorkspaceEnabled(r.Context(), workspaceID)
	if err != nil {
		// A YSK lookup failure must not hide the task status or turn into the
		// 404 deletion signal that interrupts the main agent.
		slog.Warn("ysk: status switch omitted", "workspace_id", uuidToString(workspaceID), "error", err)
		return nil
	}
	return &enabled
}
