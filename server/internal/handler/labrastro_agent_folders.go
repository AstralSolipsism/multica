package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) RegisterLabrastroAgentFolderRoutes(r chi.Router) {
	r.Get("/api/agent-folders", h.LabrastroAgentFolderTree)
	r.Post("/api/agent-folders", h.LabrastroCreateAgentFolder)
	r.Patch("/api/agent-folders/{folderId}", h.LabrastroUpdateAgentFolder)
	r.Delete("/api/agent-folders/{folderId}", h.LabrastroDeleteAgentFolder)
	r.Put("/api/agent-placements/{agentId}", h.LabrastroMoveAgent)
	r.Put("/api/agent-squad-placements/{squadId}", h.LabrastroMoveAgentSquad)
}

// Shared membership and UUID helpers write the upstream {error} envelope.
// Adapt their errors locally without changing those helpers' other callers.
type labrastroAgentFolderInputErrorWriter struct {
	http.ResponseWriter
	status int
}

func (w *labrastroAgentFolderInputErrorWriter) WriteHeader(status int) { w.status = status }
func (w *labrastroAgentFolderInputErrorWriter) Write(body []byte) (int, error) {
	var upstream struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &upstream); err != nil {
		return 0, err
	}
	code := map[int]string{400: "invalid_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found"}[w.status]
	if code == "" {
		code = "operation_failed"
	}
	labrastroWriteAgentFolderError(w.ResponseWriter, labrastroSkillError(w.status, code, upstream.Error))
	return len(body), nil
}

func labrastroAgentFolderInput(w http.ResponseWriter) http.ResponseWriter {
	return &labrastroAgentFolderInputErrorWriter{ResponseWriter: w}
}

func labrastroWriteAgentFolderError(w http.ResponseWriter, err error) {
	var api *labrastroSkillAPIError
	if !errors.As(err, &api) {
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			api = &labrastroSkillAPIError{404, "not_found", "object not found in this workspace"}
		case isUniqueViolation(err):
			api = &labrastroSkillAPIError{409, "name_conflict", "a folder with this name already exists at the destination"}
		default:
			api = &labrastroSkillAPIError{500, "operation_failed", "agent folder operation failed"}
		}
	}
	writeJSON(w, api.status, map[string]any{"error": api.message, "code": api.code, "retryable": api.status >= 500})
}

func labrastroDecodeAgentFolder(w http.ResponseWriter, r *http.Request, out any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	var body json.RawMessage
	if err := d.Decode(&body); err != nil || len(body) == 0 || body[0] != '{' {
		labrastroWriteAgentFolderError(w, labrastroSkillError(400, "invalid_request", "invalid request body"))
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		labrastroWriteAgentFolderError(w, labrastroSkillError(400, "invalid_request", "expected one JSON object"))
		return false
	}
	fields := json.NewDecoder(bytes.NewReader(body))
	fields.DisallowUnknownFields()
	if err := fields.Decode(out); err != nil {
		labrastroWriteAgentFolderError(w, labrastroSkillError(400, "invalid_request", "invalid request body"))
		return false
	}
	return true
}

func labrastroAgentFolderName(s string) bool {
	return s != "" && len(s) <= 255 && strings.TrimSpace(s) == s && strings.IndexFunc(s, func(r rune) bool {
		return unicode.IsControl(r) || r == '\u2028' || r == '\u2029'
	}) == -1
}

func (h *Handler) labrastroAgentFolderTx(ctx context.Context, a labrastroSkillActor) (pgx.Tx, *db.Queries, db.Member, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, db.Member{}, err
	}
	q := h.Queries.WithTx(tx)
	// Match workspace teardown: lifetime, tree, member, then resource locks.
	// READ COMMITTED sees the previous tree writer's commit after the advisory
	// lock wait. Every tree mutation holds this lock through commit.
	if _, err = q.LabrastroLockSkillWorkspaceLifetime(ctx, a.ws); err == nil {
		err = q.LabrastroLockAgentFolderWorkspace(ctx, uuidToString(a.ws))
	}
	var m db.Member
	if err == nil {
		m, err = q.LabrastroLockSkillMember(ctx, db.LabrastroLockSkillMemberParams{WorkspaceID: a.ws, UserID: a.user})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !roleAllowed(m.Role, "owner", "admin", "member")) {
			err = labrastroSkillError(403, "forbidden", "workspace membership no longer permits writes")
		}
	}
	if err == nil {
		err = q.LabrastroCleanAgentPlacements(ctx, a.ws)
	}
	if err != nil {
		tx.Rollback(ctx)
		return nil, nil, db.Member{}, err
	}
	return tx, q, m, nil
}

