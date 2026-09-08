package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type dependencyWriteFields struct {
	BlockedBy                 json.RawMessage `json:"blocked_by"`
	ExpectedDependencyVersion string          `json:"expected_dependency_version"`
	DependencyOverride        json.RawMessage `json:"dependency_override"`
}

func (h *Handler) CreateIssueWithDependencies(w http.ResponseWriter, r *http.Request) {
	if !h.IssueService.Dependencies.WritesEnabled {
		writeDependencyError(w, &service.DependencyError{Code: "not_found", Message: "dependency writes are not enabled"})
		return
	}
	h.createIssue(w, r, true)
}

func (h *Handler) UpdateIssueWithDependencies(w http.ResponseWriter, r *http.Request) {
	if !h.IssueService.Dependencies.WritesEnabled {
		writeDependencyError(w, &service.DependencyError{Code: "not_found", Message: "dependency writes are not enabled"})
		return
	}
	h.updateIssue(w, r, true)
}

func (h *Handler) parseDependencyWrite(w http.ResponseWriter, r *http.Request, fields dependencyWriteFields, compound, creating bool) (service.DependencyWrite, bool) {
	write := service.DependencyWrite{Creating: creating, ExpectedVersion: fields.ExpectedDependencyVersion, IncludeView: compound}
	if !compound && (fields.BlockedBy != nil || fields.ExpectedDependencyVersion != "" || fields.DependencyOverride != nil) {
		writeError(w, http.StatusBadRequest, "use the with-dependencies endpoint for prerequisite edits")
		return write, false
	}
	if fields.DependencyOverride != nil {
		writeDependencyError(w, &service.DependencyError{Code: "dependency_override_not_allowed", Message: "dependency execution overrides are not enabled yet"})
		return write, false
	}
	if creating && fields.ExpectedDependencyVersion != "" {
		writeError(w, http.StatusBadRequest, "expected_dependency_version is only valid for updates")
		return write, false
	}
	if fields.BlockedBy == nil {
		if compound && creating {
			ids := []pgtype.UUID{}
			write.BlockedBy = &ids
		}
		return write, true
	}
	if bytes.Equal(bytes.TrimSpace(fields.BlockedBy), []byte("null")) {
		writeError(w, http.StatusBadRequest, "blocked_by must be an array, not null")
		return write, false
	}
	var refs []string
	if err := json.Unmarshal(fields.BlockedBy, &refs); err != nil {
		writeError(w, http.StatusBadRequest, "blocked_by must be an array of issue references")
		return write, false
	}
	if !creating && fields.ExpectedDependencyVersion == "" {
		writeError(w, http.StatusBadRequest, "expected_dependency_version is required when replacing blocked_by")
		return write, false
	}
	ids := make([]pgtype.UUID, 0, len(refs))
	seen := map[pgtype.UUID]bool{}
	for _, ref := range refs {
		// Resolve identifiers with the same workspace-bound loader as issue GET.
		issue, ok := h.loadDependencyIssue(w, r, ref)
		if !ok {
			return write, false
		}
		if !seen[issue.ID] {
			ids = append(ids, issue.ID)
			seen[issue.ID] = true
		}
	}
	write.BlockedBy = &ids
	return write, true
}

func (h *Handler) GetIssueDependencies(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadDependencyIssue(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	snapshot, err := h.IssueService.Dependencies.Read(r.Context(), issue.WorkspaceID, uuidToString(issue.ID))
	if err != nil {
		if !writeDependencyError(w, err) {
			writeError(w, http.StatusInternalServerError, "failed to read dependencies")
		}
		return
	}
	view := h.dependencyView(r, snapshot, issue.ID)
	writeJSON(w, http.StatusOK, view)
}

func (h *Handler) loadDependencyIssue(w http.ResponseWriter, r *http.Request, id string) (db.Issue, bool) {
	return h.loadIssueForUserWithNotFound(w, r, id, func() {
		writeDependencyError(w, &service.DependencyError{Code: "not_found", Message: "issue not found"})
	})
}

func (h *Handler) dependencyView(r *http.Request, snapshot *service.DependencySnapshot, id pgtype.UUID) service.DependencyView {
	// Issue access is currently workspace membership (loadIssueForUser plus the
	// router's membership gate). Cross-workspace references never enter a valid
	// snapshot; no project-level visibility rule is invented here.
	v := snapshot.View(uuidToString(id), func(string) bool { return true })
	prefix := h.getIssuePrefix(r.Context(), snapshot.WorkspaceID)
	fill := func(issueID string) string {
		n := snapshot.Model.Issues[issueID]
		if n.Number == 0 {
			return ""
		}
		return prefix + "-" + strconv.Itoa(int(n.Number))
	}
	for i := range v.BlockedBy {
		v.BlockedBy[i].Identifier = fill(v.BlockedBy[i].IssueID)
	}
	for i := range v.InheritedBlockedBy {
		v.InheritedBlockedBy[i].Identifier = fill(v.InheritedBlockedBy[i].IssueID)
	}
	for i := range v.Unsatisfied {
		v.Unsatisfied[i].Identifier = fill(v.Unsatisfied[i].IssueID)
	}
	for i := range v.Blocking {
		v.Blocking[i].Identifier = fill(v.Blocking[i].IssueID)
	}
	return v
}

func dependencyHTTPStatus(code string) int {
	switch code {
	case "not_found":
		return http.StatusNotFound
	case "dependency_change_not_allowed", "dependency_override_not_allowed":
		return http.StatusForbidden
	case "dependency_data_unverified":
		return http.StatusUnprocessableEntity
	default:
		return http.StatusConflict
	}
}

func writeDependencyError(w http.ResponseWriter, err error) bool {
	var e *service.DependencyError
	if !errors.As(err, &e) {
		return false
	}
	body := map[string]any{"error": e.Message, "reason_code": e.Code}
	if e.View != nil {
		body["dependencies"] = e.View
	}
	// Data-unverified errors deliberately disclose no raw historical endpoints.
	// Cycle witnesses here are from a validated, workspace-visible proposal.
	if e.Violation != nil && e.Code != "dependency_data_unverified" {
		body["path"] = e.Violation
	}
	writeJSON(w, dependencyHTTPStatus(e.Code), body)
	return true
}
