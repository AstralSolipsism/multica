package handler

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func wikiUUID(ref string) (pgtype.UUID, error) { return util.ParseUUID(ref) }

func wikiPageRef(pages []db.ProjectBaselinePage, ref string) int {
	return engineering.WikiTree(pages).Resolve(ref)
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
