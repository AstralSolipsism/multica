package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/projectfile"
)

func (h *Handler) projectFileScope(w http.ResponseWriter, r *http.Request) (projectfile.Scope, bool) {
	w.Header().Set("Cache-Control", "private, no-store")
	if h.ProjectFiles == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "project files are disabled", "code": "PROJECT_FILES_DISABLED"})
		return projectfile.Scope{}, false
	}
	identity, ok := auth.IdentityFromContext(r.Context())
	if !ok {
		projectFileError(w, projectfile.ErrForbidden)
		return projectfile.Scope{}, false
	}
	project, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "project id")
	if !ok {
		return projectfile.Scope{}, false
	}
	workspace, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return projectfile.Scope{}, false
	}
	return projectfile.Scope{WorkspaceID: workspace, ProjectID: project, Identity: identity}, true
}

func projectFileError(w http.ResponseWriter, err error) {
	status, code, message := http.StatusServiceUnavailable, "TEMPORARILY_UNAVAILABLE", "project file service is temporarily unavailable; retry the original operation"
	switch {
	case errors.Is(err, projectfile.ErrForbidden):
		status, code, message = http.StatusForbidden, "ACCESS_DENIED", projectfile.ErrForbidden.Error()
	case errors.Is(err, projectfile.ErrNotFound):
		status, code, message = http.StatusNotFound, "NOT_FOUND", projectfile.ErrNotFound.Error()
	case errors.Is(err, projectfile.ErrOpKeyReused):
		status, code, message = http.StatusConflict, "OPERATION_KEY_REUSED", projectfile.ErrOpKeyReused.Error()
	case errors.Is(err, projectfile.ErrReadOnly):
		status, code, message = http.StatusForbidden, "READ_ONLY", projectfile.ErrReadOnly.Error()
	case errors.Is(err, projectfile.ErrTooLarge):
		status, code, message = http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", projectfile.ErrTooLarge.Error()
	case errors.Is(err, projectfile.ErrInvalid):
		status, code, message = http.StatusBadRequest, "INVALID_REQUEST", projectfile.ErrInvalid.Error()
	case errors.Is(err, projectfile.ErrContentMismatch):
		status, code, message = http.StatusBadRequest, "CONTENT_MISMATCH", projectfile.ErrContentMismatch.Error()
	case errors.Is(err, projectfile.ErrPathCollision):
		status, code, message = http.StatusConflict, "PATH_COLLISION", projectfile.ErrPathCollision.Error()
	case errors.Is(err, projectfile.ErrOutcomeUnknown):
		code, message = "OUTCOME_UNKNOWN", projectfile.ErrOutcomeUnknown.Error()
	case errors.Is(err, projectfile.ErrStorage):
		code, message = "STORAGE_UNAVAILABLE", projectfile.ErrStorage.Error()
	}
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "1")
	}
	// Storage SDK and database errors may contain endpoints or request details.
	// Never serialize or log them at this boundary.
	writeJSON(w, status, map[string]any{"error": message, "code": code})
}

func projectFileResult(w http.ResponseWriter, result projectfile.Result) {
	status := http.StatusOK
	if result.Status == projectfile.StatusConflict {
		status = http.StatusConflict
	}
	writeJSON(w, status, result)
}

func projectFileLimit(r *http.Request) (int32, error) {
	if r.URL.Query().Get("limit") == "" {
		return 50, nil
	}
	n, err := strconv.ParseInt(r.URL.Query().Get("limit"), 10, 32)
	if err != nil || n < 1 || n > 200 {
		return 0, projectfile.ErrInvalid
	}
	return int32(n), nil
}

func (h *Handler) ProjectFileCapabilities(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	if err := h.ProjectFiles.CheckAccess(r.Context(), scope); err != nil {
		projectFileError(w, err)
		return
	}
	options := h.ProjectFiles.Options()
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "api_version": 1, "read_only": options.ReadOnly, "max_file_bytes": options.MaxBytes, "max_page_size": 200})
}

