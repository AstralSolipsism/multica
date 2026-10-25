package handler

import (
	"net/http"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ListWorkspaceIssueUsage returns metered issues only, in one aggregate query.
func (h *Handler) ListWorkspaceIssueUsage(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	rows, err := h.Queries.ListWorkspaceIssueUsage(r.Context(), member.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list issue usage")
		return
	}
	if rows == nil {
		rows = []db.ListWorkspaceIssueUsageRow{}
	}
	writeJSON(w, http.StatusOK, rows)
}
