package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type patchWikiPageRequest struct {
	BaseRevisionNumber *int32  `json:"base_revision_number"`
	Title              *string `json:"title"`
	Slug               *string `json:"slug"`
	// Parent keeps the raw JSON so absent, null (move to root) and a slug
	// stay distinguishable; the CLI sends null for --root.
	Parent        json.RawMessage `json:"parent"`
	After         *string         `json:"after"`
	ChangeSummary *string         `json:"change_summary"`
	SourceIssueID *string         `json:"source_issue_id"`
}

// wikiParentFromRaw decodes the parent field: absent means "not moving",
// null or "root" mean the top level, anything else is a slug or UUID.
func wikiParentFromRaw(raw json.RawMessage) (string, bool, bool) {
	if len(raw) == 0 {
		return "", false, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return "", true, true
	}
	var slug string
	if err := json.Unmarshal(raw, &slug); err != nil {
		return "", false, false
	}
	if slug == "" || slug == "root" {
		return "", true, true
	}
	return slug, true, false
}

func (h *Handler) LabrastroPatchWikiPage(w http.ResponseWriter, r *http.Request) {
	actor, err := engineeringActor(r)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var req patchWikiPageRequest
	if !decodeEngineering(w, r, &req) {
		return
	}
	if req.BaseRevisionNumber == nil || *req.BaseRevisionNumber < 1 {
		writeErrorCode(w, 400, "invalid_request", "base_revision_number is required")
		return
	}
	renaming := req.Title != nil || req.Slug != nil
	moving := len(req.Parent) > 0 || req.After != nil
	if renaming && moving {
		writeErrorCode(w, 400, "invalid_request", "rename and move are separate operations; send one per request")
		return
	}
	if !renaming && !moving {
		writeErrorCode(w, 400, "invalid_request", "nothing to change")
		return
	}
	if req.Title != nil && !engineering.ValidWikiTitle(*req.Title) {
		writeErrorCode(w, 400, "invalid_request", "title must be 1-200 characters without line breaks")
		return
	}
	if req.Slug != nil && !engineering.ValidSlug(*req.Slug) {
		writeErrorCode(w, 400, "invalid_request", "slug must match ^[a-z0-9][a-z0-9_-]{0,62}$ and not be a UUID")
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
	target, ok := s.wikiWriteTarget(r.Context(), w, chi.URLParam(r, "page"), *req.BaseRevisionNumber, true)
	if !ok {
		return
	}
	page := target.pages[target.index]
	rebased := page.LastRevisionNumber != *req.BaseRevisionNumber
	if renaming {
		if !s.wikiCheckConflict(w, target, "rename", "") {
			return
		}
		newTitle, newSlug := page.Title, page.Slug
		if req.Title != nil {
			newTitle = *req.Title
		}
		if req.Slug != nil {
			newSlug = *req.Slug
		}
		if newSlug != page.Slug {
			for j, other := range target.pages {
				if j != target.index && other.Slug == newSlug {
					writeEngineeringError(w, baselineError(409, "baseline_slug_taken"))
					return
				}
			}
		}
		oldTitle, oldSlug := page.Title, page.Slug
		if err := s.q.LabrastroRenameBaselinePage(r.Context(), db.LabrastroRenameBaselinePageParams{
			WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: page.ID, Title: newTitle, Slug: newSlug,
		}); err != nil {
			writeEngineeringError(w, err)
			return
		}
		page.Title, page.Slug = newTitle, newSlug
		defaultSummary := "改名「" + oldTitle + "」→「" + newTitle + "」"
		if oldTitle == newTitle {
			defaultSummary = "改 slug「" + oldSlug + "」→「" + newSlug + "」"
		} else if oldSlug != newSlug {
			defaultSummary += "（slug " + oldSlug + " → " + newSlug + "）"
		}
		revision, err := s.wikiInsertRevision(r.Context(), &page, "rename", target.current.ContentMarkdown, wikiSummary(firstNonNil(req.ChangeSummary), defaultSummary), target.base.ID, pgtype.UUID{}, source, actor)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if err = s.tx.Commit(r.Context()); err != nil {
			writeEngineeringError(w, err)
			return
		}
		h.wikiChanged(s, actor, page, "tree", revision.RevisionNumber)
		writeJSON(w, 200, map[string]any{"page": wikiPageJSON(page), "revision": wikiRevisionJSON(revision), "rebased": rebased})
		return
	}

	if !s.wikiCheckConflict(w, target, "move", "") {
		return
	}
	var parent pgtype.UUID
	parentChanged := false
	parentSlug, parentPresent, parentIsRoot := wikiParentFromRaw(req.Parent)
	switch {
	case !parentPresent:
		parent = page.ParentID
	case parentIsRoot:
		parentChanged = page.ParentID.Valid
	default:
		j := engineering.WikiTree(target.pages).Resolve(parentSlug)
		if j < 0 {
			writeEngineeringError(w, pgx.ErrNoRows)
			return
		}
		newParent := target.pages[j]
		if newParent.ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
		if engineering.WikiTree(target.pages).IsDescendantOrSelf(page.ID, newParent.ID) {
			writeEngineeringError(w, baselineError(409, "baseline_page_cycle"))
			return
		}
		parent, parentChanged = newParent.ID, page.ParentID != newParent.ID
	}
	if parentChanged && parent.Valid && engineering.WikiTree(target.pages).Depth(parent)+engineering.WikiTree(target.pages).SubtreeHeight(page.ID) > engineering.MaxWikiDepth {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
		return
	}
	siblings := engineering.WikiTree(target.pages).Siblings(parent)
	if parentChanged && len(siblings) >= engineering.MaxWikiSiblings {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_large"))
		return
	}
	order, insertAt := engineering.WikiTree(target.pages).InsertAfter(parent, target.index, req.After)
	// Reflow the origin sibling set when the parent changed (I3a); the moved
	// page leaves that set, so it is not part of the renumbered order.
	if parentChanged {
		origin := engineering.WikiTree(target.pages).SiblingsExcept(page.ParentID, target.index)
		if err := s.wikiWritePositions(r.Context(), target.pages, origin); err != nil {
			writeEngineeringError(w, err)
			return
		}
	}
	page.ParentID, page.Position = parent, insertAt
	target.pages[target.index] = page
	if err := s.q.LabrastroSetBaselinePage(r.Context(), db.LabrastroSetBaselinePageParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: page.ID,
		ParentID: parent, Position: page.Position, ArchivedAt: page.ArchivedAt,
	}); err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err := s.wikiWritePositions(r.Context(), target.pages, order); err != nil {
		writeEngineeringError(w, err)
		return
	}
	summary := "调整顺序"
	if parentChanged {
		if parent.Valid {
			summary = "移动到「" + target.pages[engineering.WikiTree(target.pages).IndexByID(parent)].Title + "」下"
		} else {
			summary = "移动到顶层"
		}
	}
	revision, err := s.wikiInsertRevision(r.Context(), &page, "move", target.current.ContentMarkdown, wikiSummary(firstNonNil(req.ChangeSummary), summary), target.base.ID, pgtype.UUID{}, source, actor)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.wikiChanged(s, actor, page, "tree", revision.RevisionNumber)
	writeJSON(w, 200, map[string]any{"page": wikiPageJSON(page), "revision": wikiRevisionJSON(revision), "rebased": rebased})
}
