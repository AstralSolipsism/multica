package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// RegisterLabrastroSkillRoutes keeps the fork's route surface in one place.
func (h *Handler) RegisterLabrastroSkillRoutes(r chi.Router) {
	r.Get("/api/skill-folders", h.LabrastroSkillTree)
	r.Post("/api/skill-folders", h.LabrastroCreateFolder)
	r.Patch("/api/skill-folders/{folderId}", h.LabrastroUpdateFolder)
	r.Delete("/api/skill-folders/{folderId}", h.LabrastroDeleteFolder)
	r.Put("/api/skill-placements/{skillId}", h.LabrastroMoveSkill)
	r.Post("/api/skill-placements/{skillId}/detach", h.LabrastroDetachSkill)
	r.Get("/api/skill-packages", h.LabrastroListPackages)
	r.Post("/api/skill-packages/preview", h.LabrastroPreviewPackage)
	r.Post("/api/skill-packages/apply", h.LabrastroApplyPackage)
	r.Get("/api/skill-packages/{packageId}", h.LabrastroGetPackage)
	r.Post("/api/skill-packages/{packageId}/rescan", h.LabrastroRescanPackage)
	r.Get("/api/skill-packages/{packageId}/delete-preview", h.LabrastroPackageDeletePreview)
	r.Post("/api/skill-packages/{packageId}/dissolve", h.LabrastroDissolvePackage)
	r.Delete("/api/skill-packages/{packageId}", h.LabrastroDeletePackage)
}

type labrastroSkillActor struct{ ws, user pgtype.UUID }
type labrastroSkillAPIError struct {
	status        int
	code, message string
}

func (e *labrastroSkillAPIError) Error() string { return e.message }
func labrastroSkillError(status int, code, message string) error {
	return &labrastroSkillAPIError{status, code, message}
}
func labrastroWriteSkillError(w http.ResponseWriter, err error) {
	var api *labrastroSkillAPIError
	var pg *pgconn.PgError
	if !errors.As(err, &api) {
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			api = &labrastroSkillAPIError{404, "not_found", "object not found in this workspace"}
		case isUniqueViolation(err):
			api = &labrastroSkillAPIError{409, "name_conflict", "name or source path already exists"}
		case errors.As(err, &pg) && (pg.Code == "40001" || pg.Code == "40P01"):
			api = &labrastroSkillAPIError{409, "preview_stale", "concurrent change; preview again before retrying"}
		default:
			api = &labrastroSkillAPIError{500, "operation_failed", "skill package operation failed"}
		}
	}
	writeJSON(w, api.status, map[string]any{"error": api.message, "code": api.code, "retryable": api.status >= 500 || api.code == "preview_stale"})
}
func (h *Handler) labrastroSkillActor(w http.ResponseWriter, r *http.Request) (labrastroSkillActor, bool) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return labrastroSkillActor{}, false
	}
	ws, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return labrastroSkillActor{}, false
	}
	if _, ok := h.requireWorkspaceRole(w, r, uuidToString(ws), "workspace not found", "owner", "admin", "member"); !ok {
		return labrastroSkillActor{}, false
	}
	return labrastroSkillActor{ws, parseUUID(uid)}, true
}
func (h *Handler) labrastroSkillTx(ctx context.Context, a labrastroSkillActor) (pgx.Tx, *db.Queries, db.Member, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, db.Member{}, err
	}
	if _, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"); err != nil {
		tx.Rollback(ctx)
		return nil, nil, db.Member{}, err
	}
	q := h.Queries.WithTx(tx)
	// Match workspace teardown's lock order before taking member/skill locks.
	// This closes the no-FK insert window after its tree sweep has run.
	if _, err = q.LabrastroLockSkillWorkspaceLifetime(ctx, a.ws); err != nil {
		tx.Rollback(ctx)
		return nil, nil, db.Member{}, err
	}
	// A transaction-scoped workspace lock serializes tree mutations. The
	// member row stays locked through commit so role revocation cannot race.
	if err = q.LabrastroLockSkillWorkspace(ctx, uuidToString(a.ws)); err != nil {
		tx.Rollback(ctx)
		return nil, nil, db.Member{}, err
	}
	m, err := q.LabrastroLockSkillMember(ctx, db.LabrastroLockSkillMemberParams{WorkspaceID: a.ws, UserID: a.user})
	if err == nil && !roleAllowed(m.Role, "owner", "admin", "member") {
		err = labrastroSkillError(403, "permission_changed", "workspace membership no longer permits writes")
	}
	if err != nil {
		tx.Rollback(ctx)
		return nil, nil, db.Member{}, err
	}
	if err = q.LabrastroCleanSkillPlacements(ctx, a.ws); err != nil {
		tx.Rollback(ctx)
		return nil, nil, db.Member{}, err
	}
	return tx, q, m, nil
}
func labrastroCanManage(creator pgtype.UUID, a labrastroSkillActor, m db.Member) bool {
	return creator == a.user || roleAllowed(m.Role, "owner", "admin")
}
func labrastroRequirePackageOwner(p db.LabrastroSkillPackage, a labrastroSkillActor, m db.Member) error {
	if !labrastroCanManage(p.CreatedBy, a, m) {
		return labrastroSkillError(403, "forbidden", "only the package importer or a workspace admin can manage this package")
	}
	return nil
}
func labrastroDecode(w http.ResponseWriter, r *http.Request, out any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		writeError(w, 400, "invalid request body")
		return false
	}
	return true
}
func labrastroOptionalUUID(w http.ResponseWriter, s, field string) (pgtype.UUID, bool) {
	if s == "" {
		return pgtype.UUID{}, true
	}
	return parseUUIDOrBadRequest(w, s, field)
}
func labrastroNewID() pgtype.UUID { return parseUUID(uuid.NewString()) }
func labrastroFolderName(s string) bool {
	return strings.TrimSpace(s) == s && s != "" && len(s) <= 255 && !strings.ContainsAny(s, "\x00\n\r")
}

