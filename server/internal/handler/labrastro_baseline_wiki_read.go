package handler

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type wikiTreeSection struct {
	Anchor string `json:"anchor"`
	Title  string `json:"title"`
	Level  int    `json:"level"`
}

type wikiTreeCurrent struct {
	Number        int32   `json:"number"`
	Kind          string  `json:"kind"`
	CreatedAt     string  `json:"created_at"`
	CreatedByType string  `json:"created_by_type"`
	CreatedByID   string  `json:"created_by_id"`
	ChangeSummary string  `json:"change_summary"`
	SourceIssueID *string `json:"source_issue_id"`
}

type wikiTreePage struct {
	wikiPageResponse
	Depth         int               `json:"depth"`
	Current       *wikiTreeCurrent  `json:"current,omitempty"`
	RevisionCount int               `json:"revision_count"`
	Sections      []wikiTreeSection `json:"sections"`
}

func (h *Handler) LabrastroWikiTree(w http.ResponseWriter, r *http.Request) {
	sections := r.URL.Query().Get("sections")
	if sections != "" && sections != "true" && sections != "false" {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	withSections := sections != "false"
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
	out := make([]wikiTreePage, 0, len(pages))
	if len(pages) > 0 {
		revisions, err := s.wikiCurrentRevisions(r.Context(), pages)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		counts, err := s.q.LabrastroCountBaselinePageRevisions(r.Context(), db.LabrastroCountBaselinePageRevisionsParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		countByPage := map[pgtype.UUID]int32{}
		for _, row := range counts {
			countByPage[row.PageID] = row.RevisionCount
		}
		depthCache := map[pgtype.UUID]int{}
		for _, p := range pages {
			depth, cached := depthCache[p.ID]
			if !cached {
				depth = engineering.WikiTree(pages).Depth(p.ID)
				depthCache[p.ID] = depth
			}
			entry := wikiTreePage{wikiPageJSON(p), depth, nil, int(countByPage[p.ID]), []wikiTreeSection{}}
			if current, ok := revisions[p.CurrentRevisionID]; ok {
				currentJSON := &wikiTreeCurrent{
					Number: current.RevisionNumber, Kind: current.RevisionKind,
					CreatedAt:     current.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
					CreatedByType: current.CreatedByType, CreatedByID: uuidToString(current.CreatedByID),
					ChangeSummary: current.ChangeSummary,
				}
				if current.SourceIssueID.Valid {
					source := uuidToString(current.SourceIssueID)
					currentJSON.SourceIssueID = &source
				}
				entry.Current = currentJSON
				if withSections && !p.ArchivedAt.Valid {
					if headings, err := engineering.Index(current.ContentMarkdown); err == nil {
						for _, heading := range headings {
							entry.Sections = append(entry.Sections, wikiTreeSection{heading.Anchor, heading.Title, heading.Level})
						}
					}
				}
			}
			out = append(out, entry)
		}
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"pages": out, "limits": map[string]int{"max_depth": engineering.MaxWikiDepth, "max_pages": engineering.MaxWikiPages}})
}

func (s *engineeringState) wikiIndex(ctx context.Context) (*engineering.WikiIndex, []engineering.WikiPageContent, error) {
	bodies, err := s.q.LabrastroListBaselinePageBodies(ctx, db.LabrastroListBaselinePageBodiesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		return nil, nil, err
	}
	pages := make([]engineering.WikiPageContent, 0, len(bodies))
	for _, b := range bodies {
		pages = append(pages, engineering.WikiPageContent{Slug: b.Slug, Title: b.Title, Content: b.ContentMarkdown})
	}
	return engineering.NewWikiIndex(pages), pages, nil
}

type wikiRelatedIssue struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Title      string `json:"title"`
	Status     string `json:"status"`
}

func (h *Handler) LabrastroReadWikiPage(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	revisionParam, sectionParam := query.Get("revision"), query.Get("section")
	var number int32
	if revisionParam != "" {
		n, err := strconv.ParseInt(revisionParam, 10, 32)
		if err != nil || n < 1 {
			writeEngineeringError(w, baselineError(400, "invalid_request"))
			return
		}
		number = int32(n)
	}
	with := strings.Split(query.Get("with"), ",")
	wants := func(name string) bool { return slices.Contains(with, name) }

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
	if number == 0 {
		number = page.LastRevisionNumber
	}
	revision, err := s.wikiRevisionByNumber(r.Context(), page.ID, number)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	response := map[string]any{"page": wikiPageJSON(page), "revision": wikiRevisionJSON(revision)}
	if sectionParam != "" {
		// One-hop [[ref]] definitions resolve across every unarchived page;
		// the page itself reads from the requested revision when historical.
		_, indexPages, err := s.wikiIndex(r.Context())
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		contents := make([]engineering.PageContent, 0, len(indexPages))
		for _, indexPage := range indexPages {
			content := indexPage.Content
			if indexPage.Slug == page.Slug {
				content = revision.ContentMarkdown
			}
			contents = append(contents, engineering.PageContent{Slug: indexPage.Slug, Content: content})
		}
		if !slices.ContainsFunc(contents, func(c engineering.PageContent) bool { return c.Slug == page.Slug }) {
			// Archived target page: still readable, referenced sections resolve
			// against the live index only.
			contents = append(contents, engineering.PageContent{Slug: page.Slug, Content: revision.ContentMarkdown})
		}
		slice, err := engineering.ReadSections(contents, page.Slug, sectionParam)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		response["sections"] = slice.Sections
		response["referenced_sections"] = slice.ReferencedSections
	} else {
		response["content_markdown"] = revision.ContentMarkdown
	}
	if wants("links") || wants("backlinks") {
		index, indexPages, err := s.wikiIndex(r.Context())
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		at := -1
		for j, p := range indexPages {
			if p.Slug == page.Slug {
				at = j
				break
			}
		}
		if wants("links") {
			links := []engineering.WikiLink{}
			if at >= 0 && revision.RevisionNumber == page.LastRevisionNumber {
				links = index.LinksFor(at)
			} else if engineering.ValidateContent(revision.ContentMarkdown) == nil {
				for _, raw := range engineering.ExtractWikiLinks(revision.ContentMarkdown) {
					links = append(links, index.ResolveWikiLink(at, raw))
				}
			}
			response["links"] = links
		}
		if wants("backlinks") {
			response["backlinks"] = index.BacklinksFor(page.Slug)
		}
	}
	if wants("related_issues") {
		issues, err := s.q.LabrastroBaselineRelatedIssues(r.Context(), db.LabrastroBaselineRelatedIssuesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: page.ID})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		related := make([]wikiRelatedIssue, 0, len(issues))
		for _, issue := range issues {
			related = append(related, wikiRelatedIssue{
				ID: uuidToString(issue.ID), Identifier: s.issuePrefix + "-" + strconv.FormatInt(int64(issue.Number), 10),
				Title: issue.Title, Status: issue.Status,
			})
		}
		response["related_issues"] = related
	}
	s.release(r.Context())
	writeJSON(w, 200, response)
}
