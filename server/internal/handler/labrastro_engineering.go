package handler

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Engineering context is optional: any failed read leaves the original project
// description intact, without blocking task claims or writing derived text back.
func (h *Handler) appendEngineeringProjectDescription(ctx context.Context, workspaceID, projectID pgtype.UUID, baseDescription string) string {
	config, err := h.Queries.LabrastroGetEngineering(ctx, db.LabrastroGetEngineeringParams{WorkspaceID: workspaceID, ProjectID: projectID})
	if err != nil || !config.Enabled {
		return baseDescription
	}
	var stages []engineeringStage
	if err := json.Unmarshal(config.Stages, &stages); err != nil {
		return baseDescription
	}
	pages, err := h.Queries.LabrastroListBaselinePages(ctx, db.LabrastroListBaselinePagesParams{WorkspaceID: workspaceID, ProjectID: projectID})
	if err != nil {
		return baseDescription
	}
	bodies, err := h.Queries.LabrastroListBaselinePageBodies(ctx, db.LabrastroListBaselinePageBodiesParams{WorkspaceID: workspaceID, ProjectID: projectID})
	if err != nil {
		return baseDescription
	}
	pid := uuidToString(projectID)
	numbers, contents := map[string]int32{}, map[string]string{}
	for _, b := range bodies {
		numbers[b.Slug] = b.RevisionNumber
		contents[b.Slug] = b.ContentMarkdown
	}

	stageLine := fmt.Sprintf("当前主攻：Stage %d", config.CurrentStage)
	for _, stage := range stages {
		if stage.Stage == int64(config.CurrentStage) {
			stageLine += " · " + engineeringContextText(stage.Title, 60)
			if goal := engineeringContextText(stage.Goal, 280); goal != "" {
				stageLine += "；目标：" + goal
			}
			break
		}
	}
	lines := []string{"### 工程管理", stageLine}
	if mode := engineeringContextText(config.ModeSummary, 280); mode != "" {
		lines = append(lines, "推进方针："+mode)
	}

	visible := 0
	for _, p := range pages {
		if !p.ArchivedAt.Valid {
			visible++
		}
	}
	directory := append([]string{}, fmt.Sprintf("基线 Wiki 目录（共 %d 页；slug 标题 vN）：", visible))
	type treeLine struct {
		text  string
		depth int
	}
	var walk func(page db.ProjectBaselinePage, depth int)
	var flat []treeLine
	walk = func(page db.ProjectBaselinePage, depth int) {
		if depth > engineering.MaxWikiDepth {
			return
		}
		line := fmt.Sprintf("%s %s v%d", page.Slug, engineeringContextText(page.Title, 60), numbers[page.Slug])
		if depth == 1 {
			headings, err := engineering.Index(contents[page.Slug])
			if err == nil {
				var titles []string
				for _, heading := range headings {
					if heading.Title != "" && heading.Level <= 2 {
						titles = append(titles, heading.Title)
					}
				}
				if outline := engineeringContextText(strings.Join(titles, "；"), 120); outline != "" {
					line += "：" + outline
				}
			}
		}
		flat = append(flat, treeLine{line, depth})
		var children []db.ProjectBaselinePage
		for _, other := range pages {
			if !other.ArchivedAt.Valid && other.ParentID == page.ID {
				children = append(children, other)
			}
		}
		slices.SortFunc(children, func(a, b db.ProjectBaselinePage) int { return cmp.Compare(a.Position, b.Position) })
		for _, child := range children {
			walk(child, depth+1)
		}
	}
	roots := []db.ProjectBaselinePage{}
	for _, p := range pages {
		if !p.ArchivedAt.Valid && !p.ParentID.Valid {
			roots = append(roots, p)
		}
	}
	slices.SortFunc(roots, func(a, b db.ProjectBaselinePage) int { return cmp.Compare(a.Position, b.Position) })
	for _, root := range roots {
		walk(root, 1)
	}

	overflow := func(rest int) string {
		return fmt.Sprintf("- 另有 %d 页，用 `multica project baseline tree %s` 查看", rest, pid)
	}
	tail := []string{
		fmt.Sprintf("本项目已启用工程管理（Project ID: %s）。读：先 `multica project baseline tree %s` 看目录，再 `multica project baseline get %s --page <slug> [--section \"<小节>\"]` 按需读取。", pid, pid, pid),
		fmt.Sprintf("写（人机同权直写，带读取时的修订号）：`multica project baseline write %s --page <slug> [--section \"<小节>\"] --content-file <文件> --base <N> [--summary \"…\"] [--source-issue <Issue>]`；退出码 3 表示冲突，先重读再合并。", pid),
		"如已绑定 strixnova-* 系列工程 skill，请按对应 skill 规程调用相关能力。",
	}
	if len(flat) == 0 {
		lines = append(lines, "当前 Wiki 尚无页面，可先 `multica project baseline create` 建页")
	} else {
		remaining := engineeringContextBudget - engineeringContextRunes(lines) - engineeringContextRunes(directory) - engineeringContextRunes(tail)
		listed := 0
		for i, item := range flat {
			// Depth beyond 3 never lists but must not stop the walk: later
			// roots still list, and deep pages only count toward the overflow.
			if item.depth > 3 {
				continue
			}
			line := "- " + strings.Repeat("  ", item.depth-1) + item.text
			if engineeringContextRunes([]string{line, overflow(len(flat) - i - 1)}) > remaining {
				break
			}
			remaining -= engineeringContextRunes([]string{line})
			directory = append(directory, line)
			listed++
		}
		if listed < len(flat) {
			directory = append(directory, overflow(len(flat)-listed))
		}
		lines = append(lines, directory...)
	}
	lines = append(lines, tail...)
	summary := strings.Join(lines, "\n")
	if baseDescription == "" {
		return summary
	}
	return baseDescription + "\n\n" + summary
}

