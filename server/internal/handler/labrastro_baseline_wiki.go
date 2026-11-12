package handler

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/json"
	"math/big"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ---------- page set helpers (pure, over the locked project row) ----------

func wikiUUID(ref string) (pgtype.UUID, error) { return util.ParseUUID(ref) }

func wikiPageIndexByID(pages []db.ProjectBaselinePage, id pgtype.UUID) int {
	for i := range pages {
		if pages[i].ID == id {
			return i
		}
	}
	return -1
}

// wikiPageRef resolves {page} as a UUID or a slug.
func wikiPageRef(pages []db.ProjectBaselinePage, ref string) int {
	if id, err := wikiUUID(ref); err == nil {
		return wikiPageIndexByID(pages, id)
	}
	for i := range pages {
		if pages[i].Slug == ref {
			return i
		}
	}
	return -1
}

// wikiSiblings returns indices under parent ordered by (position, id).
// Archived pages keep their slot (I3a).
func wikiSiblings(pages []db.ProjectBaselinePage, parent pgtype.UUID) []int {
	out := []int{}
	for i := range pages {
		if pages[i].ParentID == parent {
			out = append(out, i)
		}
	}
	slices.SortFunc(out, func(a, b int) int {
		if c := cmp.Compare(pages[a].Position, pages[b].Position); c != 0 {
			return c
		}
		return strings.Compare(uuidToString(pages[a].ID), uuidToString(pages[b].ID))
	})
	return out
}

func wikiDepth(pages []db.ProjectBaselinePage, id pgtype.UUID) int {
	depth := 1
	for {
		i := wikiPageIndexByID(pages, id)
		if i < 0 || !pages[i].ParentID.Valid {
			return depth
		}
		id = pages[i].ParentID
		depth++
	}
}

func wikiSubtreeHeight(pages []db.ProjectBaselinePage, id pgtype.UUID) int {
	height := 1
	for i := range pages {
		if pages[i].ParentID == id {
			if h := wikiSubtreeHeight(pages, pages[i].ID); h+1 > height {
				height = h + 1
			}
		}
	}
	return height
}

func wikiIsDescendantOrSelf(pages []db.ProjectBaselinePage, ancestor, node pgtype.UUID) bool {
	for {
		if node == ancestor {
			return true
		}
		i := wikiPageIndexByID(pages, node)
		if i < 0 || !pages[i].ParentID.Valid {
			return false
		}
		node = pages[i].ParentID
	}
}

// wikiWritePositions persists a dense 0..n-1 order for one sibling set. Only
// rows whose position actually changed are written; the pages slice is kept in
// sync so later reads inside the transaction observe the new order.
func (s *engineeringState) wikiWritePositions(ctx context.Context, pages []db.ProjectBaselinePage, ordered []int) error {
	for pos, i := range ordered {
		if i < 0 || i >= len(pages) || pages[i].Position == int32(pos) {
			continue
		}
		if err := s.q.LabrastroSetBaselinePagePosition(ctx, db.LabrastroSetBaselinePagePositionParams{
			WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: pages[i].ID, Position: int32(pos),
		}); err != nil {
			return err
		}
		pages[i].Position = int32(pos)
	}
	return nil
}

// wikiZeroUUID is a valid (all-zero) UUID for the NOT NULL placeholder between
// a page insert and its create revision inside one transaction.
func wikiZeroUUID() pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{}, Valid: true} }

// ---------- revision plumbing ----------