type LabrastroAgentSquadFolder struct {
	SquadID   pgtype.UUID `json:"squad_id"`
	Name      string      `json:"name"`
	AvatarURL pgtype.Text `json:"avatar_url"`
	LeaderID  pgtype.UUID `json:"leader_id"`
	CreatorID pgtype.UUID `json:"creator_id"`
	ParentID  pgtype.UUID `json:"parent_id"`
	AgentIDs  []string    `json:"agent_ids"`
}

type LabrastroAgentFolderTree struct {
	Folders    []db.LabrastroAgentFolder            `json:"folders"`
	Placements []db.LabrastroListAgentPlacementsRow `json:"placements"`
	Squads     []LabrastroAgentSquadFolder          `json:"squads"`
}

func (h *Handler) LabrastroAgentFolderTree(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(labrastroAgentFolderInput(w), r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	q := h.Queries.WithTx(tx)
	tree, err := h.labrastroReadAgentFolderTree(ctx, r, q, a)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	writeJSON(w, 200, tree)
}

func (h *Handler) labrastroReadAgentFolderTree(ctx context.Context, r *http.Request, q *db.Queries, a labrastroSkillActor) (LabrastroAgentFolderTree, error) {
	out := LabrastroAgentFolderTree{Placements: []db.LabrastroListAgentPlacementsRow{}, Squads: []LabrastroAgentSquadFolder{}}
	m, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: a.ws, UserID: a.user})
	if err != nil {
		return out, err
	}
	if !roleAllowed(m.Role, "owner", "admin", "member") {
		return out, labrastroSkillError(403, "forbidden", "insufficient permissions")
	}
	out.Folders, err = q.LabrastroListAgentFolders(ctx, a.ws)
	if err != nil {
		return out, err
	}
	agents, err := q.ListAllAgents(ctx, a.ws)
	if err != nil {
		return out, err
	}
	ids := make([]pgtype.UUID, 0, len(agents))
	for _, agent := range agents {
		ids = append(ids, agent.ID)
	}
	targets, err := q.ListAgentInvocationTargetsByAgentIDs(ctx, ids)
	if err != nil {
		return out, err
	}
	targetsByAgent := map[pgtype.UUID][]db.AgentInvocationTarget{}
	for _, target := range targets {
		targetsByAgent[target.AgentID] = append(targetsByAgent[target.AgentID], target)
	}
	visible := map[pgtype.UUID]bool{}
	actorType, actorID := h.resolveActor(r, uuidToString(a.user), uuidToString(a.ws))
	for _, agent := range agents {
		visible[agent.ID] = actorType != "member" || memberAllowedToViewAgent(agent, targetsByAgent[agent.ID], actorID, m.Role)
	}
	members, err := q.ListSquadMemberPreviewRows(ctx, a.ws)
	if err != nil {
		return out, err
	}
	squadAgents := map[pgtype.UUID][]string{}
	for _, member := range members {
		if member.MemberType != "agent" {
			continue
		}
		if visible[member.MemberID] {
			squadAgents[member.SquadID] = append(squadAgents[member.SquadID], uuidToString(member.MemberID))
		}
	}
	squads, err := q.LabrastroListAgentSquadFolders(ctx, a.ws)
	if err != nil {
		return out, err
	}
	for _, s := range squads {
		agentIDs := squadAgents[s.SquadID]
		if agentIDs == nil {
			agentIDs = []string{}
		}
		out.Squads = append(out.Squads, LabrastroAgentSquadFolder{s.SquadID, s.Name, s.AvatarUrl, s.LeaderID, s.CreatorID, s.ParentID, agentIDs})
	}
	placements, err := q.LabrastroListAgentPlacements(ctx, a.ws)
	if err != nil {
		return out, err
	}
	for _, p := range placements {
		if visible[p.AgentID] {
			out.Placements = append(out.Placements, p)
		}
	}
	return out, nil
}