// engineeringContextBudget bounds the claim summary in runes.
const engineeringContextBudget = 2000

// engineeringContextRunes counts lines as joined with newlines.
func engineeringContextRunes(lines []string) int {
	n := 0
	for _, line := range lines {
		n += utf8.RuneCountInString(line) + 1
	}
	return n
}

// Keep free-form configuration and headings on one bounded line per summary item.
func engineeringContextText(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	if utf8.RuneCountInString(value) > limit {
		return string([]rune(value)[:limit-3]) + "..."
	}
	return value
}

func (h *Handler) RegisterLabrastroEngineeringRoutes(r chi.Router) {
	r.Get("/api/projects/{id}/engineering", h.LabrastroGetEngineering)
	r.Get("/api/projects/{id}/baseline/pages/{page}/threads", h.LabrastroWikiThreads)
	r.Post("/api/projects/{id}/baseline/pages/{page}/threads", h.LabrastroCreateWikiThread)
	r.Get("/api/projects/{id}/baseline/threads/{thread}", h.LabrastroWikiThread)
	r.Post("/api/projects/{id}/baseline/threads/{thread}/comments", h.LabrastroReplyWikiThread)
	r.Patch("/api/projects/{id}/baseline/comments/{comment}", h.LabrastroEditWikiComment)
	r.Delete("/api/projects/{id}/baseline/comments/{comment}", h.LabrastroDeleteWikiComment)
	r.Post("/api/projects/{id}/baseline/threads/{thread}/resolve", h.LabrastroResolveWikiThread)
	r.Get("/api/projects/{id}/baseline/tree", h.LabrastroWikiTree)
	r.Post("/api/projects/{id}/baseline/pages", h.LabrastroCreateWikiPage)
	r.Get("/api/projects/{id}/baseline/pages/{page}", h.LabrastroReadWikiPage)
	r.Put("/api/projects/{id}/baseline/pages/{page}/content", h.LabrastroWriteWikiPageContent)
	r.Patch("/api/projects/{id}/baseline/pages/{page}", h.LabrastroPatchWikiPage)
	r.Post("/api/projects/{id}/baseline/pages/{page}/archive", h.LabrastroArchiveWikiPage)
	r.Post("/api/projects/{id}/baseline/pages/{page}/restore", h.LabrastroRestoreWikiPage)
	r.Get("/api/projects/{id}/baseline/pages/{page}/revisions", h.LabrastroWikiPageHistory)
	r.Get("/api/projects/{id}/baseline/pages/{page}/revisions/{n}", h.LabrastroWikiPageRevision)
	r.Get("/api/projects/{id}/baseline/pages/{page}/diff", h.LabrastroWikiPageDiff)
	r.Post("/api/projects/{id}/baseline/pages/{page}/rollback", h.LabrastroRollbackWikiPage)
	r.Get("/api/projects/{id}/baseline/pages/{page}/backlinks", h.LabrastroWikiPageBacklinks)
	r.Get("/api/projects/{id}/baseline/activity", h.LabrastroWikiActivity)
	r.Get("/api/projects/{id}/baseline/search", h.LabrastroWikiSearch)
	r.With(RequireHumanActor).Patch("/api/projects/{id}/engineering", h.LabrastroPatchEngineering)
	// The candidate/annotation pipeline is retired; clients get one stable
	// pointer instead of route-not-found noise.
	for _, route := range []struct {
		method, path string
	}{
		{"GET", "/api/projects/{id}/baseline"},
		{"POST", "/api/projects/{id}/baseline/candidates"},
		{"POST", "/api/projects/{id}/baseline/decisions"},
		{"GET", "/api/projects/{id}/baseline/revisions"},
		{"POST", "/api/projects/{id}/baseline/reviews"},
		{"GET", "/api/projects/{id}/baseline/annotation-batches"},
		{"GET", "/api/projects/{id}/baseline/annotation-batches/{batch}"},
		{"POST", "/api/projects/{id}/baseline/annotation-batches/{batch}/close"},
		{"POST", "/api/projects/{id}/baseline/annotations/responses"},
		{"POST", "/api/projects/{id}/baseline/annotations/resolve"},
	} {
		switch route.method {
		case "GET":
			r.Get(route.path, writeBaselineAPIRetired)
		case "POST":
			r.Post(route.path, writeBaselineAPIRetired)
		}
	}
}