type LabrastroSkillPackageResponse struct {
	ID           string          `json:"id"`
	WorkspaceID  string          `json:"workspace_id"`
	OwnerRepo    string          `json:"owner_repo"`
	Subdirectory string          `json:"subdirectory"`
	SourceURL    string          `json:"source_url"`
	Ref          string          `json:"ref"`
	RootFolderID string          `json:"root_folder_id"`
	CreatedBy    string          `json:"created_by"`
	Revision     int64           `json:"revision"`
	Candidates   json.RawMessage `json:"candidates"`
}

func labrastroPackageResponse(p db.LabrastroSkillPackage) LabrastroSkillPackageResponse {
	return LabrastroSkillPackageResponse{uuidToString(p.ID), uuidToString(p.WorkspaceID), p.OwnerRepo, p.Subdirectory, p.SourceUrl, p.SourceRef, uuidToString(p.RootFolderID), uuidToString(p.CreatedBy), p.Revision, json.RawMessage(p.Candidates)}
}

func (h *Handler) LabrastroSkillTree(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	folders, err := h.Queries.LabrastroListSkillFolders(ctx, a.ws)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	places, err := h.Queries.LabrastroListSkillPlacements(ctx, a.ws)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	packages, err := h.Queries.LabrastroListSkillPackages(ctx, a.ws)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	ps := []LabrastroSkillPackageResponse{}
	for _, p := range packages {
		ps = append(ps, labrastroPackageResponse(p))
	}
	writeJSON(w, 200, map[string]any{"folders": folders, "placements": places, "packages": ps})
}
func labrastroCheckFolderParent(ctx context.Context, q *db.Queries, ws, parent, moving pgtype.UUID) error {
	seen := map[pgtype.UUID]bool{}
	for parent.Valid {
		if parent == moving || seen[parent] {
			return labrastroSkillError(409, "folder_cycle", "folder move would create a cycle")
		}
		seen[parent] = true
		f, err := q.LabrastroGetSkillFolder(ctx, db.LabrastroGetSkillFolderParams{WorkspaceID: ws, ID: parent})
		if err != nil {
			return err
		}
		if f.PackageID.Valid {
			return labrastroSkillError(409, "managed_folder", "custom content cannot be placed inside a managed package")
		}
		parent = f.ParentID
	}
	return nil
}

type labrastroFolderRequest struct {
	Name     string `json:"name"`
	ParentID string `json:"parent_id"`
}

