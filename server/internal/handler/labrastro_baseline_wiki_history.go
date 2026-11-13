package handler

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func wikiPagination(r *http.Request, maxLimit, defaultLimit int32) (int32, int32, string, error) {
	query := r.URL.Query()
	limit := defaultLimit
	if value := query.Get("limit"); value != "" {
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 {
			return 0, 0, "", baselineError(400, "invalid_request")
		}
		limit = min(int32(n), maxLimit)
	}
	before := int32(0)
	if value := query.Get("before"); value != "" {
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 {
			return 0, 0, "", baselineError(400, "invalid_request")
		}
		before = int32(n)
	}
	withContent := query.Get("with_content")
	if withContent != "" && withContent != "true" && withContent != "false" {
		return 0, 0, "", baselineError(400, "invalid_request")
	}
	return limit, before, withContent, nil
}

func (h *Handler) LabrastroWikiPageHistory(w http.ResponseWriter, r *http.Request) {
	limit, before, withContent, err := wikiPagination(r, 200, 50)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	pages, err := s.q.LabrastroListBaselinePages(r.Context(), db.LabrastroListBaselinePagesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	i := engineering.WikiTree(pages).Resolve(chi.URLParam(r, "page"))
	if i < 0 {
		writeEngineeringError(w, pgx.ErrNoRows)
		return
	}
	page := pages[i]
	var revisions []db.ProjectBaselineRevision
	if withContent == "false" {
		summaries, err := s.q.LabrastroListBaselineWikiRevisionSummaries(r.Context(), db.LabrastroListBaselineWikiRevisionSummariesParams{
			WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: page.ID,
			BeforeNumber: pgtype.Int4{Int32: before, Valid: before > 0}, PageLimit: limit + 1,
		})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		revisions = make([]db.ProjectBaselineRevision, 0, len(summaries))
		for _, row := range summaries {
			revisions = append(revisions, db.ProjectBaselineRevision{
				ID: row.ID, WorkspaceID: row.WorkspaceID, ProjectID: row.ProjectID,
				PageID: row.PageID, RevisionNumber: row.RevisionNumber, RevisionKind: row.RevisionKind,
				Title: row.Title, Slug: row.Slug, ParentID: row.ParentID, Position: row.Position,
				ArchivedAt: row.ArchivedAt, ContentMarkdown: row.ContentMarkdown,
				ChangeSummary: row.ChangeSummary, BaseRevisionID: row.BaseRevisionID,
				RestoredFromRevisionID: row.RestoredFromRevisionID, SourceIssueID: row.SourceIssueID,
				CreatedByType: row.CreatedByType, CreatedByID: row.CreatedByID,
				CreatedByTaskID: row.CreatedByTaskID, CreatedAt: row.CreatedAt,
			})
		}
	} else {
		revisions, err = s.q.LabrastroListBaselineWikiRevisions(r.Context(), db.LabrastroListBaselineWikiRevisionsParams{
			WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: page.ID,
			BeforeNumber: pgtype.Int4{Int32: before, Valid: before > 0}, PageLimit: limit + 1,
		})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
	}
	more := len(revisions) > int(limit)
	if more {
		revisions = revisions[:limit]
	}
	out := make([]wikiRevisionResponse, 0, len(revisions))
	for _, revision := range revisions {
		out = append(out, wikiRevisionJSON(revision))
	}
	var nextBefore *int32
	if more {
		n := revisions[len(revisions)-1].RevisionNumber
		nextBefore = &n
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"revisions": out, "has_more": more, "next_before": nextBefore})
}

func (h *Handler) LabrastroWikiPageRevision(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.ParseInt(chi.URLParam(r, "n"), 10, 32)
	if err != nil || n < 1 {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	pages, err := s.q.LabrastroListBaselinePages(r.Context(), db.LabrastroListBaselinePagesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	i := engineering.WikiTree(pages).Resolve(chi.URLParam(r, "page"))
	if i < 0 {
		writeEngineeringError(w, pgx.ErrNoRows)
		return
	}
	revision, err := s.wikiRevisionByNumber(r.Context(), pages[i].ID, int32(n))
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"page": wikiPageJSON(pages[i]), "revision": wikiRevisionJSON(revision)})
}