func writeBaselineAPIRetired(w http.ResponseWriter, _ *http.Request) {
	writeErrorCode(w, http.StatusGone, "baseline_api_retired", "the candidate and annotation baseline API is retired; use the baseline wiki page endpoints")
}

type engineeringError struct {
	status        int
	code, message string
}

func (e *engineeringError) Error() string { return e.code }
func baselineError(status int, code string) error {
	return &engineeringError{status, code, strings.ReplaceAll(code, "_", " ")}
}
func writeEngineeringError(w http.ResponseWriter, err error) {
	var e *engineeringError
	var invalid *engineering.Error
	switch {
	case errors.As(err, &e):
		writeErrorCode(w, e.status, e.code, e.message)
	case errors.As(err, &invalid):
		status := 422
		if invalid.Code == "baseline_section_not_found" {
			status = 404
		}
		if invalid.Code == "invalid_request" {
			status = 400
		}
		writeErrorCode(w, status, invalid.Code, "invalid baseline content")
	case errors.Is(err, pgx.ErrNoRows):
		writeErrorCode(w, 404, "not_found", "project or revision not found")
	default:
		writeErrorCode(w, 500, "engineering_failed", "project engineering operation failed")
	}
}

func decodeEngineering(w http.ResponseWriter, r *http.Request, out any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || len(body) == 0 || body[0] != '{' {
		writeErrorCode(w, 400, "invalid_request", "expected one JSON object")
		return false
	}
	fields := json.NewDecoder(strings.NewReader(string(body)))
	fields.DisallowUnknownFields()
	if err := fields.Decode(out); err != nil {
		writeErrorCode(w, 400, "invalid_request", "invalid request body")
		return false
	}
	if fields.Decode(new(any)) != io.EOF {
		writeErrorCode(w, 400, "invalid_request", "expected one JSON object")
		return false
	}
	return true
}