func (h *Handler) ListProjectFiles(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	limit, err := projectFileLimit(r)
	if err != nil {
		projectFileError(w, err)
		return
	}
	page, err := h.ProjectFiles.List(r.Context(), scope, r.URL.Query().Get("prefix"), r.URL.Query().Get("after"), limit)
	if err != nil {
		projectFileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) SaveProjectFile(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	base, err := strconv.ParseInt(r.Header.Get("X-Base-Revision"), 10, 64)
	if err != nil || r.ContentLength < 0 {
		projectFileError(w, projectfile.ErrInvalid)
		return
	}
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	options := h.ProjectFiles.Options()
	r.Body = http.MaxBytesReader(w, r.Body, options.MaxBytes+1)
	// Bound slow request bodies as well as storage SDK calls. Other readers in
	// the service do not hold a DB transaction while awaiting incoming bytes.
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(options.UploadTimeout)); err == nil {
		defer func() { _ = controller.SetReadDeadline(time.Time{}) }()
	}
	result, err := h.ProjectFiles.Save(r.Context(), scope, r.Header.Get("Idempotency-Key"), projectfile.Request{
		Kind: "save", Path: r.URL.Query().Get("path"), BaseRevision: base, SizeBytes: r.ContentLength,
		SHA256: r.Header.Get("X-Content-SHA256"), ContentType: contentType,
	}, r.Body)
	if err != nil {
		projectFileError(w, err)
		return
	}
	projectFileResult(w, result)
}

func (h *Handler) ReadProjectFile(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	var revision *int64
	if raw := r.URL.Query().Get("revision"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			projectFileError(w, projectfile.ErrInvalid)
			return
		}
		revision = &n
	}
	file, body, err := h.ProjectFiles.Read(r.Context(), scope, r.URL.Query().Get("path"), revision)
	if err != nil {
		projectFileError(w, err)
		return
	}
	writeProjectFileContent(w, file, body, h.ProjectFiles.Options().UploadTimeout)
}

func writeProjectFileContent(w http.ResponseWriter, file projectfile.File, body io.ReadCloser, timeout time.Duration) {
	defer func() { _ = body.Close() }()
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(timeout)); err == nil {
		defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	}
	w.Header().Set("Content-Type", file.ContentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(file.Path)}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Length", strconv.FormatInt(file.SizeBytes, 10))
	w.Header().Set("X-File-ID", file.FileID)
	w.Header().Set("X-Revision", strconv.FormatInt(file.Revision, 10))
	w.Header().Set("X-Base-Revision", strconv.FormatInt(file.BaseRevision, 10))
	w.Header().Set("X-Version-ID", file.VersionID)
	w.Header().Set("X-Content-SHA256", file.SHA256)
	if file.CandidateID != "" {
		w.Header().Set("X-Candidate-ID", file.CandidateID)
	}
	if _, err := io.CopyN(w, body, file.SizeBytes); err != nil {
		slog.Warn("project file stream interrupted", "file_id", file.FileID, "version_id", file.VersionID)
		// A committed response cannot be replaced with JSON; abort the stream
		// so an incomplete response is never interpreted as a successful read.
		panic(http.ErrAbortHandler)
	}
}

func (h *Handler) ListProjectFileCandidates(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	limit, err := projectFileLimit(r)
	if err != nil {
		projectFileError(w, err)
		return
	}
	page, err := h.ProjectFiles.Candidates(r.Context(), scope, r.URL.Query().Get("path"), r.URL.Query().Get("after"), limit)
	if err != nil {
		projectFileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (h *Handler) ReadProjectFileCandidate(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "candidateId"), "candidate id")
	if !ok {
		return
	}
	file, body, err := h.ProjectFiles.ReadCandidate(r.Context(), scope, id)
	if err != nil {
		projectFileError(w, err)
		return
	}
	writeProjectFileContent(w, file, body, h.ProjectFiles.Options().UploadTimeout)
}

func (h *Handler) AdoptProjectFileCandidate(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "candidateId"), "candidate id")
	if !ok {
		return
	}
	var request struct {
		Path             string `json:"path"`
		ExpectedRevision *int64 `json:"expected_revision"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.ExpectedRevision == nil || decoder.Decode(new(any)) != io.EOF {
		projectFileError(w, projectfile.ErrInvalid)
		return
	}
	result, err := h.ProjectFiles.Adopt(r.Context(), scope, r.Header.Get("Idempotency-Key"), projectfile.Request{
		Kind: "adopt", Path: request.Path, BaseRevision: *request.ExpectedRevision, CandidateID: uuidToString(id),
	})
	if err != nil {
		projectFileError(w, err)
		return
	}
	projectFileResult(w, result)
}

func (h *Handler) GetProjectFileOperation(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.projectFileScope(w, r)
	if !ok {
		return
	}
	op, err := h.ProjectFiles.Operation(r.Context(), scope, chi.URLParam(r, "operationId"))
	if err != nil {
		projectFileError(w, err)
		return
	}
	status := http.StatusOK
	if op.State == "PENDING" {
		status = http.StatusAccepted
		w.Header().Set("Retry-After", "1")
	}
	writeJSON(w, status, op)
}