func labrastroCheckAgentFolderParent(ctx context.Context, q *db.Queries, ws, parent, moving pgtype.UUID) error {
	seen := map[pgtype.UUID]bool{}
	for parent.Valid {
		if parent == moving || seen[parent] {
			return labrastroSkillError(409, "folder_cycle", "folder move would create a cycle")
		}
		seen[parent] = true
		f, err := q.LabrastroGetAgentFolder(ctx, db.LabrastroGetAgentFolderParams{WorkspaceID: ws, ID: parent})
		if err != nil {
			return err
		}
		parent = f.ParentID
	}
	return nil
}

func (h *Handler) LabrastroCreateAgentFolder(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(labrastroAgentFolderInput(w), r)
	if !ok {
		return
	}
	var req labrastroFolderRequest
	if !labrastroDecodeAgentFolder(w, r, &req) {
		return
	}
	if !labrastroAgentFolderName(req.Name) {
		labrastroWriteAgentFolderError(w, labrastroSkillError(400, "invalid_name", "name must be 1–255 bytes without control characters or surrounding whitespace"))
		return
	}
	parent, ok := labrastroOptionalUUID(labrastroAgentFolderInput(w), req.ParentID, "parent_id")
	if !ok {
		return
	}
	ctx := r.Context()
	tx, q, _, err := h.labrastroAgentFolderTx(ctx, a)
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = labrastroCheckAgentFolderParent(ctx, q, a.ws, parent, pgtype.UUID{}); err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	f, err := q.LabrastroCreateAgentFolder(ctx, db.LabrastroCreateAgentFolderParams{ID: labrastroNewID(), WorkspaceID: a.ws, ParentID: parent, Name: req.Name})
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	writeJSON(w, 201, f)
}