type baselineActor struct {
	kind, credential string
	id, task         pgtype.UUID
}

func engineeringActor(r *http.Request) (baselineActor, error) {
	denied := baselineError(403, "baseline_credential_denied")
	identity, hasIdentity := auth.IdentityFromContext(r.Context())
	source := r.Header.Get("X-Actor-Source")
	if isMachineCredentialActor(r) {
		if source != "task_token" || !hasIdentity || identity.CredentialKind != "task" || identity.WorkspaceID != r.Header.Get("X-Workspace-ID") {
			return baselineActor{}, denied
		}
		agent, err := util.ParseUUID(identity.AgentID)
		if err != nil {
			return baselineActor{}, denied
		}
		task, err := util.ParseUUID(identity.TaskID)
		if err != nil {
			return baselineActor{}, denied
		}
		return baselineActor{"agent", "agent_task", agent, task}, nil
	}
	if source != "" {
		return baselineActor{}, denied
	}
	user, err := util.ParseUUID(r.Header.Get("X-User-ID"))
	if err != nil {
		return baselineActor{}, denied
	}
	credential := "session"
	if hasIdentity {
		if identity.CredentialKind != "pat" || identity.UserID != r.Header.Get("X-User-ID") {
			return baselineActor{}, denied
		}
		credential = "pat"
	}
	return baselineActor{"member", credential, user, pgtype.UUID{}}, nil
}

type engineeringState struct {
	tx          pgx.Tx
	q           *db.Queries
	project     db.Project
	member      db.Member
	config      db.ProjectEngineering
	issuePrefix string
}

// Hold the workspace lifetime before the project lock, matching teardown. The
// project lock also protects the missing-config/missing-doc first-write case.
func (h *Handler) engineeringState(w http.ResponseWriter, r *http.Request, write bool) (*engineeringState, bool) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return nil, false
	}
	member, ok := h.requireWorkspaceMember(w, r, uuidToString(project.WorkspaceID), "project not found")
	if !ok {
		return nil, false
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeEngineeringError(w, err)
		return nil, false
	}
	s := &engineeringState{tx: tx, q: h.Queries.WithTx(tx), project: project, member: member}
	fail := func(err error) (*engineeringState, bool) {
		tx.Rollback(r.Context())
		writeEngineeringError(w, err)
		return nil, false
	}
	if _, err = s.q.LockWorkspaceForChatSessionCreate(r.Context(), project.WorkspaceID); err != nil {
		return fail(err)
	}
	workspace, err := s.q.GetWorkspace(r.Context(), project.WorkspaceID)
	if err != nil {
		return fail(err)
	}
	s.issuePrefix = workspace.IssuePrefix
	if write {
		s.project, err = s.q.LabrastroLockEngineeringProject(r.Context(), db.LabrastroLockEngineeringProjectParams{WorkspaceID: project.WorkspaceID, ID: project.ID})
	} else {
		s.project, err = s.q.LabrastroReadEngineeringProject(r.Context(), db.LabrastroReadEngineeringProjectParams{WorkspaceID: project.WorkspaceID, ID: project.ID})
	}
	if err != nil {
		return fail(err)
	}
	s.member, err = s.q.LabrastroLockEngineeringMember(r.Context(), db.LabrastroLockEngineeringMemberParams{WorkspaceID: project.WorkspaceID, UserID: member.UserID})
	if err != nil {
		return fail(err)
	}
	s.config, err = s.q.LabrastroGetEngineering(r.Context(), db.LabrastroGetEngineeringParams{WorkspaceID: project.WorkspaceID, ProjectID: project.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		s.config = db.ProjectEngineering{WorkspaceID: project.WorkspaceID, ProjectID: project.ID, CurrentStage: 1, Stages: []byte("[]"), DeciderMemberIds: []pgtype.UUID{}}
		err = nil
	}
	if err != nil {
		return fail(err)
	}
	return s, true
}

