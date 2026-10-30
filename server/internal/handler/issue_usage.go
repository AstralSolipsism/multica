package handler

import (
	"net/http"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// IssueUsageRowResponse mirrors ListWorkspaceIssueUsageRow. The five
// cost-split fields are pointers: on a row where nothing was priced
// (cost_usd_ticks == 0 AND every uncosted_* equals its total) they are nil and
// omitted from the JSON. Clients already treat their absence as "all tokens
// uncosted" — the version-drift fallback in runtimes/utils.ts uncostedTokens —
// so omitting them halves the row size without changing what any client
// computes. Rows with a real reported cost or a partial split keep the fields,
// preserving the distinction between zero-cost and unpriced.
type IssueUsageRowResponse struct {
	IssueID                  string `json:"issue_id"`
	Provider                 string `json:"provider"`
	Model                    string `json:"model"`
	InputTokens              int64  `json:"input_tokens"`
	OutputTokens             int64  `json:"output_tokens"`
	CacheReadTokens          int64  `json:"cache_read_tokens"`
	CacheWriteTokens         int64  `json:"cache_write_tokens"`
	CostUsdTicks             *int64 `json:"cost_usd_ticks,omitempty"`
	UncostedInputTokens      *int64 `json:"uncosted_input_tokens,omitempty"`
	UncostedOutputTokens     *int64 `json:"uncosted_output_tokens,omitempty"`
	UncostedCacheReadTokens  *int64 `json:"uncosted_cache_read_tokens,omitempty"`
	UncostedCacheWriteTokens *int64 `json:"uncosted_cache_write_tokens,omitempty"`
}

func issueUsageRowToResponse(r db.ListWorkspaceIssueUsageRow) IssueUsageRowResponse {
	resp := IssueUsageRowResponse{
		IssueID:          uuidToString(r.IssueID),
		Provider:         r.Provider,
		Model:            r.Model,
		InputTokens:      r.InputTokens,
		OutputTokens:     r.OutputTokens,
		CacheReadTokens:  r.CacheReadTokens,
		CacheWriteTokens: r.CacheWriteTokens,
	}
	if r.CostUsdTicks == 0 &&
		r.UncostedInputTokens == r.InputTokens &&
		r.UncostedOutputTokens == r.OutputTokens &&
		r.UncostedCacheReadTokens == r.CacheReadTokens &&
		r.UncostedCacheWriteTokens == r.CacheWriteTokens {
		return resp
	}
	resp.CostUsdTicks = &r.CostUsdTicks
	resp.UncostedInputTokens = &r.UncostedInputTokens
	resp.UncostedOutputTokens = &r.UncostedOutputTokens
	resp.UncostedCacheReadTokens = &r.UncostedCacheReadTokens
	resp.UncostedCacheWriteTokens = &r.UncostedCacheWriteTokens
	return resp
}

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
	resp := make([]IssueUsageRowResponse, len(rows))
	for i, row := range rows {
		resp[i] = issueUsageRowToResponse(row)
	}
	writeJSON(w, http.StatusOK, resp)
}