func (h *Handler) LabrastroUpdateAgentFolder(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(labrastroAgentFolderInput(w), r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(labrastroAgentFolderInput(w), chi.URLParam(r, "folderId"), "folder_id")
	if !ok {
		return
	}
	var req struct {
		Name     *string `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if !labrastroDecodeAgentFolder(w, r, &req) {
		return
	}
	ctx := r.Context()
	tx, q, _, err := h.labrastroAgentFolderTx(ctx, a)
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	f, err := q.LabrastroGetAgentFolder(ctx, db.LabrastroGetAgentFolderParams{WorkspaceID: a.ws, ID: id})
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	if req.Name != nil {
		if !labrastroAgentFolderName(*req.Name) {
			labrastroWriteAgentFolderError(w, labrastroSkillError(400, "invalid_name", "invalid folder name"))
			return
		}
		f.Name = *req.Name
	}
	if req.ParentID != nil {
		f.ParentID, ok = labrastroOptionalUUID(labrastroAgentFolderInput(w), *req.ParentID, "parent_id")
		if !ok {
			return
		}
	}
	if err = labrastroCheckAgentFolderParent(ctx, q, a.ws, f.ParentID, id); err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	f, err = q.LabrastroUpdateAgentFolder(ctx, db.LabrastroUpdateAgentFolderParams{WorkspaceID: a.ws, ID: id, ParentID: f.ParentID, Name: f.Name})
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	writeJSON(w, 200, f)
}

func (h *Handler) LabrastroDeleteAgentFolder(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(labrastroAgentFolderInput(w), r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(labrastroAgentFolderInput(w), chi.URLParam(r, "folderId"), "folder_id")
	if !ok {
		return
	}
	ctx := r.Context()
	tx, q, _, err := h.labrastroAgentFolderTx(ctx, a)
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	f, err := q.LabrastroGetAgentFolder(ctx, db.LabrastroGetAgentFolderParams{WorkspaceID: a.ws, ID: id})
	// Remove the folder's name before promoting a child with that same name.
	// Any later conflict rolls back the deletion and all promotions together.
	if err == nil {
		err = q.LabrastroDeleteAgentFolder(ctx, db.LabrastroDeleteAgentFolderParams{WorkspaceID: a.ws, ID: id})
	}
	if err == nil {
		err = q.LabrastroPromoteAgentFolders(ctx, db.LabrastroPromoteAgentFoldersParams{WorkspaceID: a.ws, FolderID: id, Destination: f.ParentID})
	}
	if err == nil {
		if f.ParentID.Valid {
			err = q.LabrastroPromoteAgentPlacements(ctx, db.LabrastroPromoteAgentPlacementsParams{WorkspaceID: a.ws, FolderID: id, Destination: f.ParentID})
		} else {
			err = q.LabrastroRemoveFolderAgentPlacements(ctx, db.LabrastroRemoveFolderAgentPlacementsParams{WorkspaceID: a.ws, FolderID: id})
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

func (h *Handler) LabrastroMoveAgent(w http.ResponseWriter, r *http.Request) {
	h.labrastroMoveAgentEntry(w, r, false)
}
func (h *Handler) LabrastroMoveAgentSquad(w http.ResponseWriter, r *http.Request) {
	h.labrastroMoveAgentEntry(w, r, true)
}

func (h *Handler) labrastroMoveAgentEntry(w http.ResponseWriter, r *http.Request, squad bool) {
	a, ok := h.labrastroSkillActor(labrastroAgentFolderInput(w), r)
	if !ok {
		return
	}
	param := "agentId"
	if squad {
		param = "squadId"
	}
	id, ok := parseUUIDOrBadRequest(labrastroAgentFolderInput(w), chi.URLParam(r, param), param)
	if !ok {
		return
	}
	var req struct {
		FolderID *string `json:"folder_id"`
	}
	if !labrastroDecodeAgentFolder(w, r, &req) {
		return
	}
	if req.FolderID == nil {
		labrastroWriteAgentFolderError(w, labrastroSkillError(400, "invalid_request", "folder_id is required"))
		return
	}
	folder, ok := labrastroOptionalUUID(labrastroAgentFolderInput(w), *req.FolderID, "folder_id")
	if !ok {
		return
	}
	ctx := r.Context()
	tx, q, m, err := h.labrastroAgentFolderTx(ctx, a)
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if squad {
		s, e := q.LockSquadForAutopilotAssignment(ctx, db.LockSquadForAutopilotAssignmentParams{WorkspaceID: a.ws, ID: id})
		err = e
		if err == nil && s.ArchivedAt.Valid {
			err = pgx.ErrNoRows
		}
		if err == nil && !canManageSquad(m, s) {
			err = labrastroSkillError(403, "forbidden", "only the squad creator or a workspace admin can move it")
		}
	} else {
		agent, e := q.LabrastroLockFolderAgent(ctx, db.LabrastroLockFolderAgentParams{WorkspaceID: a.ws, ID: id})
		err = e
		if err == nil && !labrastroCanManage(agent.OwnerID, a, m) {
			err = labrastroSkillError(403, "forbidden", "only the agent owner or a workspace admin can move it")
		}
	}
	if err == nil {
		err = labrastroCheckAgentFolderParent(ctx, q, a.ws, folder, pgtype.UUID{})
	}
	if err == nil {
		switch {
		case squad && folder.Valid:
			err = q.LabrastroPlaceAgentSquad(ctx, db.LabrastroPlaceAgentSquadParams{WorkspaceID: a.ws, SquadID: id, FolderID: folder})
		case squad:
			err = q.LabrastroRemoveAgentSquadPlacement(ctx, db.LabrastroRemoveAgentSquadPlacementParams{WorkspaceID: a.ws, SquadID: id})
		case folder.Valid:
			err = q.LabrastroPlaceAgent(ctx, db.LabrastroPlaceAgentParams{WorkspaceID: a.ws, AgentID: id, FolderID: folder})
		default:
			err = q.LabrastroRemoveAgentPlacement(ctx, db.LabrastroRemoveAgentPlacementParams{WorkspaceID: a.ws, AgentID: id})
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteAgentFolderError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"updated": true})
}