// release ends a read-only snapshot once its rows are loaded, so streaming a
// large response to a slow client does not hold the project and member share
// locks that wiki writes and project edits wait on.
func (s *engineeringState) release(ctx context.Context) {
	_ = s.tx.Rollback(ctx)
}

func (s *engineeringState) isDecider() bool {
	if roleAllowed(s.member.Role, "owner", "admin") {
		return true
	}
	if len(s.config.DeciderMemberIds) > 0 {
		return slices.Contains(s.config.DeciderMemberIds, s.member.UserID)
	}
	return s.project.LeadType.String == "member" && s.project.LeadID == s.member.UserID
}

// with_chapters=false returns the PATCH response shape for callers that only
// need the configuration. Old desktop clients still read `chapters`, so the
// key stays with an empty list.
func (h *Handler) LabrastroGetEngineering(w http.ResponseWriter, r *http.Request) {
	withChapters := r.URL.Query().Get("with_chapters")
	if withChapters != "" && withChapters != "true" && withChapters != "false" {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"engineering": engineeringConfigResponse{s.config, json.RawMessage(s.config.Stages)}, "chapters": []any{}})
}

type engineeringConfigResponse struct {
	db.ProjectEngineering
	Stages json.RawMessage `json:"stages"`
}

type engineeringStage struct {
	Stage int64  `json:"stage"`
	Title string `json:"title"`
	Goal  string `json:"goal"`
}

type patchEngineeringRequest struct {
	Stages *[]struct {
		Stage json.RawMessage `json:"stage"`
		Title json.RawMessage `json:"title"`
		Goal  json.RawMessage `json:"goal"`
	} `json:"stages"`
	Enabled          *bool     `json:"enabled"`
	CurrentStage     *int32    `json:"current_stage"`
	ModeSummary      *string   `json:"mode_summary"`
	DeciderMemberIDs *[]string `json:"decider_member_ids"`
}

