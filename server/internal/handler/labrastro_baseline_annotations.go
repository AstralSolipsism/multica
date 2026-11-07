package handler

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type baselineAnnotationCarrier struct {
	Kind       string      `json:"kind"`
	IssueID    pgtype.UUID `json:"issue_id"`
	Identifier string      `json:"identifier"`
}
type baselineAnnotationCounts struct {
	Open     int `json:"open"`
	Resolved int `json:"resolved"`
}
type baselineAnnotationWorking struct {
	RevisionID     pgtype.UUID `json:"revision_id"`
	RevisionNumber int32       `json:"revision_number"`
	Status         string      `json:"status"`
}
type baselineAnnotationBatchResponse struct {
	db.ProjectBaselineAnnotationBatch
	State   string                     `json:"state"`
	Carrier baselineAnnotationCarrier  `json:"carrier"`
	Working *baselineAnnotationWorking `json:"working"`
	Counts  baselineAnnotationCounts   `json:"counts"`
}
type baselineAnnotationResponse struct {
	db.ProjectBaselineAnnotation
	State    string                          `json:"state"`
	Side     string                          `json:"side"`
	Location string                          `json:"location"`
	Located  *engineering.AnnotationLocation `json:"located"`
}

func (s *engineeringState) annotationBatchResponse(ctx context.Context, b db.ProjectBaselineAnnotationBatch) (baselineAnnotationBatchResponse, db.ProjectBaselineRevision, []db.ProjectBaselineAnnotation, error) {
	out := baselineAnnotationBatchResponse{ProjectBaselineAnnotationBatch: b, State: "active", Carrier: baselineAnnotationCarrier{Kind: b.CarrierKind, IssueID: b.IssueID}}
	if b.ClosedAt.Valid {
		out.State = "closed"
	}
	issue, _, err := s.carrierIssue(ctx, b.IssueID)
	if err != nil {
		return out, db.ProjectBaselineRevision{}, nil, err
	}
	if issue.ID.Valid {
		out.Carrier.Identifier = fmt.Sprintf("%s-%d", s.issuePrefix, issue.Number)
	}
	annotations, err := s.annotations(ctx, b.ID)
	if err != nil {
		return out, db.ProjectBaselineRevision{}, nil, err
	}
	for _, a := range annotations {
		if a.ResolvedAt.Valid {
			out.Counts.Resolved++
		} else {
			out.Counts.Open++
		}
	}
	docs, err := s.docs(ctx, false)
	if err != nil {
		return out, db.ProjectBaselineRevision{}, nil, err
	}
	doc := baselineDoc(docs, b.Chapter)
	working, err := s.revision(ctx, doc.CandidateRevisionID)
	if err != nil {
		return out, working, nil, err
	}
	if !working.ID.Valid || !b.IssueID.Valid || working.SourceIssueID != b.IssueID {
		working, err = s.revision(ctx, doc.AdoptedRevisionID)
	}
	if working.ID.Valid {
		out.Working = &baselineAnnotationWorking{working.ID, working.RevisionNumber, working.Status}
	}
	return out, working, annotations, err
}

