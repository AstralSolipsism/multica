package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// GetIssueGraph reuses the shared surface filter compiler, but reads one full
// MVCC snapshot. There is no list window, scheduled-only default or pagination.
func (h *Handler) GetIssueGraph(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	ws, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "workspaceId"), "workspace_id")
	if !ok {
		return
	}
	if uuidToString(ws) != h.resolveWorkspaceID(r) {
		writeDependencyError(w, &service.DependencyError{Code: "not_found", Message: "workspace not found"})
		return
	}
	user, ok := parseUUIDOrBadRequest(w, userID, "user_id")
	if !ok {
		return
	}
	for key := range r.URL.Query() {
		switch key {
		case "query", "project_id", "focus_issue_id", "workspace_id", "workspace_slug":
		default:
			writeError(w, http.StatusBadRequest, "unsupported graph parameter: "+key)
			return
		}
	}
	spec := issueTableQuerySpec{Scope: issueTableScope{Kind: "workspace"}}
	if raw := r.URL.Query().Get("query"); raw != "" {
		if len(raw) > 1<<20 {
			writeError(w, http.StatusBadRequest, "graph query is too large")
			return
		}
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&spec); err != nil || strings.TrimSpace(raw) == "null" {
			writeError(w, http.StatusBadRequest, "invalid graph query")
			return
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid graph query")
			return
		}
	}
	if projectID := r.URL.Query().Get("project_id"); projectID != "" {
		if spec.Scope.ProjectID != "" && spec.Scope.ProjectID != projectID {
			writeError(w, http.StatusBadRequest, "conflicting project scope")
			return
		}
		spec.Scope.Kind, spec.Scope.ProjectID = "project", projectID
	}
	if spec.Scope.Kind != "workspace" && spec.Scope.Kind != "project" {
		writeError(w, http.StatusBadRequest, "graph scope must be workspace or project")
		return
	}
	// Sorting is a display preference; compact topology uses stable ID order.
	spec.Sort = issueTableSortRequest{Field: "position", Direction: "asc"}
	snapshot, tx, err := h.beginIssueTableSnapshot(ctx)
	if err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	defer tx.Rollback(context.Background())
	access, err := snapshot.Queries.GetIssueGraphAccess(ctx, db.GetIssueGraphAccessParams{ID: ws, UserID: user})
	if errors.Is(err, pgx.ErrNoRows) {
		writeDependencyError(w, &service.DependencyError{Code: "not_found", Message: "workspace not found"})
		return
	}
	if err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	scope := service.IssueGraphScope{Type: spec.Scope.Kind}
	if spec.Scope.Kind == "project" {
		id, ok := parseUUIDOrBadRequest(w, spec.Scope.ProjectID, "project_id")
		if !ok {
			return
		}
		project, err := snapshot.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: id, WorkspaceID: ws})
		if errors.Is(err, pgx.ErrNoRows) {
			writeDependencyError(w, &service.DependencyError{Code: "not_found", Message: "project not found"})
			return
		}
		if err != nil {
			writeIssueGraphFailure(w, r, err)
			return
		}
		projectID := uuidToString(project.ID)
		scope.ProjectID = &projectID
	}
	var focus *string
	if raw := r.URL.Query().Get("focus_issue_id"); raw != "" {
		issue, ok := snapshot.loadDependencyIssue(w, r, raw)
		if !ok {
			return
		}
		id := uuidToString(issue.ID)
		focus = &id
	}
	compiled, ok := snapshot.compileIssueTableQuery(w, r, spec)
	if !ok {
		return
	}
	if focus != nil {
		compiled.args = append(compiled.args, *focus)
		compiled.where += " AND i.id = $" + strconv.Itoa(len(compiled.args)) + "::uuid"
	}
	rows, err := tx.Query(ctx, "SELECT i.id FROM issue i WHERE "+compiled.where, compiled.args...)
	if err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	matched := make(map[string]bool, len(ids))
	for _, id := range ids {
		matched[id] = true
	}
	deps, err := h.IssueService.Dependencies.Load(ctx, snapshot.Queries, ws)
	if err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	details, err := snapshot.Queries.ListIssueGraphDetails(ctx, ws)
	if err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	runs, err := snapshot.Queries.ListIssueGraphRuns(ctx, ws)
	if err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	runByIssue := make(map[string]service.IssueGraphRuns)
	for _, run := range runs {
		id := uuidToString(run.IssueID)
		summary := runByIssue[id]
		switch run.Status {
		case "queued":
			summary.Queued = run.Count
		case "dispatched":
			summary.Dispatched = run.Count
		case "running":
			summary.Running = run.Count
		case "waiting_local_directory":
			summary.WaitingLocalDirectory = run.Count
		}
		runByIssue[id] = summary
	}
	nodes := make([]service.IssueGraphNode, 0, len(details))
	projects := make(map[string]service.IssueGraphProject)
	for _, detail := range details {
		id := uuidToString(detail.ID)
		base := deps.Model.Issues[id]
		n := service.IssueGraphNode{ID: id, Title: base.Title, Identifier: access.IssuePrefix + "-" + strconv.Itoa(int(base.Number)), Status: base.Status, StatusCategory: base.Category, Revision: base.Revision, Priority: detail.Priority, RunSummary: runByIssue[id]}
		if base.ParentID != "" {
			n.ParentIssueID = &base.ParentID
		}
		if detail.Stage.Valid {
			n.Stage = &detail.Stage.Int32
		}
		if detail.ProjectID.Valid {
			if !detail.ProjectTitle.Valid {
				writeDependencyError(w, &service.DependencyError{Code: "dependency_data_unverified", Message: "graph project references must be audited"})
				return
			}
			projectID := uuidToString(detail.ProjectID)
			n.ProjectID = &projectID
			projects[projectID] = service.IssueGraphProject{ID: projectID, Title: detail.ProjectTitle.String}
		}
		if detail.AssigneeID.Valid && detail.AssigneeType.Valid {
			n.Assignee = &service.IssueGraphAssignee{ID: uuidToString(detail.AssigneeID), Type: detail.AssigneeType.String}
		}
		nodes = append(nodes, n)
	}
	projectList := make([]service.IssueGraphProject, 0, len(projects))
	for _, p := range projects {
		projectList = append(projectList, p)
	}
	graph, err := deps.Graph(nodes, projectList, matched, scope, focus, access.CapturedAt.Time, func(string) bool { return true })
	if err != nil {
		if !writeDependencyError(w, err) {
			writeIssueGraphFailure(w, r, err)
		}
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeIssueGraphFailure(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, graph)
}

func writeIssueGraphFailure(w http.ResponseWriter, r *http.Request, err error) {
	slog.Warn("issue graph query failed", "error", err)
	status, code := http.StatusInternalServerError, "graph_query_failed"
	if errors.Is(r.Context().Err(), context.DeadlineExceeded) {
		status, code = http.StatusGatewayTimeout, "graph_query_timeout"
	}
	writeJSON(w, status, map[string]string{"error": "The complete issue graph could not be read; retry the query.", "reason_code": code})
}