func (h *Handler) LabrastroPatchEngineering(w http.ResponseWriter, r *http.Request) {
	actor, err := engineeringActor(r)
	if err != nil || actor.kind != "member" {
		writeError(w, 403, "this endpoint is only available to human actors")
		return
	}
	var req patchEngineeringRequest
	if !decodeEngineering(w, r, &req) {
		return
	}
	if req.CurrentStage != nil && *req.CurrentStage < 1 || req.ModeSummary != nil && utf8.RuneCountInString(*req.ModeSummary) > 280 {
		writeErrorCode(w, 422, "invalid_request", "invalid engineering configuration")
		return
	}
	var stages []byte
	if req.Stages != nil {
		normalized := make([]engineeringStage, 0, len(*req.Stages))
		seen := map[int64]bool{}
		if len(*req.Stages) > 50 {
			writeErrorCode(w, 422, "invalid_request", "stages must contain at most 50 entries")
			return
		}
		for _, item := range *req.Stages {
			var stage int64
			var title, goal string
			if json.Unmarshal(item.Stage, &stage) != nil || json.Unmarshal(item.Title, &title) != nil ||
				len(item.Goal) > 0 && (string(item.Goal) == "null" || json.Unmarshal(item.Goal, &goal) != nil) ||
				strings.ContainsAny(title+goal, "\r\n\x00") {
				writeErrorCode(w, 422, "invalid_request", "invalid stage number, title or goal")
				return
			}
			title, goal = strings.TrimSpace(title), strings.TrimSpace(goal)
			if stage < 1 || seen[stage] ||
				utf8.RuneCountInString(title) < 1 || utf8.RuneCountInString(title) > 60 || utf8.RuneCountInString(goal) > 280 {
				writeErrorCode(w, 422, "invalid_request", "invalid stage number, title or goal")
				return
			}
			seen[stage] = true
			normalized = append(normalized, engineeringStage{stage, title, goal})
		}
		slices.SortFunc(normalized, func(a, b engineeringStage) int { return cmp.Compare(a.Stage, b.Stage) })
		stages, _ = json.Marshal(normalized)
	}
	var deciders []pgtype.UUID
	if req.DeciderMemberIDs != nil {
		deciders = []pgtype.UUID{}
		for _, id := range *req.DeciderMemberIDs {
			uid, ok := parseUUIDOrBadRequest(w, id, "decider_member_ids")
			if !ok {
				return
			}
			if !slices.Contains(deciders, uid) {
				deciders = append(deciders, uid)
			}
		}
	}
	s, ok := h.engineeringState(w, r, true)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	admin := roleAllowed(s.member.Role, "owner", "admin")
	if !s.isDecider() || !admin && (req.Enabled != nil || req.DeciderMemberIDs != nil) {
		writeEngineeringError(w, baselineError(403, "engineering_not_decider"))
		return
	}
	config := s.config
	if stages != nil {
		config.Stages = stages
	}
	if req.Enabled != nil {
		config.Enabled = *req.Enabled
	}
	if req.CurrentStage != nil {
		config.CurrentStage = *req.CurrentStage
	}
	if req.ModeSummary != nil {
		config.ModeSummary = *req.ModeSummary
	}
	if deciders != nil {
		for _, uid := range deciders {
			if _, err := s.q.LabrastroLockEngineeringMember(r.Context(), db.LabrastroLockEngineeringMemberParams{WorkspaceID: s.project.WorkspaceID, UserID: uid}); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeErrorCode(w, 422, "invalid_request", "deciders must be current workspace members")
				} else {
					writeEngineeringError(w, err)
				}
				return
			}
		}
		config.DeciderMemberIds = deciders
	}
	s.config, err = s.q.LabrastroPutEngineering(r.Context(), db.LabrastroPutEngineeringParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, Enabled: config.Enabled, CurrentStage: config.CurrentStage, ModeSummary: config.ModeSummary, DeciderMemberIds: config.DeciderMemberIds, UpdatedByType: actor.kind, UpdatedByID: actor.id, Stages: config.Stages})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.publish(protocol.EventProjectEngineeringUpdated, uuidToString(s.project.WorkspaceID), actor.kind, uuidToString(actor.id), map[string]any{"project_id": uuidToString(s.project.ID)})
	writeJSON(w, 200, map[string]any{"engineering": engineeringConfigResponse{s.config, json.RawMessage(s.config.Stages)}})
}

func (h *Handler) wikiChanged(s *engineeringState, a baselineActor, page db.ProjectBaselinePage, change string, number int32) {
	h.publish(protocol.EventProjectBaselineChanged, uuidToString(s.project.WorkspaceID), a.kind, uuidToString(a.id), map[string]any{
		"project_id": uuidToString(s.project.ID), "page_id": uuidToString(page.ID), "slug": page.Slug, "change": change, "revision_number": number,
	})
}

func deleteWorkspaceEngineeringAndProjects(ctx context.Context, q *db.Queries, workspace pgtype.UUID) error {
	if err := q.LabrastroDeleteWorkspaceEngineering(ctx, workspace); err != nil {
		return err
	}
	return q.DeleteWorkspaceRuntimesAndProjects(ctx, workspace)
}

func deleteProjectEngineering(ctx context.Context, q *db.Queries, workspaceID, projectID pgtype.UUID) error {
	return q.LabrastroDeleteProjectEngineering(ctx, db.LabrastroDeleteProjectEngineeringParams{WorkspaceID: workspaceID, ProjectID: projectID})
}
