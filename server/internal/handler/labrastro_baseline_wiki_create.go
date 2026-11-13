package handler

import (
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type createWikiPageRequest struct {
	Title           string  `json:"title"`
	Slug            *string `json:"slug"`
	Parent          *string `json:"parent"`
	After           *string `json:"after"`
	ContentMarkdown *string `json:"content_markdown"`
	ChangeSummary   *string `json:"change_summary"`
	SourceIssueID   *string `json:"source_issue_id"`
}

func (h *Handler) LabrastroCreateWikiPage(w http.ResponseWriter, r *http.Request) {
	actor, err := engineeringActor(r)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var req createWikiPageRequest
	if !decodeEngineering(w, r, &req) {
		return
	}
	if !engineering.ValidWikiTitle(req.Title) {
		writeErrorCode(w, 400, "invalid_request", "title must be 1-200 characters without line breaks")
		return
	}
	content := ""
	if req.ContentMarkdown != nil {
		content = *req.ContentMarkdown
	}
	if err := engineering.ValidateContent(content); err != nil {
		writeEngineeringError(w, err)
		return
	}
	slug := ""
	if req.Slug != nil {
		slug = *req.Slug
		if !engineering.ValidSlug(slug) {
			writeErrorCode(w, 400, "invalid_request", "slug must match ^[a-z0-9][a-z0-9_-]{0,62}$ and not be a UUID")
			return
		}
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
	pages, err := s.q.LabrastroListBaselinePages(r.Context(), db.LabrastroListBaselinePagesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var parent pgtype.UUID
	if req.Parent != nil && *req.Parent != "" && *req.Parent != "root" {
		i := engineering.WikiTree(pages).Resolve(*req.Parent)
		if i < 0 {
			writeEngineeringError(w, pgx.ErrNoRows)
			return
		}
		if pages[i].ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
		parent = pages[i].ID
	}
	if slug == "" {
		slug = engineering.WikiTree(pages).GenerateSlug()
	}
	for _, p := range pages {
		if p.Slug == slug {
			writeEngineeringError(w, baselineError(409, "baseline_slug_taken"))
			return
		}
	}
	visible := 0
	for _, p := range pages {
		if !p.ArchivedAt.Valid {
			visible++
		}
	}
	if visible >= engineering.MaxWikiPages {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_large"))
		return
	}
	siblings := engineering.WikiTree(pages).Siblings(parent)
	if len(siblings) >= engineering.MaxWikiSiblings {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_large"))
		return
	}
	if parent.Valid && engineering.WikiTree(pages).Depth(parent)+1 > engineering.MaxWikiDepth {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
		return
	}
	order, insertAt := engineering.WikiTree(pages).InsertAfter(parent, len(pages), req.After)
	// The placeholder reserves the new index; its initial position is already
	// persisted by the insert below, so wikiWritePositions only updates siblings.
	pages = append(pages, db.ProjectBaselinePage{Position: insertAt})
	page, err := s.q.LabrastroCreateBaselinePage(r.Context(), db.LabrastroCreateBaselinePageParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ParentID: parent,
		Slug: slug, Title: req.Title, Position: insertAt, CurrentRevisionID: wikiZeroUUID(),
		LastRevisionNumber: 0,
	})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	summary := wikiSummary(firstNonNil(req.ChangeSummary), "新建页面")
	revision, err := s.wikiInsertRevision(r.Context(), &page, "create", content, summary, pgtype.UUID{}, pgtype.UUID{}, source, actor)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err := s.wikiWritePositions(r.Context(), pages, order); err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.wikiChanged(s, actor, page, "tree", revision.RevisionNumber)
	writeJSON(w, 201, map[string]any{"page": wikiPageJSON(page), "revision": wikiRevisionJSON(revision)})
}
