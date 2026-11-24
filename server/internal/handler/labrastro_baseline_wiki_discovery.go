package handler

import (
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) LabrastroWikiActivity(w http.ResponseWriter, r *http.Request) {
	limit := int32(20)
	if value := r.URL.Query().Get("limit"); value != "" {
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 || n > 50 {
			writeEngineeringError(w, baselineError(400, "invalid_request"))
			return
		}
		limit = int32(n)
	}
	before := pgtype.Timestamptz{}
	if value := r.URL.Query().Get("before"); value != "" {
		at, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			writeEngineeringError(w, baselineError(400, "invalid_request"))
			return
		}
		before = pgtype.Timestamptz{Time: at, Valid: true}
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	rows, err := s.q.LabrastroBaselineActivity(r.Context(), db.LabrastroBaselineActivityParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, BeforeTime: before, PageLimit: limit,
	})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		item := map[string]any{
			"page_id": uuidToString(row.PageID), "slug": row.Slug, "title": row.Title,
			"kind": row.RevisionKind, "number": row.RevisionNumber,
			"created_at":      row.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
			"created_by_type": row.CreatedByType, "created_by_id": uuidToString(row.CreatedByID),
			"change_summary": row.ChangeSummary,
		}
		if row.SourceIssueID.Valid {
			item["source_issue_id"] = uuidToString(row.SourceIssueID)
		}
		items = append(items, item)
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"items": items})
}

func (h *Handler) LabrastroWikiSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit := int32(20)
	if value := r.URL.Query().Get("limit"); value != "" {
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 || n > 50 {
			writeEngineeringError(w, baselineError(400, "invalid_request"))
			return
		}
		limit = int32(n)
	}
	if n := utf8.RuneCountInString(q); n < 1 || n > 100 {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	rows, err := s.q.LabrastroSearchBaselinePages(r.Context(), db.LabrastroSearchBaselinePagesParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, Query: strings.ToLower(q), PageLimit: limit,
	})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	hits := make([]engineering.SearchHit, 0, len(rows))
	for _, row := range rows {
		match := "body"
		if strings.Contains(strings.ToLower(row.Title), strings.ToLower(q)) {
			match = "title"
		} else if headings, err := engineering.Index(row.ContentMarkdown); err == nil {
			for _, heading := range headings {
				if strings.Contains(strings.ToLower(heading.Title), strings.ToLower(q)) {
					match = "section"
					break
				}
			}
		}
		hits = append(hits, engineering.SearchSnippet(uuidToString(row.PageID), row.Slug, row.Title, row.ContentMarkdown, q, match))
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"results": hits})
}

func (h *Handler) LabrastroWikiPageBacklinks(w http.ResponseWriter, r *http.Request) {
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	index, _, err := s.wikiIndex(r.Context())
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	slug := chi.URLParam(r, "page")
	if id, err := wikiUUID(slug); err == nil {
		pages, err := s.q.LabrastroListBaselinePages(r.Context(), db.LabrastroListBaselinePagesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if i := engineering.WikiTree(pages).IndexByID(id); i >= 0 {
			slug = pages[i].Slug
		}
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"backlinks": index.BacklinksFor(slug)})
}
