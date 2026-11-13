package handler

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type archiveWikiPageRequest struct {
	BaseRevisionNumber *int32  `json:"base_revision_number"`
	Recursive          bool    `json:"recursive"`
	Parent             *string `json:"parent"`
	ChangeSummary      *string `json:"change_summary"`
	SourceIssueID      *string `json:"source_issue_id"`
}

func (h *Handler) LabrastroArchiveWikiPage(w http.ResponseWriter, r *http.Request) {
	h.wikiArchiveRestore(w, r, true)
}

func (h *Handler) LabrastroRestoreWikiPage(w http.ResponseWriter, r *http.Request) {
	h.wikiArchiveRestore(w, r, false)
}

func (h *Handler) wikiArchiveRestore(w http.ResponseWriter, r *http.Request, archiving bool) {
	actor, err := engineeringActor(r)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var req archiveWikiPageRequest
	if !decodeEngineering(w, r, &req) {
		return
	}
	if req.BaseRevisionNumber == nil || *req.BaseRevisionNumber < 1 {
		writeErrorCode(w, 400, "invalid_request", "base_revision_number is required")
		return
	}
	if req.Parent != nil && archiving {
		writeErrorCode(w, 400, "invalid_request", "parent only applies to restore")
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
	// Archive, restore and rollback are strict CAS: no rebase.
	target, ok := s.wikiWriteTarget(r.Context(), w, chi.URLParam(r, "page"), *req.BaseRevisionNumber, false)
	if !ok {
		return
	}
	page := target.pages[target.index]
	if archiving == page.ArchivedAt.Valid {
		writeEngineeringError(w, baselineError(409, "baseline_page_archived"))
		return
	}
	if archiving && !req.Recursive {
		for i := range target.pages {
			if target.pages[i].ParentID == page.ID && !target.pages[i].ArchivedAt.Valid {
				writeEngineeringError(w, baselineError(409, "baseline_page_has_children"))
				return
			}
		}
	}
	if !s.wikiCheckConflict(w, target, "archive", "") {
		return
	}
	// A restore may retarget the parent when the original one is archived.
	if !archiving && req.Parent != nil && *req.Parent != "" && *req.Parent != "root" {
		j := engineering.WikiTree(target.pages).Resolve(*req.Parent)
		if j < 0 {
			writeEngineeringError(w, pgx.ErrNoRows)
			return
		}
		if target.pages[j].ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
		if engineering.WikiTree(target.pages).IsDescendantOrSelf(page.ID, target.pages[j].ID) {
			writeEngineeringError(w, baselineError(409, "baseline_page_cycle"))
			return
		}
		newParent := target.pages[j].ID
		if newParent != page.ParentID {
			if siblings := engineering.WikiTree(target.pages).Siblings(newParent); len(siblings) >= engineering.MaxWikiSiblings {
				writeEngineeringError(w, baselineError(422, "baseline_tree_too_large"))
				return
			}
			if engineering.WikiTree(target.pages).Depth(newParent)+engineering.WikiTree(target.pages).SubtreeHeight(page.ID) > engineering.MaxWikiDepth {
				writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
				return
			}
			origin := engineering.WikiTree(target.pages).SiblingsExcept(page.ParentID, target.index)
			if err := s.wikiWritePositions(r.Context(), target.pages, origin); err != nil {
				writeEngineeringError(w, err)
				return
			}
			destination, position := engineering.WikiTree(target.pages).InsertAfter(newParent, target.index, nil)
			if err := s.wikiWritePositions(r.Context(), target.pages, destination); err != nil {
				writeEngineeringError(w, err)
				return
			}
			page.ParentID, page.Position = newParent, position
			target.pages[target.index] = page
		}
	} else if !archiving && page.ParentID.Valid {
		if j := engineering.WikiTree(target.pages).IndexByID(page.ParentID); j < 0 || target.pages[j].ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
	}
	var flips []int
	if archiving {
		flips = engineering.WikiTree(target.pages).ArchiveFlip(target.index, req.Recursive)
	} else {
		flips = engineering.WikiTree(target.pages).RestoreFlip(target.index, req.Recursive)
	}
	// Each flipped page snapshots its own current content.
	currents, err := s.wikiCurrentRevisions(r.Context(), target.pages)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	stamp := time.Now().UTC()
	results := make([]map[string]any, 0, len(flips))
	for _, i := range flips {
		p := &target.pages[i]
		if archiving {
			p.ArchivedAt = pgtype.Timestamptz{Time: stamp, Valid: true}
		} else {
			p.ArchivedAt = pgtype.Timestamptz{}
		}
		if err := s.q.LabrastroSetBaselinePage(r.Context(), db.LabrastroSetBaselinePageParams{
			WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: p.ID,
			ParentID: p.ParentID, Position: p.Position, ArchivedAt: p.ArchivedAt,
		}); err != nil {
			writeEngineeringError(w, err)
			return
		}
		content := ""
		if current, ok := currents[p.CurrentRevisionID]; ok {
			content = current.ContentMarkdown
		}
		kind, summary := "archive", "归档"
		if !archiving {
			kind, summary = "restore", "恢复"
		}
		baseID := pgtype.UUID{}
		if i == target.index {
			baseID = target.base.ID
		}
		revision, err := s.wikiInsertRevision(r.Context(), p, kind, content, wikiSummary(firstNonNil(req.ChangeSummary), summary), baseID, pgtype.UUID{}, source, actor)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		results = append(results, map[string]any{"page": wikiPageJSON(*p), "revision": wikiRevisionJSON(revision)})
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	for _, i := range flips {
		h.wikiChanged(s, actor, target.pages[i], "archive", target.pages[i].LastRevisionNumber)
	}
	writeJSON(w, 200, map[string]any{"pages": results})
}