func (h *Handler) LabrastroWikiPageDiff(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	number := func(key string) (int32, bool) {
		value := query.Get(key)
		if value == "" {
			return 0, true
		}
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 {
			return 0, false
		}
		return int32(n), true
	}
	from, ok := number("from")
	if !ok {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	to, ok := number("to")
	if !ok {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	if from == 0 {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	pages, err := s.q.LabrastroListBaselinePages(r.Context(), db.LabrastroListBaselinePagesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	i := engineering.WikiTree(pages).Resolve(chi.URLParam(r, "page"))
	if i < 0 {
		writeEngineeringError(w, pgx.ErrNoRows)
		return
	}
	page := pages[i]
	if to == 0 {
		to = page.LastRevisionNumber
	}
	old, err := s.wikiRevisionByNumber(r.Context(), page.ID, from)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	next, err := s.wikiRevisionByNumber(r.Context(), page.ID, to)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	structure := engineering.WikiStructureDiff(pages, old, next)
	sections, err := engineering.Compute(old.ContentMarkdown, next.ContentMarkdown, from)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"structure": structure, "sections": sections})
}

type rollbackWikiPageRequest struct {
	RevisionNumber     *int32  `json:"revision_number"`
	BaseRevisionNumber *int32  `json:"base_revision_number"`
	ContentOnly        bool    `json:"content_only"`
	ChangeSummary      *string `json:"change_summary"`
	SourceIssueID      *string `json:"source_issue_id"`
}

func (h *Handler) LabrastroRollbackWikiPage(w http.ResponseWriter, r *http.Request) {
	actor, err := engineeringActor(r)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var req rollbackWikiPageRequest
	if !decodeEngineering(w, r, &req) {
		return
	}
	if req.RevisionNumber == nil || *req.RevisionNumber < 1 || req.BaseRevisionNumber == nil || *req.BaseRevisionNumber < 1 {
		writeErrorCode(w, 400, "invalid_request", "revision_number and base_revision_number are required")
		return
	}
	if !wikiChangeSummaryValid(req.ChangeSummary) {
		writeErrorCode(w, 422, "invalid_request", "change summary exceeds 500 characters")
		return
	}
	source, ok := wikiOptionalUUID(w, req.SourceIssueID, "source_issue_id")
	if !ok {
		return
	}
	s, ok := h.engineeringState(w, r, true)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	if err := s.wikiRequireEnabled(); err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err := s.wikiValidateSourceIssue(r.Context(), source); err != nil {
		writeEngineeringError(w, err)
		return
	}
	target, ok := s.wikiWriteTarget(r.Context(), w, chi.URLParam(r, "page"), *req.BaseRevisionNumber, false)
	if !ok {
		return
	}
	page := target.pages[target.index]
	if !s.wikiCheckConflict(w, target, "rollback", "") {
		return
	}
	restore, err := s.wikiRevisionByNumber(r.Context(), page.ID, *req.RevisionNumber)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	suffix := strconv.FormatInt(int64(restore.RevisionNumber), 10)
	if req.ContentOnly {
		if page.ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_page_archived"))
			return
		}
		summary := wikiSummary(firstNonNil(req.ChangeSummary), "仅回滚正文到 v"+suffix)
		revision, err := s.wikiInsertRevision(r.Context(), &page, "rollback", restore.ContentMarkdown, summary, target.base.ID, restore.ID, source, actor)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if err = s.tx.Commit(r.Context()); err != nil {
			writeEngineeringError(w, err)
			return
		}
		h.wikiChanged(s, actor, page, "content", revision.RevisionNumber)
		writeJSON(w, 201, map[string]any{"page": wikiPageJSON(page), "revision": wikiRevisionJSON(revision)})
		return
	}
	// Full snapshot restore validates the tree invariants first.
	if restore.Slug != page.Slug {
		for j, other := range target.pages {
			if j != target.index && other.Slug == restore.Slug {
				writeEngineeringError(w, baselineError(409, "baseline_slug_taken"))
				return
			}
		}
	}
	if restore.ParentID.Valid {
		j := engineering.WikiTree(target.pages).IndexByID(restore.ParentID)
		if j < 0 || target.pages[j].ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
		if engineering.WikiTree(target.pages).IsDescendantOrSelf(page.ID, restore.ParentID) {
			writeEngineeringError(w, baselineError(409, "baseline_page_cycle"))
			return
		}
		if engineering.WikiTree(target.pages).Depth(restore.ParentID)+engineering.WikiTree(target.pages).SubtreeHeight(page.ID) > engineering.MaxWikiDepth {
			writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
			return
		}
	}
	oldParent := page.ParentID
	order, insertAt := engineering.WikiTree(target.pages).InsertAt(restore.ParentID, target.index, restore.Position)
	if oldParent != restore.ParentID {
		origin := engineering.WikiTree(target.pages).SiblingsExcept(oldParent, target.index)
		if err := s.wikiWritePositions(r.Context(), target.pages, origin); err != nil {
			writeEngineeringError(w, err)
			return
		}
	}
	page.Title, page.Slug, page.ParentID = restore.Title, restore.Slug, restore.ParentID
	target.pages[target.index] = page
	page.Position = insertAt
	page.ArchivedAt = pgtype.Timestamptz{} // a rollback always ends unarchived
	if err := s.q.LabrastroSetBaselinePage(r.Context(), db.LabrastroSetBaselinePageParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: page.ID,
		ParentID: page.ParentID, Position: page.Position, ArchivedAt: page.ArchivedAt,
	}); err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err := s.q.LabrastroRenameBaselinePage(r.Context(), db.LabrastroRenameBaselinePageParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: page.ID, Title: page.Title, Slug: page.Slug,
	}); err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err := s.wikiWritePositions(r.Context(), target.pages, order); err != nil {
		writeEngineeringError(w, err)
		return
	}
	summary := wikiSummary(firstNonNil(req.ChangeSummary), "回滚到 v"+suffix)
	revision, err := s.wikiInsertRevision(r.Context(), &page, "rollback", restore.ContentMarkdown, summary, target.base.ID, restore.ID, source, actor)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.wikiChanged(s, actor, page, "content", revision.RevisionNumber)
	writeJSON(w, 201, map[string]any{"page": wikiPageJSON(page), "revision": wikiRevisionJSON(revision)})
}