func (h *Handler) LabrastroListAnnotationBatches(w http.ResponseWriter, r *http.Request) {
	chapter, state, issueParam := r.URL.Query().Get("chapter"), r.URL.Query().Get("state"), r.URL.Query().Get("issue_id")
	if chapter != "" && !engineering.ValidChapter(chapter) || state != "" && state != "active" && state != "open" && state != "closed" && state != "all" {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	var issueID pgtype.UUID
	if issueParam != "" {
		var ok bool
		issueID, ok = parseUUIDOrBadRequest(w, issueParam, "issue_id")
		if !ok {
			return
		}
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	rows, err := s.q.LabrastroListAnnotationBatches(r.Context(), db.LabrastroListAnnotationBatchesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	out := []baselineAnnotationBatchResponse{}
	for _, b := range rows {
		if chapter != "" && b.Chapter != chapter || issueID.Valid && b.IssueID != issueID {
			continue
		}
		b, err = s.effectiveAnnotationBatch(r.Context(), b, false)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if (state == "open" || state == "active") && b.ClosedAt.Valid || state == "closed" && !b.ClosedAt.Valid {
			continue
		}
		item, _, _, err := s.annotationBatchResponse(r.Context(), b)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		out = append(out, item)
	}
	writeJSON(w, 200, map[string]any{"batches": out})
}

func (h *Handler) LabrastroReadAnnotationBatch(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "batch"), "batch")
	if !ok {
		return
	}
	state, withSections := r.URL.Query().Get("state"), r.URL.Query().Get("with_sections")
	if state != "" && state != "open" && state != "all" || withSections != "" && withSections != "true" && withSections != "false" {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	b, err := s.annotationBatch(r.Context(), id)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	b, err = s.effectiveAnnotationBatch(r.Context(), b, false)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	batch, working, rows, err := s.annotationBatchResponse(r.Context(), b)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	reviews, err := s.annotationReviews(r.Context(), b.ID)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	reviewed := map[pgtype.UUID]db.ProjectBaselineRevision{}
	for _, review := range reviews {
		revision, err := s.revision(r.Context(), review.ReviewedRevisionID)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		reviewed[review.ID] = revision
	}
	annotations := []baselineAnnotationResponse{}
	sections := []engineering.SectionSlice{}
	seen := map[string]bool{}
	for _, a := range rows {
		if state != "all" && (b.ClosedAt.Valid || a.ResolvedAt.Valid) {
			continue
		}
		item := baselineAnnotationResponse{ProjectBaselineAnnotation: a, State: "open", Side: "after"}
		if a.ResolvedAt.Valid {
			item.State = "resolved"
		}
		if b.ClosedAt.Valid {
			item.State = "archived"
		}
		if reviewed[a.ReviewID].BaseRevisionID == a.TargetRevisionID {
			item.Side = "before"
		}
		item.Location, item.Located = engineering.LocateAnnotation(b.Chapter, working.ContentMarkdown, working.RevisionNumber, a.TargetRevisionID == working.ID, engineering.AnnotationAnchor{Kind: a.AnchorKind, Section: a.SectionAnchor, Quote: a.Quote, Prefix: a.Prefix, Suffix: a.Suffix, Start: int(a.Start), LineStart: int(a.LineStart.Int32), LineEnd: int(a.LineEnd.Int32)})
		annotations = append(annotations, item)
		seen[a.SectionAnchor] = true
	}
	if withSections == "true" {
		sections = engineering.AnnotationSubtrees(b.Chapter, working.ContentMarkdown, seen)
	}
	writeJSON(w, 200, map[string]any{"batch": batch, "reviews": reviews, "annotations": annotations, "sections": sections})
}

func (h *Handler) LabrastroRespondAnnotations(w http.ResponseWriter, r *http.Request) {
	actor, err := engineeringActor(r)
	if err == nil && actor.kind != "agent" {
		err = baselineError(403, "baseline_task_required")
	}
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var req struct {
		Responses []struct {
			AnnotationID string `json:"annotation_id"`
			Response     string `json:"response"`
		} `json:"responses"`
	}
	if !decodeEngineering(w, r, &req) {
		return
	}
	if len(req.Responses) < 1 || len(req.Responses) > 50 {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	ids := make([]pgtype.UUID, len(req.Responses))
	seen := map[pgtype.UUID]bool{}
	for i, item := range req.Responses {
		var ok bool
		ids[i], ok = parseUUIDOrBadRequest(w, item.AnnotationID, "annotation_id")
		if !ok {
			return
		}
		if seen[ids[i]] || !annotationTextValid(item.Response, 0, 1000) {
			writeEngineeringError(w, baselineError(400, "invalid_request"))
			return
		}
		seen[ids[i]] = true
	}
	s, ok := h.engineeringState(w, r, true)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	task, err := s.q.GetAgentTaskInWorkspace(r.Context(), db.GetAgentTaskInWorkspaceParams{WorkspaceID: s.project.WorkspaceID, ID: actor.task})
	if err != nil || !task.IssueID.Valid || task.AgentID != actor.id {
		writeEngineeringError(w, baselineError(403, "baseline_carrier_required"))
		return
	}
	batches := map[pgtype.UUID]db.ProjectBaselineAnnotationBatch{}
	for i, id := range ids {
		a, err := s.q.LabrastroGetBaselineAnnotation(r.Context(), db.LabrastroGetBaselineAnnotationParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		b, err := s.annotationBatch(r.Context(), a.BatchID)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if b.IssueID != task.IssueID {
			writeEngineeringError(w, baselineError(403, "baseline_carrier_required"))
			return
		}
		if err = s.lockAnnotationCarrier(r.Context(), b); err != nil {
			writeEngineeringError(w, err)
			return
		}
		b, err = s.effectiveAnnotationBatch(r.Context(), b, false)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if b.ClosedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_batch_closed"))
			return
		}
		if err = s.q.LabrastroRespondBaselineAnnotation(r.Context(), db.LabrastroRespondBaselineAnnotationParams{WorkspaceID: b.WorkspaceID, ProjectID: b.ProjectID, ID: id, Response: pgtype.Text{String: req.Responses[i].Response, Valid: true}, RespondedByTaskID: actor.task}); err != nil {
			writeEngineeringError(w, err)
			return
		}
		batches[b.ID] = b
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	for _, b := range batches {
		h.baselineAnnotationChanged(b, actor)
	}
	writeJSON(w, 200, map[string]int{"updated": len(ids)})
}

func (h *Handler) LabrastroResolveAnnotations(w http.ResponseWriter, r *http.Request) {
	actor, ok := baselineHuman(w, r)
	if !ok {
		return
	}
	var req struct {
		IDs      []string `json:"annotation_ids"`
		Resolved *bool    `json:"resolved"`
	}
	if !decodeEngineering(w, r, &req) {
		return
	}
	if len(req.IDs) < 1 || len(req.IDs) > 50 || req.Resolved == nil {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	ids := make([]pgtype.UUID, len(req.IDs))
	for i, id := range req.IDs {
		ids[i], ok = parseUUIDOrBadRequest(w, id, "annotation_ids")
		if !ok {
			return
		}
	}
	s, ok := h.engineeringState(w, r, true)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	if !s.isDecider() {
		writeEngineeringError(w, baselineError(403, "baseline_not_decider"))
		return
	}
	batches := map[pgtype.UUID]db.ProjectBaselineAnnotationBatch{}
	for _, id := range ids {
		a, err := s.q.LabrastroGetBaselineAnnotation(r.Context(), db.LabrastroGetBaselineAnnotationParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		b, err := s.annotationBatch(r.Context(), a.BatchID)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if err = s.lockAnnotationCarrier(r.Context(), b); err != nil {
			writeEngineeringError(w, err)
			return
		}
		b, err = s.effectiveAnnotationBatch(r.Context(), b, false)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if b.ClosedAt.Valid {
			writeEngineeringError(w, baselineError(409, "baseline_batch_closed"))
			return
		}
		if err = s.q.LabrastroResolveBaselineAnnotation(r.Context(), db.LabrastroResolveBaselineAnnotationParams{WorkspaceID: b.WorkspaceID, ProjectID: b.ProjectID, ID: id, Resolved: *req.Resolved, ActorID: actor.id}); err != nil {
			writeEngineeringError(w, err)
			return
		}
		batches[b.ID] = b
	}
	if err := s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	for _, b := range batches {
		h.baselineAnnotationChanged(b, actor)
	}
	writeJSON(w, 200, map[string]int{"updated": len(ids)})
}

func (h *Handler) LabrastroCloseAnnotationBatch(w http.ResponseWriter, r *http.Request) {
	actor, ok := baselineHuman(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "batch"), "batch")
	if !ok {
		return
	}
	s, ok := h.engineeringState(w, r, true)
	if !ok {
		return
	}
	defer s.tx.Rollback(r.Context())
	if !s.isDecider() {
		writeEngineeringError(w, baselineError(403, "baseline_not_decider"))
		return
	}
	b, err := s.annotationBatch(r.Context(), id)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	b, err = s.effectiveAnnotationBatch(r.Context(), b, true)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if !b.ClosedAt.Valid {
		b, err = s.q.LabrastroCloseAnnotationBatch(r.Context(), db.LabrastroCloseAnnotationBatchParams{WorkspaceID: b.WorkspaceID, ProjectID: b.ProjectID, ID: b.ID, CloseReason: pgtype.Text{String: "manual", Valid: true}, ClosedByType: pgtype.Text{String: "member", Valid: true}, ClosedByID: actor.id})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.baselineAnnotationChanged(b, actor)
	writeJSON(w, 200, map[string]any{"batch": b})
}
