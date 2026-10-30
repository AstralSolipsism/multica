package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type mediaClaims struct {
	Workspace    string `json:"workspace"`
	Attempt      string `json:"attempt"`
	RuntimeOwner string `json:"runtime_owner"`
	jwt.RegisteredClaims
}

func mediaJobToken(job db.MediaJob, owner string) (string, error) {
	claims := mediaClaims{RuntimeOwner: owner, Workspace: uuidToString(job.WorkspaceID), Attempt: uuidToString(job.Attempt), RegisteredClaims: jwt.RegisteredClaims{Subject: uuidToString(job.ID), Issuer: "media-job", ExpiresAt: jwt.NewNumericDate(job.ExpiresAt.Time)}}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(auth.JWTSecret())
	return "mjt_" + token, err
}

// Job tokens grant access only to this attempt's declared inputs and output.
// The mjt_ prefix prevents the ordinary session middleware accepting them.
func (h *Handler) authorizedMediaAttempt(w http.ResponseWriter, r *http.Request) (db.MediaJob, bool) {
	raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer mjt_")
	var claims mediaClaims
	_, err := jwt.ParseWithClaims(raw, &claims, func(t *jwt.Token) (any, error) { return auth.JWTSecret(), nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("media-job"), jwt.WithExpirationRequired())
	if err != nil || claims.Subject != chi.URLParam(r, "id") {
		writeError(w, 401, "invalid media token")
		return db.MediaJob{}, false
	}
	id, ok := parseUUIDOrBadRequest(w, claims.Subject, "job_id")
	if !ok {
		return db.MediaJob{}, false
	}
	ws, ok := parseUUIDOrBadRequest(w, claims.Workspace, "workspace_id")
	if !ok {
		return db.MediaJob{}, false
	}
	job, err := h.Queries.GetMediaJob(r.Context(), db.GetMediaJobParams{ID: id, WorkspaceID: ws})
	if err != nil || job.State != "running" || uuidToString(job.Attempt) != claims.Attempt || !time.Now().Before(job.ExpiresAt.Time) {
		writeError(w, 409, "media attempt is no longer active")
		return db.MediaJob{}, false
	}
	rt, err := h.Queries.GetAgentRuntimeForWorkspace(r.Context(), db.GetAgentRuntimeForWorkspaceParams{ID: job.RuntimeID, WorkspaceID: ws})
	if err != nil || rt.Status != "online" || uuidToString(rt.OwnerID) != claims.RuntimeOwner || !service.RuntimeAllowsUser(rt, job.CallerID) {
		writeError(w, 403, "runtime consent revoked")
		return db.MediaJob{}, false
	}
	if _, err := h.getWorkspaceMember(r.Context(), uuidToString(job.CallerID), uuidToString(ws)); err != nil {
		writeError(w, 403, "workspace access revoked")
		return db.MediaJob{}, false
	}
	return job, true
}

func (h *Handler) DownloadMediaInput(w http.ResponseWriter, r *http.Request) {
	job, ok := h.authorizedMediaAttempt(w, r)
	if !ok {
		return
	}
	var req protocol.MediaRequest
	_ = json.Unmarshal(job.Request, &req)
	id := chi.URLParam(r, "attachmentID")
	allowed := false
	for _, input := range req.Inputs {
		if input.AttachmentID == id {
			allowed = true
			break
		}
	}
	if !allowed {
		writeError(w, 404, "input not found")
		return
	}
	att, err := h.Queries.GetAttachment(r.Context(), db.GetAttachmentParams{ID: parseUUID(id), WorkspaceID: job.WorkspaceID})
	if err != nil || h.Storage == nil {
		writeError(w, 404, "input not found")
		return
	}
	reader, err := h.Storage.GetReader(r.Context(), h.Storage.KeyFromURL(att.Url))
	if err != nil {
		writeError(w, 502, "input unavailable")
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", att.ContentType)
	h.serveProxyRange(w, r, att, reader)
}

type streamStorage interface {
	UploadStream(context.Context, string, io.Reader, int64, string, string) (string, error)
}

func (h *Handler) uploadAttachmentStream(ctx context.Context, key string, reader io.Reader, size int64, contentType, filename string) (string, error) {
	store, ok := h.Storage.(streamStorage)
	if !ok {
		return "", errors.New("storage does not support streaming uploads")
	}
	return store.UploadStream(ctx, key, reader, size, contentType, filename)
}

type mediaCountReader struct {
	io.Reader
	count int64
}

func (r *mediaCountReader) Read(p []byte) (int, error) {
	n, e := r.Reader.Read(p)
	r.count += int64(n)
	return n, e
}

// UploadMediaOutput uses the existing storage/attachment contract. The job,
// not the executor, supplies all ownership and task/issue binding fields.
func (h *Handler) UploadMediaOutput(w http.ResponseWriter, r *http.Request) {
	job, ok := h.authorizedMediaAttempt(w, r)
	if !ok {
		return
	}
	if h.Storage == nil {
		writeError(w, 503, "file upload not configured")
		return
	}
	if job.AttachmentID.Valid {
		h.writeMediaOutput(w, r, job)
		return
	}
	size := r.ContentLength
	if size <= 0 || size > protocol.MediaMaxBytes {
		writeError(w, 413, "media output requires a known length of 1 byte to 1 GiB")
		return
	}
	filename := path.Base(r.URL.Query().Get("filename"))
	if filename == "." || filename == "/" || len(filename) > 255 {
		writeError(w, 400, "invalid filename")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, protocol.MediaMaxBytes)
	prefix := make([]byte, min(size, 512))
	if _, err := io.ReadFull(r.Body, prefix); err != nil {
		writeError(w, 400, "incomplete media body")
		return
	}
	contentType := http.DetectContentType(prefix)
	if !strings.HasPrefix(contentType, "image/") && !strings.HasPrefix(contentType, "video/") {
		writeError(w, 400, "output must be image or video")
		return
	}
	id := uuid.NewString()
	key := "workspaces/" + uuidToString(job.WorkspaceID) + "/" + id + path.Ext(filename)
	reader := &mediaCountReader{Reader: io.MultiReader(bytes.NewReader(prefix), r.Body)}
	link, err := h.uploadAttachmentStream(r.Context(), key, reader, size, contentType, filename)
	saved := false
	defer func() {
		if !saved {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			h.Storage.Delete(ctx, key)
		}
	}()
	if err != nil || reader.count != size {
		writeError(w, 502, "media upload failed")
		return
	}
	// Recheck revocation after a potentially long transfer.
	if _, ok := h.authorizedMediaAttempt(w, r); !ok {
		return
	}
	// Lock only after streaming: cancellation does not wait on a slow transfer.
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "save attachment failed")
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	current, err := q.LockMediaJob(r.Context(), db.LockMediaJobParams{ID: job.ID, WorkspaceID: job.WorkspaceID})
	if err != nil || current.State != "running" || current.Attempt != job.Attempt || !time.Now().Before(current.ExpiresAt.Time) {
		writeError(w, 409, "media attempt is no longer active")
		return
	}
	if current.AttachmentID.Valid {
		h.writeMediaOutput(w, r, current)
		return
	}
	att, err := q.CreateAttachment(r.Context(), db.CreateAttachmentParams{ID: parseUUID(id), WorkspaceID: job.WorkspaceID, TaskID: job.TaskID, IssueID: job.IssueID, ChatSessionID: job.ChatSessionID, UploaderType: job.UploaderType, UploaderID: job.UploaderID, Filename: filename, ContentType: contentType, SizeBytes: size, Url: link})
	if err != nil {
		writeError(w, 500, "save attachment failed")
		return
	}
	job, err = q.AttachMediaJob(r.Context(), db.AttachMediaJobParams{ID: job.ID, WorkspaceID: job.WorkspaceID, AttachmentID: parseUUID(id)})
	if err != nil || tx.Commit(r.Context()) != nil {
		writeError(w, 500, "save attachment failed")
		return
	}
	saved = true
	if att.IssueRevision > 0 && att.IssueID.Valid {
		h.publish(protocol.EventIssueAttachmentsChanged, uuidToString(job.WorkspaceID), job.UploaderType, uuidToString(job.UploaderID), map[string]any{"issue_id": uuidToString(att.IssueID), "issue_revision": att.IssueRevision})
	}
	h.writeMediaOutput(w, r, job)
}

func (h *Handler) writeMediaOutput(w http.ResponseWriter, r *http.Request, job db.MediaJob) {
	att, err := h.Queries.GetAttachment(r.Context(), db.GetAttachmentParams{ID: job.AttachmentID, WorkspaceID: job.WorkspaceID})
	if err != nil {
		writeError(w, 500, "attachment unavailable")
		return
	}
	writeJSON(w, 200, h.attachmentToResponse(att, attachmentURLModeFromRequest(r)))
}

func (h *Handler) MediaAttemptStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.authorizedMediaAttempt(w, r); ok {
		w.WriteHeader(http.StatusNoContent)
	}
}