func (h *Handler) LabrastroCreateFolder(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	var req labrastroFolderRequest
	if !labrastroDecode(w, r, &req) {
		return
	}
	if !labrastroFolderName(req.Name) {
		writeError(w, 400, "name must be 1–255 bytes with no control characters or surrounding spaces")
		return
	}
	parent, ok := labrastroOptionalUUID(w, req.ParentID, "parent_id")
	if !ok {
		return
	}
	tx, q, _, err := h.labrastroSkillTx(r.Context(), a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if err = labrastroCheckFolderParent(r.Context(), q, a.ws, parent, pgtype.UUID{}); err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	f, err := q.LabrastroCreateSkillFolder(r.Context(), db.LabrastroCreateSkillFolderParams{ID: labrastroNewID(), WorkspaceID: a.ws, ParentID: parent, Name: req.Name})
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	writeJSON(w, 201, f)
}
func (h *Handler) LabrastroUpdateFolder(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "folderId"), "folder_id")
	if !ok {
		return
	}
	var req struct {
		Name     *string `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if !labrastroDecode(w, r, &req) {
		return
	}
	tx, q, m, err := h.labrastroSkillTx(r.Context(), a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	f, err := q.LabrastroGetSkillFolder(r.Context(), db.LabrastroGetSkillFolderParams{WorkspaceID: a.ws, ID: id})
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	if f.PackageID.Valid {
		p, e := q.LabrastroGetSkillPackage(r.Context(), db.LabrastroGetSkillPackageParams{WorkspaceID: a.ws, ID: f.PackageID})
		if e != nil {
			err = e
		} else if p.RootFolderID != f.ID {
			err = labrastroSkillError(409, "managed_folder", "managed package folders cannot be rearranged")
		} else {
			err = labrastroRequirePackageOwner(p, a, m)
		}
		if err != nil {
			labrastroWriteSkillError(w, err)
			return
		}
	}
	if req.Name != nil {
		if !labrastroFolderName(*req.Name) {
			writeError(w, 400, "invalid folder name")
			return
		}
		f.Name = *req.Name
	}
	if req.ParentID != nil {
		f.ParentID, ok = labrastroOptionalUUID(w, *req.ParentID, "parent_id")
		if !ok {
			return
		}
		if err = labrastroCheckFolderParent(r.Context(), q, a.ws, f.ParentID, id); err != nil {
			labrastroWriteSkillError(w, err)
			return
		}
	}
	f, err = q.LabrastroUpdateSkillFolder(r.Context(), db.LabrastroUpdateSkillFolderParams{WorkspaceID: a.ws, ID: id, ParentID: f.ParentID, Name: f.Name})
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	writeJSON(w, 200, f)
}
func (h *Handler) LabrastroDeleteFolder(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "folderId"), "folder_id")
	if !ok {
		return
	}
	ctx := r.Context()
	tx, q, _, err := h.labrastroSkillTx(ctx, a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	f, err := q.LabrastroGetSkillFolder(ctx, db.LabrastroGetSkillFolderParams{WorkspaceID: a.ws, ID: id})
	if err == nil && f.PackageID.Valid {
		err = labrastroSkillError(409, "managed_folder", "use package dissolve or delete for a managed folder")
	}
	if err == nil {
		err = q.LabrastroPromoteSkillFolders(ctx, db.LabrastroPromoteSkillFoldersParams{WorkspaceID: a.ws, ParentID: id, ParentID_2: f.ParentID})
	}
	if err == nil {
		if f.ParentID.Valid {
			err = q.LabrastroPromoteSkillPlacements(ctx, db.LabrastroPromoteSkillPlacementsParams{WorkspaceID: a.ws, FolderID: id, FolderID_2: f.ParentID})
		} else {
			_, err = tx.Exec(ctx, "DELETE FROM labrastro_skill_placement WHERE workspace_id=$1 AND folder_id=$2", a.ws, id)
		}
	}
	if err == nil {
		err = q.LabrastroDeleteSkillFolder(ctx, db.LabrastroDeleteSkillFolderParams{WorkspaceID: a.ws, ID: id})
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true})
}
func (h *Handler) LabrastroMoveSkill(w http.ResponseWriter, r *http.Request) {
	h.labrastroChangeSkillPlacement(w, r, false)
}
func (h *Handler) LabrastroDetachSkill(w http.ResponseWriter, r *http.Request) {
	h.labrastroChangeSkillPlacement(w, r, true)
}
func (h *Handler) labrastroChangeSkillPlacement(w http.ResponseWriter, r *http.Request, detach bool) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "skillId"), "skill_id")
	if !ok {
		return
	}
	var req struct {
		FolderID string `json:"folder_id"`
	}
	if !detach && !labrastroDecode(w, r, &req) {
		return
	}
	folder, ok := labrastroOptionalUUID(w, req.FolderID, "folder_id")
	if !ok {
		return
	}
	ctx := r.Context()
	tx, q, m, err := h.labrastroSkillTx(ctx, a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	s, err := q.LabrastroLockSkill(ctx, db.LabrastroLockSkillParams{WorkspaceID: a.ws, ID: id})
	if err == nil && !labrastroCanManage(s.CreatedBy, a, m) {
		err = labrastroSkillError(403, "forbidden", "only the skill creator or a workspace admin can move or detach it")
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	if detach {
		err = q.LabrastroDetachSkill(ctx, db.LabrastroDetachSkillParams{WorkspaceID: a.ws, SkillID: id})
	} else {
		places, e := q.LabrastroListSkillPlacements(ctx, a.ws)
		err = e
		for _, p := range places {
			if p.SkillID == id && p.PackageID.Valid {
				err = labrastroSkillError(409, "managed_skill", "detach this skill from its package before moving it")
			}
		}
		if err == nil {
			err = labrastroCheckFolderParent(ctx, q, a.ws, folder, pgtype.UUID{})
		}
		if err == nil {
			if !folder.Valid {
				err = q.LabrastroRemoveSkillPlacement(ctx, db.LabrastroRemoveSkillPlacementParams{WorkspaceID: a.ws, SkillID: id})
			} else {
				err = q.LabrastroPlaceSkill(ctx, db.LabrastroPlaceSkillParams{WorkspaceID: a.ws, SkillID: id, FolderID: folder})
			}
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"updated": true})
}

func labrastroSignPreview(hash string, expires int64) string {
	payload := hash + "." + strconv.FormatInt(expires, 10)
	mac := hmac.New(sha256.New, auth.JWTSecret())
	mac.Write([]byte("labrastro-skill-preview-v1\x00" + payload))
	return payload + "." + hex.EncodeToString(mac.Sum(nil))
}
func labrastroValidatePreview(token, hash string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	expires, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || expires < time.Now().Unix() || expires > time.Now().Add(16*time.Minute).Unix() {
		return false
	}
	return hmac.Equal([]byte(token), []byte(labrastroSignPreview(hash, expires)))
}
func labrastroJSONHash(v any) string {
	body, _ := json.Marshal(v)
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
func labrastroStalePreview() error {
	return labrastroSkillError(409, "preview_stale", "source, target, permissions or preview validity changed; preview again")
}

func (h *Handler) LabrastroListPackages(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	rows, err := h.Queries.LabrastroListSkillPackages(r.Context(), a.ws)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	out := []LabrastroSkillPackageResponse{}
	for _, p := range rows {
		out = append(out, labrastroPackageResponse(p))
	}
	writeJSON(w, 200, map[string]any{"packages": out})
}
func (h *Handler) LabrastroGetPackage(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "packageId"), "package_id")
	if !ok {
		return
	}
	p, err := h.Queries.LabrastroGetSkillPackage(r.Context(), db.LabrastroGetSkillPackageParams{WorkspaceID: a.ws, ID: id})
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	writeJSON(w, 200, labrastroPackageResponse(p))
}

func labrastroPackageImpact(ctx context.Context, q *db.Queries, a labrastroSkillActor, id pgtype.UUID) (db.LabrastroSkillPackage, []pgtype.UUID, []db.LabrastroSkillBindingImpactRow, string, error) {
	p, err := q.LabrastroGetSkillPackage(ctx, db.LabrastroGetSkillPackageParams{WorkspaceID: a.ws, ID: id})
	if err != nil {
		return p, nil, nil, "", err
	}
	places, err := q.LabrastroListSkillPlacements(ctx, a.ws)
	if err != nil {
		return p, nil, nil, "", err
	}
	ids := []pgtype.UUID{}
	for _, p := range places {
		if p.PackageID == id {
			ids = append(ids, p.SkillID)
		}
	}
	impact, err := q.LabrastroSkillBindingImpact(ctx, db.LabrastroSkillBindingImpactParams{WorkspaceID: a.ws, SkillIds: ids})
	if err != nil {
		return p, nil, nil, "", err
	}
	states, err := q.LabrastroListSkillStates(ctx, a.ws)
	if err != nil {
		return p, nil, nil, "", err
	}
	folders, err := q.LabrastroListSkillFolders(ctx, a.ws)
	if err != nil {
		return p, nil, nil, "", err
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: a.user, WorkspaceID: a.ws})
	if err != nil {
		return p, nil, nil, "", err
	}
	hash := labrastroJSONHash([]any{"delete", uuidToString(a.ws), uuidToString(a.user), p, ids, impact, states, folders, places, member})
	return p, ids, impact, hash, nil
}
func (h *Handler) LabrastroPackageDeletePreview(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "packageId"), "package_id")
	if !ok {
		return
	}
	p, ids, impact, hash, err := labrastroPackageImpact(r.Context(), h.Queries, a, id)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	m, err := h.getWorkspaceMember(r.Context(), uuidToString(a.user), uuidToString(a.ws))
	if err == nil {
		err = labrastroRequirePackageOwner(p, a, m)
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	canDelete := true
	for _, sid := range ids {
		s, err := h.Queries.GetSkillInWorkspace(r.Context(), db.GetSkillInWorkspaceParams{ID: sid, WorkspaceID: a.ws})
		if err != nil {
			labrastroWriteSkillError(w, err)
			return
		}
		canDelete = canDelete && labrastroCanManage(s.CreatedBy, a, m)
	}
	writeJSON(w, 200, map[string]any{"preview_id": labrastroSignPreview(hash, time.Now().Add(15*time.Minute).Unix()), "skill_ids": ids, "affected_agents": impact, "can_delete": canDelete})
}
func (h *Handler) LabrastroDissolvePackage(w http.ResponseWriter, r *http.Request) {
	h.labrastroRemovePackage(w, r, false)
}
func (h *Handler) LabrastroDeletePackage(w http.ResponseWriter, r *http.Request) {
	h.labrastroRemovePackage(w, r, true)
}
func (h *Handler) labrastroRemovePackage(w http.ResponseWriter, r *http.Request, deleteSkills bool) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "packageId"), "package_id")
	if !ok {
		return
	}
	var req struct {
		PreviewID string `json:"preview_id"`
	}
	if !labrastroDecode(w, r, &req) {
		return
	}
	ctx := r.Context()
	tx, q, m, err := h.labrastroSkillTx(ctx, a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	p, ids, _, hash, err := labrastroPackageImpact(ctx, q, a, id)
	if err == nil {
		err = labrastroRequirePackageOwner(p, a, m)
	}
	if err == nil && !labrastroValidatePreview(req.PreviewID, hash) {
		err = labrastroStalePreview()
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	// Lock and validate the entire affected set before deleting anything.
	for _, sid := range ids {
		s, e := q.LabrastroLockSkill(ctx, db.LabrastroLockSkillParams{WorkspaceID: a.ws, ID: sid})
		if e != nil {
			err = e
			break
		}
		if deleteSkills && !labrastroCanManage(s.CreatedBy, a, m) {
			err = labrastroSkillError(403, "forbidden", "package contains a skill you cannot delete")
			break
		}
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	if deleteSkills {
		for _, sid := range ids {
			if err = q.LabrastroDeleteSkillBindings(ctx, db.LabrastroDeleteSkillBindingsParams{WorkspaceID: a.ws, ID: sid}); err != nil {
				break
			}
			if err = q.DeleteSkillLabelAssignmentsBySkill(ctx, sid); err != nil {
				break
			}
			if err = q.DeleteSkillFilesBySkill(ctx, sid); err != nil {
				break
			}
			if err = q.DeleteSkill(ctx, db.DeleteSkillParams{ID: sid, WorkspaceID: a.ws}); err != nil {
				break
			}
		}
		// Detached skills and their ancestors survive as ordinary folders.
		if err == nil {
			err = q.LabrastroDeletePackagePlacements(ctx, db.LabrastroDeletePackagePlacementsParams{WorkspaceID: a.ws, PackageID: id})
		}
		if err == nil {
			err = q.LabrastroPruneSkillPackageFolders(ctx, db.LabrastroPruneSkillPackageFoldersParams{WorkspaceID: a.ws, PackageID: id})
		}
	}
	if err == nil {
		err = q.LabrastroDissolveSkillPlacements(ctx, db.LabrastroDissolveSkillPlacementsParams{WorkspaceID: a.ws, PackageID: id})
	}
	if err == nil {
		err = q.LabrastroDissolveSkillFolders(ctx, db.LabrastroDissolveSkillFoldersParams{WorkspaceID: a.ws, PackageID: id})
	}
	if err == nil {
		err = q.LabrastroDeleteSkillPackage(ctx, db.LabrastroDeleteSkillPackageParams{WorkspaceID: a.ws, ID: id})
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	if deleteSkills {
		actorType, actorID := h.resolveActor(r, uuidToString(a.user), uuidToString(a.ws))
		for _, sid := range ids {
			h.publish(protocol.EventSkillDeleted, uuidToString(a.ws), actorType, actorID, map[string]any{"skill_id": uuidToString(sid)})
		}
	}
	writeJSON(w, 200, map[string]any{"deleted": deleteSkills, "dissolved": !deleteSkills, "skill_count": len(ids)})
}
