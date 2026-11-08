package handler

import (
	"cmp"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func orderedBaselineDocs(docs []db.ProjectBaselineDoc) []db.ProjectBaselineDoc {
	out := make([]db.ProjectBaselineDoc, 0, len(docs)+len(engineering.Chapters))
	for _, chapter := range engineering.Chapters {
		out = append(out, baselineDoc(docs, chapter))
	}
	modules := []db.ProjectBaselineDoc{}
	for _, d := range docs {
		if strings.HasPrefix(d.Chapter, "module:") {
			modules = append(modules, d)
		}
	}
	slices.SortFunc(modules, func(a, b db.ProjectBaselineDoc) int {
		if order := cmp.Compare(a.Position, b.Position); order != 0 {
			return order
		}
		return cmp.Compare(a.Chapter, b.Chapter)
	})
	return append(out, modules...)
}

type baselineIndexChapter struct {
	Chapter        string                `json:"chapter"`
	Title          string                `json:"title"`
	Position       int32                 `json:"position"`
	RevisionID     *string               `json:"revision_id"`
	RevisionNumber int32                 `json:"revision_number"`
	Status         string                `json:"status"`
	Sections       []engineering.Heading `json:"sections"`
}

// Return a bounded representation over HTTP; the CLI never needs a full
// engineering overview merely to discover headings or read one section.
func (h *Handler) LabrastroReadBaseline(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	index, section, chapter := query.Get("index"), query.Get("section"), query.Get("chapter")
	candidate := query.Get("candidate")
	if index != "true" && index != "" || candidate != "true" && candidate != "" ||
		(index == "true") == (strings.TrimSpace(section) != "") || chapter != "" && !engineering.ValidChapter(chapter) {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	docs, err := s.docs(r.Context(), false)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	selectedID := func(d db.ProjectBaselineDoc) pgtype.UUID {
		if candidate == "true" {
			return d.CandidateRevisionID
		}
		return d.AdoptedRevisionID
	}
	ordered := []db.ProjectBaselineDoc{}
	ids := []pgtype.UUID{}
	for _, d := range orderedBaselineDocs(docs) {
		if index == "true" && chapter != "" && d.Chapter != chapter {
			continue
		}
		ordered = append(ordered, d)
		ids = append(ids, selectedID(d))
	}
	revisions, err := s.revisionsByID(r.Context(), ids)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	chapters := []baselineIndexChapter{}
	contents := []engineering.ChapterContent{}
	for _, d := range ordered {
		id := selectedID(d)
		rev := revisions[id]
		if index == "true" {
			headings, err := engineering.Index(d.Chapter, rev.ContentMarkdown)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			chapters = append(chapters, baselineIndexChapter{d.Chapter, d.Title, d.Position, uuidToPtr(id), rev.RevisionNumber, rev.Status, headings})
		} else if id.Valid {
			contents = append(contents, engineering.ChapterContent{Chapter: d.Chapter, Content: rev.ContentMarkdown})
		}
	}
	s.release(r.Context())
	if index == "true" {
		writeJSON(w, 200, map[string]any{"chapters": chapters})
		return
	}
	result, err := engineering.ReadSections(contents, chapter, section)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
