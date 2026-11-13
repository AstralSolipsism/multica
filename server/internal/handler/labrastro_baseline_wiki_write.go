package handler

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// wikiWriteTarget loads the target page plus its current/base revisions and
// enforces the shared gates: a valid base number and, for most operations,
// that the page is not archived.
type wikiTarget struct {
	pages   []db.ProjectBaselinePage
	index   int
	current db.ProjectBaselineRevision
	base    db.ProjectBaselineRevision
	window  []db.ProjectBaselineRevision
}

func (s *engineeringState) wikiWriteTarget(ctx context.Context, w http.ResponseWriter, pageRef string, base int32, requireUnarchived bool) (*wikiTarget, bool) {
	pages, err := s.q.LabrastroListBaselinePages(ctx, db.LabrastroListBaselinePagesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		writeEngineeringError(w, err)
		return nil, false
	}
	i := engineering.WikiTree(pages).Resolve(pageRef)
	if i < 0 {
		writeEngineeringError(w, pgx.ErrNoRows)
		return nil, false
	}
	page := pages[i]
	current, err := s.wikiRevisionByNumber(ctx, page.ID, page.LastRevisionNumber)
	if err != nil {
		writeEngineeringError(w, err)
		return nil, false
	}
	if requireUnarchived && page.ArchivedAt.Valid {
		writeEngineeringError(w, baselineError(409, "baseline_page_archived"))
		return nil, false
	}
	if base < 1 || base > page.LastRevisionNumber {
		s.writeWikiConflict(w, current)
		return nil, false
	}
	baseRevision, err := s.wikiRevisionByNumber(ctx, page.ID, base)
	if err != nil {
		s.writeWikiConflict(w, current)
		return nil, false
	}
	window, err := s.wikiWindow(ctx, page.ID, base, page.LastRevisionNumber)
	if err != nil {
		writeEngineeringError(w, err)
		return nil, false
	}
	return &wikiTarget{pages: pages, index: i, current: current, base: baseRevision, window: window}, true
}

func (s *engineeringState) wikiCheckConflict(w http.ResponseWriter, target *wikiTarget, kind, section string) bool {
	conflict, err := engineering.WikiRevisionConflict(kind, target.base, target.current, target.window, section)
	if err != nil {
		writeEngineeringError(w, err)
		return false
	}
	if conflict {
		s.writeWikiConflict(w, target.current)
		return false
	}
	return true
}

type writeWikiContentRequest struct {
	BaseRevisionNumber *int32  `json:"base_revision_number"`
	ContentMarkdown    *string `json:"content_markdown"`
	Section            *string `json:"section"`
	DeleteSection      *string `json:"delete_section"`
	ChangeSummary      *string `json:"change_summary"`
	SourceIssueID      *string `json:"source_issue_id"`
}

func (h *Handler) LabrastroWriteWikiPageContent(w http.ResponseWriter, r *http.Request) {
	actor, err := engineeringActor(r)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var req writeWikiContentRequest
	if !decodeEngineering(w, r, &req) {
		return
	}
	if req.BaseRevisionNumber == nil || *req.BaseRevisionNumber < 1 {
		writeErrorCode(w, 400, "invalid_request", "base_revision_number is required")
		return
	}
	// Valid shapes: full-page content alone; section + its new content; or a
	// section deletion with no content.
	fullPage := req.ContentMarkdown != nil && req.Section == nil && req.DeleteSection == nil
	sectionWrite := req.ContentMarkdown != nil && req.Section != nil && req.DeleteSection == nil
	sectionDelete := req.ContentMarkdown == nil && req.DeleteSection != nil
	if !fullPage && !sectionWrite && !sectionDelete {
		writeErrorCode(w, 400, "invalid_request", "use content_markdown alone, section with content_markdown, or delete_section")
		return
	}
	if req.Section != nil && strings.TrimSpace(*req.Section) == "" || req.DeleteSection != nil && strings.TrimSpace(*req.DeleteSection) == "" {
		writeErrorCode(w, 400, "invalid_request", "section must not be empty")
		return
	}
	if req.ContentMarkdown != nil {
		if err := engineering.ValidateContent(*req.ContentMarkdown); err != nil {
			writeEngineeringError(w, err)
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
	target, ok := s.wikiWriteTarget(r.Context(), w, chi.URLParam(r, "page"), *req.BaseRevisionNumber, true)
	if !ok {
		return
	}
	page := target.pages[target.index]
	rebased := page.LastRevisionNumber != *req.BaseRevisionNumber
	var content, summary string
	if fullPage {
		// Full-page writes rebase over pure structure changes.
		if !s.wikiCheckConflict(w, target, "content", "") {
			return
		}
		content = *req.ContentMarkdown
		summary = wikiSummary(firstNonNil(req.ChangeSummary), "整页更新")
	} else {
		query, deleting := "", false
		if sectionDelete {
			query, deleting = *req.DeleteSection, true
		} else if req.Section != nil {
			query = *req.Section
		}
		if !s.wikiCheckConflict(w, target, "section", query) {
			return
		}
		replacement := ""
		if sectionWrite {
			replacement = *req.ContentMarkdown
		}
		content, err = engineering.MergeSection(target.current.ContentMarkdown, query, replacement, deleting)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if deleting {
			summary = wikiSummary(firstNonNil(req.ChangeSummary), "删除小节「"+query+"」")
		} else {
			summary = wikiSummary(firstNonNil(req.ChangeSummary), "更新小节「"+query+"」")
		}
	}
	revision, err := s.wikiInsertRevision(r.Context(), &page, "content", content, summary, target.base.ID, pgtype.UUID{}, source, actor)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.wikiChanged(s, actor, page, "content", revision.RevisionNumber)
	writeJSON(w, 200, map[string]any{"page": wikiPageJSON(page), "revision": wikiRevisionJSON(revision), "rebased": rebased})
}