// wikiInsertRevision allocates the next number and stores a complete snapshot
// taken from the post-operation page row (I2a).
func (s *engineeringState) wikiInsertRevision(ctx context.Context, page *db.ProjectBaselinePage, kind, content, summary string, base, restored, source pgtype.UUID, actor baselineActor) (db.ProjectBaselineRevision, error) {
	number, err := s.q.LabrastroAllocateBaselineRevisionNumber(ctx, db.LabrastroAllocateBaselineRevisionNumberParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: page.ID})
	if err != nil {
		return db.ProjectBaselineRevision{}, err
	}
	revision, err := s.q.LabrastroCreateBaselineWikiRevision(ctx, db.LabrastroCreateBaselineWikiRevisionParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: page.ID,
		RevisionNumber: number, RevisionKind: kind, Title: page.Title, Slug: page.Slug,
		ParentID: page.ParentID, Position: page.Position, ArchivedAt: page.ArchivedAt,
		ContentMarkdown: content, ChangeSummary: summary, BaseRevisionID: base,
		RestoredFromRevisionID: restored, SourceIssueID: source,
		CreatedByType: actor.kind, CreatedByID: actor.id, CreatedByTaskID: actor.task,
	})
	if err != nil {
		return db.ProjectBaselineRevision{}, err
	}
	if err := s.q.LabrastroSetBaselineCurrentRevision(ctx, db.LabrastroSetBaselineCurrentRevisionParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: page.ID, CurrentRevisionID: revision.ID,
	}); err != nil {
		return db.ProjectBaselineRevision{}, err
	}
	page.LastRevisionNumber = number
	page.CurrentRevisionID = revision.ID
	return revision, nil
}

func (s *engineeringState) wikiRevisionByNumber(ctx context.Context, pageID pgtype.UUID, n int32) (db.ProjectBaselineRevision, error) {
	return s.q.LabrastroGetBaselineRevisionByNumber(ctx, db.LabrastroGetBaselineRevisionByNumberParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: pageID, RevisionNumber: n,
	})
}

// wikiCurrentRevisions loads every page's current revision in one round trip.
func (s *engineeringState) wikiCurrentRevisions(ctx context.Context, pages []db.ProjectBaselinePage) (map[pgtype.UUID]db.ProjectBaselineRevision, error) {
	ids := make([]pgtype.UUID, 0, len(pages))
	for _, p := range pages {
		ids = append(ids, p.CurrentRevisionID)
	}
	rows, err := s.q.LabrastroListBaselineRevisionsByID(ctx, db.LabrastroListBaselineRevisionsByIDParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, Ids: ids})
	if err != nil {
		return nil, err
	}
	out := make(map[pgtype.UUID]db.ProjectBaselineRevision, len(rows))
	for _, row := range rows {
		out[row.ID] = row
	}
	return out, nil
}

// wikiWindow loads the half-open (base, current] revision window used by the
// orthogonal auto-rebase rules.
func (s *engineeringState) wikiWindow(ctx context.Context, pageID pgtype.UUID, base, current int32) ([]db.ProjectBaselineRevision, error) {
	if base >= current {
		return nil, nil
	}
	return s.q.LabrastroListBaselineRevisionsBetween(ctx, db.LabrastroListBaselineRevisionsBetweenParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: pageID,
		RevisionNumber: base, RevisionNumber_2: current,
	})
}

func wikiWindowHasKinds(window []db.ProjectBaselineRevision, kinds ...string) bool {
	for _, revision := range window {
		if slices.Contains(kinds, revision.RevisionKind) {
			return true
		}
	}
	return false
}

// ---------- responses ----------

type wikiPageResponse struct {
	ID                    string  `json:"id"`
	Slug                  string  `json:"slug"`
	Title                 string  `json:"title"`
	ParentID              *string `json:"parent_id"`
	Position              int32   `json:"position"`
	ArchivedAt            *string `json:"archived_at,omitempty"`
	CurrentRevisionNumber int32   `json:"current_revision_number"`
	CreatedAt             string  `json:"created_at"`
	UpdatedAt             string  `json:"updated_at"`
}

func wikiPageJSON(p db.ProjectBaselinePage) wikiPageResponse {
	out := wikiPageResponse{
		ID: uuidToString(p.ID), Slug: p.Slug, Title: p.Title, Position: p.Position,
		CurrentRevisionNumber: p.LastRevisionNumber,
		CreatedAt:             p.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: p.UpdatedAt.Time.UTC().Format(time.RFC3339Nano),
	}
	if p.ParentID.Valid {
		parent := uuidToString(p.ParentID)
		out.ParentID = &parent
	}
	if p.ArchivedAt.Valid {
		at := p.ArchivedAt.Time.UTC().Format(time.RFC3339Nano)
		out.ArchivedAt = &at
	}
	return out
}

type wikiRevisionResponse struct {
	ID                     string  `json:"id"`
	PageID                 string  `json:"page_id"`
	RevisionNumber         int32   `json:"revision_number"`
	RevisionKind           string  `json:"revision_kind"`
	Title                  string  `json:"title"`
	Slug                   string  `json:"slug"`
	ParentID               *string `json:"parent_id"`
	Position               int32   `json:"position"`
	ArchivedAt             *string `json:"archived_at,omitempty"`
	ContentMarkdown        string  `json:"content_markdown"`
	ChangeSummary          string  `json:"change_summary"`
	BaseRevisionID         *string `json:"base_revision_id"`
	RestoredFromRevisionID *string `json:"restored_from_revision_id"`
	SourceIssueID          *string `json:"source_issue_id"`
	CreatedByType          string  `json:"created_by_type"`
	CreatedByID            string  `json:"created_by_id"`
	CreatedByTaskID        *string `json:"created_by_task_id"`
	CreatedAt              string  `json:"created_at"`
}

func wikiRevisionJSON(r db.ProjectBaselineRevision) wikiRevisionResponse {
	out := wikiRevisionResponse{
		ID: uuidToString(r.ID), PageID: uuidToString(r.PageID), RevisionNumber: r.RevisionNumber,
		RevisionKind: r.RevisionKind, Title: r.Title, Slug: r.Slug, Position: r.Position,
		ContentMarkdown: r.ContentMarkdown, ChangeSummary: r.ChangeSummary,
		CreatedByType: r.CreatedByType, CreatedByID: uuidToString(r.CreatedByID),
		CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
	}
	if r.ParentID.Valid {
		parent := uuidToString(r.ParentID)
		out.ParentID = &parent
	}
	if r.ArchivedAt.Valid {
		at := r.ArchivedAt.Time.UTC().Format(time.RFC3339Nano)
		out.ArchivedAt = &at
	}
	if r.BaseRevisionID.Valid {
		base := uuidToString(r.BaseRevisionID)
		out.BaseRevisionID = &base
	}
	if r.RestoredFromRevisionID.Valid {
		restored := uuidToString(r.RestoredFromRevisionID)
		out.RestoredFromRevisionID = &restored
	}
	if r.SourceIssueID.Valid {
		source := uuidToString(r.SourceIssueID)
		out.SourceIssueID = &source
	}
	if r.CreatedByTaskID.Valid {
		task := uuidToString(r.CreatedByTaskID)
		out.CreatedByTaskID = &task
	}
	return out
}

// writeWikiConflict answers 409 baseline_conflict with the current revision
// summary clients merge against.
func (s *engineeringState) writeWikiConflict(w http.ResponseWriter, current db.ProjectBaselineRevision) {
	currentJSON := map[string]any{
		"revision_number": current.RevisionNumber,
		"kind":            current.RevisionKind,
		"created_at":      current.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
		"created_by_type": current.CreatedByType,
		"created_by_id":   uuidToString(current.CreatedByID),
		"change_summary":  current.ChangeSummary,
	}
	if current.SourceIssueID.Valid {
		currentJSON["source_issue_id"] = uuidToString(current.SourceIssueID)
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"code": "baseline_conflict", "error": "baseline conflict", "current": currentJSON,
	})
}

// ---------- request plumbing ----------

func (s *engineeringState) wikiRequireEnabled() error {
	if !s.config.Enabled {
		return baselineError(409, "engineering_disabled")
	}
	return nil
}

func (s *engineeringState) wikiValidateSourceIssue(ctx context.Context, source pgtype.UUID) error {
	if !source.Valid {
		return nil
	}
	issue, err := s.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: source, WorkspaceID: s.project.WorkspaceID})
	if err != nil || issue.ProjectID != s.project.ID {
		return baselineError(422, "invalid_request")
	}
	return nil
}

func wikiOptionalUUID(w http.ResponseWriter, value *string, field string) (pgtype.UUID, bool) {
	if value == nil {
		return pgtype.UUID{}, true
	}
	id, ok := parseUUIDOrBadRequest(w, *value, field)
	return id, ok
}

func wikiGenerateSlug(pages []db.ProjectBaselinePage) string {
	taken := map[string]bool{}
	for _, p := range pages {
		taken[p.Slug] = true
	}
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	for range 16 {
		runes := make([]byte, 6)
		for i := range runes {
			n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
			if err != nil {
				return ""
			}
			runes[i] = alphabet[n.Int64()]
		}
		slug := "p-" + string(runes)
		if !taken[slug] {
			return slug
		}
	}
	return ""
}

func wikiSummary(requested, fallback string) string {
	if strings.TrimSpace(requested) != "" {
		return requested
	}
	return fallback
}

func firstNonNil(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func wikiChangeSummaryValid(value *string) bool {
	return value == nil || utf8.RuneCountInString(*value) <= 500
}

// ---------- GET /tree ----------

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
				depth = wikiDepth(pages, p.ID)
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

// ---------- wiki index (per-request symbol table) ----------

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

// ---------- GET /pages/{page} ----------

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
	i := wikiPageRef(pages, chi.URLParam(r, "page"))
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

// ---------- POST /pages ----------

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
		i := wikiPageRef(pages, *req.Parent)
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
		slug = wikiGenerateSlug(pages)
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
	siblings := wikiSiblings(pages, parent)
	if len(siblings) >= engineering.MaxWikiSiblings {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_large"))
		return
	}
	if parent.Valid && wikiDepth(pages, parent)+1 > engineering.MaxWikiDepth {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
		return
	}
	insertAt := len(siblings)
	if req.After != nil {
		if *req.After == "first" {
			insertAt = 0
		} else {
			for pos, i := range siblings {
				if pages[i].Slug == *req.After {
					insertAt = pos + 1
					break
				}
			}
		}
	}
	// Splice the new page into the sibling order and renumber the tail.
	newIndex := len(pages)
	pages = append(pages, db.ProjectBaselinePage{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID,
		ParentID: parent, Slug: slug, Title: req.Title, Position: int32(insertAt),
	})
	order := make([]int, 0, len(siblings)+1)
	order = append(order, siblings[:insertAt]...)
	order = append(order, newIndex)
	order = append(order, siblings[insertAt:]...)
	page, err := s.q.LabrastroCreateBaselinePage(r.Context(), db.LabrastroCreateBaselinePageParams{
		WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ParentID: parent,
		Slug: slug, Title: req.Title, Position: int32(insertAt), CurrentRevisionID: wikiZeroUUID(),
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

// ---------- shared write path ----------

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
	i := wikiPageRef(pages, pageRef)
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

// ---------- PUT /pages/{page}/content ----------

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
		if rebased && wikiWindowHasKinds(target.window, "content", "archive", "restore", "rollback") {
			s.writeWikiConflict(w, target.current)
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
		if rebased {
			if wikiWindowHasKinds(target.window, "archive", "restore", "rollback") {
				s.writeWikiConflict(w, target.current)
				return
			}
			// The target section's subtree must be byte-identical since base.
			baseSubtree, err := engineering.SectionSubtree(target.base.ContentMarkdown, query)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			currentSubtree, err := engineering.SectionSubtree(target.current.ContentMarkdown, query)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			if baseSubtree != currentSubtree {
				s.writeWikiConflict(w, target.current)
				return
			}
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

// ---------- PATCH /pages/{page} (rename / move) ----------

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
		if rebased && wikiWindowHasKinds(target.window, "rename", "archive", "restore", "rollback") {
			s.writeWikiConflict(w, target.current)
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

	// Move.
	if rebased {
		if wikiWindowHasKinds(target.window, "move", "archive", "restore", "rollback") || target.base.ParentID != target.current.ParentID {
			s.writeWikiConflict(w, target.current)
			return
		}
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
		j := wikiPageRef(target.pages, parentSlug)
		if j < 0 {
			writeEngineeringError(w, pgx.ErrNoRows)
			return
		}
		newParent := target.pages[j]
		if newParent.ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
		if wikiIsDescendantOrSelf(target.pages, page.ID, newParent.ID) {
			writeEngineeringError(w, baselineError(409, "baseline_page_cycle"))
			return
		}
		parent, parentChanged = newParent.ID, page.ParentID != newParent.ID
	}
	if parentChanged && parent.Valid && wikiDepth(target.pages, parent)+wikiSubtreeHeight(target.pages, page.ID) > engineering.MaxWikiDepth {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
		return
	}
	siblings := wikiSiblings(target.pages, parent)
	if parentChanged && len(siblings) >= engineering.MaxWikiSiblings {
		writeEngineeringError(w, baselineError(422, "baseline_tree_too_large"))
		return
	}
	// Build the destination order without the moved page first: `after`
	// positions must be resolved on that sequence, otherwise a backward move
	// inside the same parent overshoots by one slot.
	order := make([]int, 0, len(siblings))
	for _, j := range siblings {
		if j != target.index {
			order = append(order, j)
		}
	}
	insertAt := len(order)
	if req.After != nil {
		if *req.After == "first" {
			insertAt = 0
		} else {
			for pos, j := range order {
				if target.pages[j].Slug == *req.After {
					insertAt = pos + 1
					break
				}
			}
		}
	}
	order = append(order[:insertAt], append([]int{target.index}, order[insertAt:]...)...)
	// Reflow the origin sibling set when the parent changed (I3a); the moved
	// page leaves that set, so it is not part of the renumbered order.
	if parentChanged {
		origin := make([]int, 0, len(siblings))
		for _, j := range wikiSiblings(target.pages, page.ParentID) {
			if j != target.index {
				origin = append(origin, j)
			}
		}
		if err := s.wikiWritePositions(r.Context(), target.pages, origin); err != nil {
			writeEngineeringError(w, err)
			return
		}
	}
	page.ParentID, page.Position = parent, int32(insertAt)
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
			summary = "移动到「" + target.pages[wikiPageIndexByID(target.pages, parent)].Title + "」下"
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

// ---------- POST archive / restore ----------

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

// wikiArchiveFlip selects the subtree pages whose archived flag actually
// changes: the root plus, when recursive, every unarchived descendant.
func wikiArchiveFlip(pages []db.ProjectBaselinePage, root int, recursive bool) []int {
	flips := []int{root}
	if !recursive {
		return flips
	}
	var walk func(id pgtype.UUID)
	walk = func(id pgtype.UUID) {
		for i := range pages {
			if pages[i].ParentID == id && !pages[i].ArchivedAt.Valid {
				flips = append(flips, i)
				walk(pages[i].ID)
			}
		}
	}
	walk(pages[root].ID)
	return flips
}

// wikiRestoreFlip selects the pages restored together with the root: the root
// plus, when recursive, descendants archived in the same batch.
func wikiRestoreFlip(pages []db.ProjectBaselinePage, root int, recursive bool) []int {
	flips := []int{root}
	if !recursive {
		return flips
	}
	batch := pages[root].ArchivedAt
	var walk func(id pgtype.UUID)
	walk = func(id pgtype.UUID) {
		for i := range pages {
			if pages[i].ParentID == id && pages[i].ArchivedAt.Valid && pages[i].ArchivedAt == batch {
				flips = append(flips, i)
				walk(pages[i].ID)
			}
		}
	}
	walk(pages[root].ID)
	return flips
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
	if *req.BaseRevisionNumber != page.LastRevisionNumber {
		s.writeWikiConflict(w, target.current)
		return
	}
	// A restore may retarget the parent when the original one is archived.
	if !archiving && req.Parent != nil && *req.Parent != "" && *req.Parent != "root" {
		j := wikiPageRef(target.pages, *req.Parent)
		if j < 0 {
			writeEngineeringError(w, pgx.ErrNoRows)
			return
		}
		if target.pages[j].ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
		if wikiIsDescendantOrSelf(target.pages, page.ID, target.pages[j].ID) {
			writeEngineeringError(w, baselineError(409, "baseline_page_cycle"))
			return
		}
		newParent := target.pages[j].ID
		if newParent != page.ParentID {
			if siblings := wikiSiblings(target.pages, newParent); len(siblings) >= engineering.MaxWikiSiblings {
				writeEngineeringError(w, baselineError(422, "baseline_tree_too_large"))
				return
			}
			if wikiDepth(target.pages, newParent)+wikiSubtreeHeight(target.pages, page.ID) > engineering.MaxWikiDepth {
				writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
				return
			}
			origin := make([]int, 0, 8)
			for _, k := range wikiSiblings(target.pages, page.ParentID) {
				if k != target.index {
					origin = append(origin, k)
				}
			}
			if err := s.wikiWritePositions(r.Context(), target.pages, origin); err != nil {
				writeEngineeringError(w, err)
				return
			}
			// The restored page joins the END of the new sibling set; both
			// sets end dense 0..n-1 (I3a).
			destination := append([]int{}, wikiSiblings(target.pages, newParent)...)
			destination = append(destination, target.index)
			if err := s.wikiWritePositions(r.Context(), target.pages, destination); err != nil {
				writeEngineeringError(w, err)
				return
			}
			page.ParentID, page.Position = newParent, int32(len(destination)-1)
			target.pages[target.index] = page
		}
	} else if !archiving && page.ParentID.Valid {
		if j := wikiPageIndexByID(target.pages, page.ParentID); j < 0 || target.pages[j].ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
	}
	var flips []int
	if archiving {
		flips = wikiArchiveFlip(target.pages, target.index, req.Recursive)
	} else {
		flips = wikiRestoreFlip(target.pages, target.index, req.Recursive)
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

// ---------- GET history / revision / diff ----------

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
	i := wikiPageRef(pages, chi.URLParam(r, "page"))
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
	i := wikiPageRef(pages, chi.URLParam(r, "page"))
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

type wikiStructureChange struct {
	From any `json:"from"`
	To   any `json:"to"`
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
	i := wikiPageRef(pages, chi.URLParam(r, "page"))
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
	slugOf := func(id pgtype.UUID) string {
		if !id.Valid {
			return ""
		}
		if j := wikiPageIndexByID(pages, id); j >= 0 {
			return pages[j].Slug
		}
		return uuidToString(id)
	}
	structure := map[string]wikiStructureChange{}
	if old.Title != next.Title {
		structure["title"] = wikiStructureChange{old.Title, next.Title}
	}
	if old.Slug != next.Slug {
		structure["slug"] = wikiStructureChange{old.Slug, next.Slug}
	}
	if old.ParentID != next.ParentID {
		structure["parent"] = wikiStructureChange{slugOf(old.ParentID), slugOf(next.ParentID)}
	}
	if old.Position != next.Position {
		structure["position"] = wikiStructureChange{old.Position, next.Position}
	}
	if old.ArchivedAt.Valid != next.ArchivedAt.Valid {
		structure["archived"] = wikiStructureChange{old.ArchivedAt.Valid, next.ArchivedAt.Valid}
	}
	sections, err := engineering.Compute(old.ContentMarkdown, next.ContentMarkdown, from)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"structure": structure, "sections": sections})
}

// ---------- POST rollback ----------

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
	if *req.BaseRevisionNumber != page.LastRevisionNumber {
		s.writeWikiConflict(w, target.current)
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
		j := wikiPageIndexByID(target.pages, restore.ParentID)
		if j < 0 || target.pages[j].ArchivedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_parent_archived"))
			return
		}
		if wikiIsDescendantOrSelf(target.pages, page.ID, restore.ParentID) {
			writeEngineeringError(w, baselineError(409, "baseline_page_cycle"))
			return
		}
		if wikiDepth(target.pages, restore.ParentID)+wikiSubtreeHeight(target.pages, page.ID) > engineering.MaxWikiDepth {
			writeEngineeringError(w, baselineError(422, "baseline_tree_too_deep"))
			return
		}
	}
	oldParent := page.ParentID
	// Explicit position restore: clamp into the destination sibling set.
	target.pages[target.index].ParentID = restore.ParentID
	siblings := wikiSiblings(target.pages, restore.ParentID)
	order := make([]int, 0, len(siblings))
	for _, j := range siblings {
		if j != target.index {
			order = append(order, j)
		}
	}
	insertAt := min(int(restore.Position), len(order))
	order = append(order[:insertAt], append([]int{target.index}, order[insertAt:]...)...)
	if oldParent != restore.ParentID {
		origin := make([]int, 0, 8)
		for _, j := range wikiSiblings(target.pages, oldParent) {
			if j != target.index {
				origin = append(origin, j)
			}
		}
		if err := s.wikiWritePositions(r.Context(), target.pages, origin); err != nil {
			writeEngineeringError(w, err)
			return
		}
	}
	page.Title, page.Slug, page.ParentID = restore.Title, restore.Slug, restore.ParentID
	target.pages[target.index] = page
	page.Position = int32(insertAt)
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

// ---------- GET activity / search / backlinks ----------

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
		if i := wikiPageIndexByID(pages, id); i >= 0 {
			slug = pages[i].Slug
		}
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"backlinks": index.BacklinksFor(slug)})
}
