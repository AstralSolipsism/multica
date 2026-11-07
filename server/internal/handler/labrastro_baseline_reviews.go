package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type baselineAnnotationInput struct {
	AnchorKind         string  `json:"anchor_kind"`
	TargetRevisionID   string  `json:"target_revision_id"`
	ParentAnnotationID *string `json:"parent_annotation_id"`
	SectionAnchor      string  `json:"section_anchor"`
	SectionTitle       string  `json:"section_title"`
	LineStart          *int32  `json:"line_start"`
	LineEnd            *int32  `json:"line_end"`
	Quote              string  `json:"quote"`
	Prefix             string  `json:"prefix"`
	Suffix             string  `json:"suffix"`
	Start              int32   `json:"start"`
	Note               string  `json:"note"`
}

type baselineReviewRequest struct {
	ClientKey          string `json:"client_key"`
	Chapter            string `json:"chapter"`
	ReviewedRevisionID string `json:"reviewed_revision_id"`
	Assignee           *struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"assignee"`
	Summary     string                    `json:"summary"`
	Annotations []baselineAnnotationInput `json:"annotations"`
}

func baselineHuman(w http.ResponseWriter, r *http.Request) (baselineActor, bool) {
	actor, err := engineeringActor(r)
	if err == nil && actor.kind != "member" {
		err = baselineError(403, "baseline_human_required")
	}
	if err != nil {
		writeEngineeringError(w, err)
		return actor, false
	}
	return actor, true
}

func (s *engineeringState) annotationBatch(ctx context.Context, id pgtype.UUID) (db.ProjectBaselineAnnotationBatch, error) {
	return s.q.LabrastroGetAnnotationBatch(ctx, db.LabrastroGetAnnotationBatchParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id})
}

func (s *engineeringState) annotationReviews(ctx context.Context, id pgtype.UUID) ([]db.ProjectBaselineReview, error) {
	return s.q.LabrastroListBaselineReviews(ctx, db.LabrastroListBaselineReviewsParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, BatchID: id})
}

func (s *engineeringState) annotations(ctx context.Context, id pgtype.UUID) ([]db.ProjectBaselineAnnotation, error) {
	return s.q.LabrastroListBaselineAnnotations(ctx, db.LabrastroListBaselineAnnotationsParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, BatchID: id})
}

func (s *engineeringState) carrierIssue(ctx context.Context, id pgtype.UUID) (db.Issue, bool, error) {
	if !id.Valid {
		return db.Issue{}, false, nil
	}
	i, err := s.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: s.project.WorkspaceID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return i, false, nil
	}
	if err != nil {
		return i, false, err
	}
	status, err := issuestatus.Resolve(ctx, s.q, s.project.WorkspaceID, i.Status)
	if err != nil {
		return i, false, err
	}
	return i, i.ProjectID == s.project.ID && status.Category != issuestatus.CategoryClosed, nil
}

func (s *engineeringState) lockAnnotationCarrier(ctx context.Context, b db.ProjectBaselineAnnotationBatch) error {
	if !b.IssueID.Valid {
		return nil
	}
	_, err := s.q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: b.WorkspaceID, ID: b.IssueID})
	if errors.Is(err, pgx.ErrNoRows) {
		return baselineError(409, "baseline_batch_closed")
	}
	return err
}

func (s *engineeringState) effectiveAnnotationBatch(ctx context.Context, b db.ProjectBaselineAnnotationBatch, persist bool) (db.ProjectBaselineAnnotationBatch, error) {
	if b.ClosedAt.Valid || !b.IssueID.Valid {
		return b, nil
	}
	_, live, err := s.carrierIssue(ctx, b.IssueID)
	if err != nil || live {
		return b, err
	}
	if persist {
		return s.q.LabrastroCloseAnnotationBatch(ctx, db.LabrastroCloseAnnotationBatchParams{WorkspaceID: b.WorkspaceID, ProjectID: b.ProjectID, ID: b.ID, CloseReason: pgtype.Text{String: "issue_closed", Valid: true}})
	}
	b.ClosedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	b.CloseReason = pgtype.Text{String: "issue_closed", Valid: true}
	return b, nil
}

func (s *engineeringState) relatedAnnotationCandidate(ctx context.Context, b db.ProjectBaselineAnnotationBatch, c db.ProjectBaselineRevision) (bool, error) {
	if b.IssueID.Valid && b.IssueID == c.SourceIssueID {
		return true, nil
	}
	reviews, err := s.annotationReviews(ctx, b.ID)
	for _, r := range reviews {
		if r.ReviewedRevisionID == c.ID {
			return true, err
		}
	}
	return false, err
}

func (h *Handler) baselineAnnotationChanged(b db.ProjectBaselineAnnotationBatch, actor baselineActor) {
	h.publish(protocol.EventProjectBaselineAnnotationChanged, uuidToString(b.WorkspaceID), actor.kind, uuidToString(actor.id), map[string]any{"project_id": uuidToString(b.ProjectID), "chapter": b.Chapter, "batch_id": uuidToString(b.ID)})
}

func annotationTextValid(value string, min, max int) bool {
	n := utf8.RuneCountInString(value)
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && n >= min && n <= max
}

func (h *Handler) LabrastroSubmitBaselineReview(w http.ResponseWriter, r *http.Request) {
	actor, ok := baselineHuman(w, r)
	if !ok {
		return
	}
	var req baselineReviewRequest
	if !decodeEngineering(w, r, &req) {
		return
	}
	key, ok := parseUUIDOrBadRequest(w, req.ClientKey, "client_key")
	if !ok {
		return
	}
	revisionID, ok := parseUUIDOrBadRequest(w, req.ReviewedRevisionID, "reviewed_revision_id")
	if !ok {
		return
	}
	for {
		s, ok := h.engineeringState(w, r, true)
		if !ok {
			return
		}
		defer s.tx.Rollback(r.Context())
		if !s.isDecider() {
			writeEngineeringError(w, baselineError(403, "baseline_not_decider"))
			return
		}
		ctx := r.Context()
		prior, err := s.q.LabrastroGetBaselineReviewByKey(ctx, db.LabrastroGetBaselineReviewByKeyParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ClientKey: key})
		if err == nil {
			b, err := s.annotationBatch(ctx, prior.BatchID)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			if !b.IssueID.Valid {
				agent, err := s.q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{WorkspaceID: b.WorkspaceID, ID: b.AgentID})
				if err != nil || !h.canInvokeAgent(ctx, agent, "member", uuidToString(actor.id), "", uuidToString(b.WorkspaceID)) || !h.canInvokeAgent(ctx, agent, "member", uuidToString(prior.CreatedByID), "", uuidToString(b.WorkspaceID)) {
					writeEngineeringError(w, baselineError(403, "invocation_not_allowed"))
					return
				}
			}
			if err = s.tx.Commit(ctx); err != nil {
				writeEngineeringError(w, err)
				return
			}
			h.finishBaselineReview(w, r, s, b, prior)
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			writeEngineeringError(w, err)
			return
		}
		if !s.config.Enabled {
			writeEngineeringError(w, baselineError(409, "engineering_disabled"))
			return
		}
		if !engineering.ValidChapter(req.Chapter) || !annotationTextValid(req.Summary, 0, 500) || len(req.Annotations) < 1 || len(req.Annotations) > 20 {
			writeEngineeringError(w, baselineError(400, "invalid_request"))
			return
		}
		revision, err := s.revision(ctx, revisionID)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		docs, err := s.docs(ctx, true)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		doc := baselineDoc(docs, req.Chapter)
		if revision.Chapter != req.Chapter || revision.ID != doc.AdoptedRevisionID && revision.ID != doc.CandidateRevisionID {
			writeEngineeringError(w, baselineError(409, "baseline_review_stale"))
			return
		}
		candidate := revision.ID == doc.CandidateRevisionID
		batches, err := s.q.LabrastroListAnnotationBatches(ctx, db.LabrastroListAnnotationBatchesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		var batch db.ProjectBaselineAnnotationBatch
		closedBatches := []db.ProjectBaselineAnnotationBatch{}
		for _, b := range batches {
			if b.Chapter != req.Chapter || b.ClosedAt.Valid {
				continue
			}
			b, err = s.effectiveAnnotationBatch(ctx, b, true)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			if !b.ClosedAt.Valid {
				batch = b
			} else {
				closedBatches = append(closedBatches, b)
			}
		}
		// Closing an unusable carrier is durable even when the new review needs
		// an assignee or conflicts with an existing candidate. Reacquire the
		// project snapshot before routing the submission after this maintenance.
		if len(closedBatches) > 0 {
			if err = s.tx.Commit(ctx); err != nil {
				writeEngineeringError(w, err)
				return
			}
			for _, closed := range closedBatches {
				h.baselineAnnotationChanged(closed, actor)
			}
			continue
		}
		appendReview := batch.ID.Valid
		if appendReview {
			if !batch.IssueID.Valid {
				writeEngineeringError(w, baselineError(409, "baseline_review_pending"))
				return
			}
			if candidate {
				related, err := s.relatedAnnotationCandidate(ctx, batch, revision)
				if err != nil {
					writeEngineeringError(w, err)
					return
				}
				if !related {
					writeJSON(w, 409, map[string]any{"code": "baseline_review_conflict", "error": "candidate belongs to another carrier", "batch": batch, "candidate": map[string]any{"revision_id": revision.ID, "source_issue_id": revision.SourceIssueID, "created_by_type": revision.CreatedByType, "created_by_id": revision.CreatedByID}})
					return
				}
			}
		} else {
			if !candidate && doc.CandidateRevisionID.Valid {
				writeEngineeringError(w, baselineError(409, "baseline_candidate_open"))
				return
			}
			batch = db.ProjectBaselineAnnotationBatch{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, Chapter: req.Chapter, CarrierKind: "revision_issue"}
			if candidate && revision.CreatedByType == "agent" {
				_, live, err := s.carrierIssue(ctx, revision.SourceIssueID)
				if err != nil {
					writeEngineeringError(w, err)
					return
				}
				if live {
					batch.CarrierKind = "source_issue"
					batch.IssueID = revision.SourceIssueID
					batch.AgentID = revision.CreatedByID
				}
			}
			if !batch.AgentID.Valid {
				if req.Assignee == nil || req.Assignee.Type != "agent" {
					writeEngineeringError(w, baselineError(400, "baseline_assignee_required"))
					return
				}
				batch.AgentID, ok = parseUUIDOrBadRequest(w, req.Assignee.ID, "assignee.id")
				if !ok {
					return
				}
			}
		}
		agent, err := s.q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: batch.AgentID, WorkspaceID: s.project.WorkspaceID})
		if err != nil || !h.canInvokeAgent(ctx, agent, "member", uuidToString(actor.id), uuidToString(actor.id), uuidToString(s.project.WorkspaceID)) {
			writeEngineeringError(w, baselineError(403, "invocation_not_allowed"))
			return
		}
		verdict, err := service.AgentReadiness(ctx, service.RuntimeLookup{Queries: s.q}, agent)
		if err != nil || verdict.Blocked() {
			writeEngineeringError(w, baselineError(409, "baseline_agent_unavailable"))
			return
		}
		if !appendReview {
			batch, err = s.q.LabrastroCreateAnnotationBatch(ctx, db.LabrastroCreateAnnotationBatchParams{WorkspaceID: batch.WorkspaceID, ProjectID: batch.ProjectID, Chapter: batch.Chapter, CarrierKind: batch.CarrierKind, IssueID: batch.IssueID, AgentID: batch.AgentID, CreatedByID: actor.id})
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
		}
		old, err := s.annotations(ctx, batch.ID)
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if len(old)+len(req.Annotations) > 50 {
			writeEngineeringError(w, baselineError(409, "baseline_annotation_limit"))
			return
		}
		review, err := s.q.LabrastroCreateBaselineReview(ctx, db.LabrastroCreateBaselineReviewParams{WorkspaceID: batch.WorkspaceID, ProjectID: batch.ProjectID, BatchID: batch.ID, ClientKey: key, ReviewedRevisionID: revision.ID, Summary: req.Summary, CreatedByID: actor.id})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		added := []db.ProjectBaselineAnnotation{}
		for i, input := range req.Annotations {
			p := db.LabrastroCreateBaselineAnnotationParams{WorkspaceID: batch.WorkspaceID, ProjectID: batch.ProjectID, BatchID: batch.ID, ReviewID: review.ID, Ordinal: int32(len(old) + i + 1), Note: input.Note, CreatedByID: actor.id}
			if !annotationTextValid(input.Note, 1, 1000) || strings.TrimSpace(input.Note) == "" {
				writeEngineeringError(w, baselineError(400, "invalid_request"))
				return
			}
			if input.ParentAnnotationID != nil {
				p.ParentAnnotationID, ok = parseUUIDOrBadRequest(w, *input.ParentAnnotationID, "parent_annotation_id")
				if !ok {
					return
				}
				var parent *db.ProjectBaselineAnnotation
				for j := range old {
					if old[j].ID == p.ParentAnnotationID {
						parent = &old[j]
						break
					}
				}
				if parent == nil {
					writeEngineeringError(w, baselineError(400, "invalid_annotation_parent"))
					return
				}
				p.AnchorKind = parent.AnchorKind
				p.TargetRevisionID = parent.TargetRevisionID
				p.TargetRevisionNumber = parent.TargetRevisionNumber
				p.SectionAnchor = parent.SectionAnchor
				p.SectionTitle = parent.SectionTitle
				p.LineStart = parent.LineStart
				p.LineEnd = parent.LineEnd
				p.Quote = parent.Quote
				p.Prefix = parent.Prefix
				p.Suffix = parent.Suffix
				p.Start = parent.Start
			} else {
				p.TargetRevisionID, ok = parseUUIDOrBadRequest(w, input.TargetRevisionID, "target_revision_id")
				if !ok {
					return
				}
				if p.TargetRevisionID != revision.ID && (!candidate || p.TargetRevisionID != revision.BaseRevisionID) {
					writeEngineeringError(w, baselineError(400, "invalid_annotation_target"))
					return
				}
				target, err := s.revision(ctx, p.TargetRevisionID)
				if err != nil {
					writeEngineeringError(w, err)
					return
				}
				section, found := engineering.FindAnnotationSection(req.Chapter, target.ContentMarkdown, input.SectionAnchor)
				if !found || !annotationTextValid(input.SectionAnchor, 1, 300) || !annotationTextValid(input.Quote, 0, 500) || !annotationTextValid(input.Prefix, 0, 64) || !annotationTextValid(input.Suffix, 0, 64) || input.Start < 0 {
					writeEngineeringError(w, baselineError(400, "invalid_annotation_anchor"))
					return
				}
				p.AnchorKind = input.AnchorKind
				p.TargetRevisionNumber = target.RevisionNumber
				p.SectionAnchor = section.Anchor
				p.SectionTitle = section.Title
				p.Quote = input.Quote
				p.Prefix = input.Prefix
				p.Suffix = input.Suffix
				p.Start = input.Start
				switch input.AnchorKind {
				case "lines":
					if input.LineStart == nil || input.LineEnd == nil || *input.LineStart < 1 || *input.LineEnd < *input.LineStart || *input.LineEnd-*input.LineStart >= 50 || int(*input.LineEnd) > len(engineering.SourceLines(section.OwnMarkdown)) {
						writeEngineeringError(w, baselineError(400, "invalid_annotation_lines"))
						return
					}
					p.LineStart = pgtype.Int4{Int32: *input.LineStart, Valid: true}
					p.LineEnd = pgtype.Int4{Int32: *input.LineEnd, Valid: true}
				case "text", "section":
					if input.LineStart != nil || input.LineEnd != nil {
						writeEngineeringError(w, baselineError(400, "invalid_annotation_lines"))
						return
					}
				default:
					writeEngineeringError(w, baselineError(400, "invalid_annotation_anchor"))
					return
				}
			}
			a, err := s.q.LabrastroCreateBaselineAnnotation(ctx, p)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			added = append(added, a)
		}
		var queued db.AgentTaskQueue
		var created db.CreateCommentRow
		if batch.IssueID.Valid {
			if err = s.lockAnnotationCarrier(ctx, batch); err != nil {
				writeEngineeringError(w, err)
				return
			}
			issue, live, err := s.carrierIssue(ctx, batch.IssueID)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			if !live {
				writeEngineeringError(w, baselineError(409, "baseline_batch_closed"))
				return
			}
			content := baselineReviewTicket(batch, review, revision, added, appendReview, true)
			if _, err = s.tx.Exec(ctx, `SELECT set_config('multica.actor_type','member',true),set_config('multica.actor_id',$1,true),set_config('multica.handed_to_agent',$2,true)`, uuidToString(actor.id), uuidToString(batch.AgentID)); err != nil {
				writeEngineeringError(w, err)
				return
			}
			created, err = s.q.CreateComment(ctx, db.CreateCommentParams{ID: dbid.NewV7(), WorkspaceID: batch.WorkspaceID, IssueID: batch.IssueID, AuthorType: "member", AuthorID: actor.id, Content: content, Type: "comment", SuppressedAgentIds: []pgtype.UUID{}})
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			queued, err = h.TaskService.EnqueueBaselineAnnotationInTx(ctx, s.q, issue, batch.AgentID, created.ID)
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
			review, err = s.q.LabrastroSetBaselineReviewComment(ctx, db.LabrastroSetBaselineReviewCommentParams{WorkspaceID: batch.WorkspaceID, ProjectID: batch.ProjectID, ID: review.ID, WakeCommentID: created.ID})
			if err != nil {
				writeEngineeringError(w, err)
				return
			}
		}
		if err = s.tx.Commit(ctx); err != nil {
			writeEngineeringError(w, err)
			return
		}
		if queued.ID.Valid {
			h.publish(protocol.EventCommentCreated, uuidToString(batch.WorkspaceID), actor.kind, uuidToString(actor.id), map[string]any{"comment": commentToResponse(created.Comment(), nil, nil), "issue_revision": created.IssueRevision})
			h.TaskService.FinalizeBaselineAnnotationEnqueue(ctx, queued)
		}
		h.baselineAnnotationChanged(batch, actor)
		h.finishBaselineReview(w, r, s, batch, review)
		return
	}
}

func baselineReviewTicket(b db.ProjectBaselineAnnotationBatch, review db.ProjectBaselineReview, revision db.ProjectBaselineRevision, annotations []db.ProjectBaselineAnnotation, appendReview, mention bool) string {
	var out strings.Builder
	project, batch := uuidToString(b.ProjectID), uuidToString(b.ID)
	if mention {
		fmt.Fprintf(&out, "[@修订智能体](mention://agent/%s) ", uuidToString(b.AgentID))
	}
	if appendReview {
		out.WriteString("负责人追加了审阅意见。\n")
	} else if mention {
		fmt.Fprintf(&out, "负责人对你提交的候选 %s v%d 完成了审阅：要求修改。\n", b.Chapter, revision.RevisionNumber)
	}
	if !appendReview {
		fmt.Fprintf(&out, "## 基线批注修订工单\n- 项目：%s　章节：%s　审阅版本：%s v%d\n", project, b.Chapter, revision.Status, revision.RevisionNumber)
	}
	fmt.Fprintf(&out, "- 批次：%s　本次 %d 条，涉及：", batch, len(annotations))
	for i, a := range annotations {
		if i > 0 {
			out.WriteString("、")
		}
		out.WriteString(engineering.AnnotationTicketText(a.SectionAnchor))
		if a.AnchorKind == "lines" {
			fmt.Fprintf(&out, " 第 %d–%d 行", a.LineStart.Int32, a.LineEnd.Int32)
		}
		if a.AnchorKind == "section" {
			out.WriteString("（整节）")
		}
	}
	out.WriteByte('\n')
	if !appendReview && review.Summary != "" {
		fmt.Fprintf(&out, "- 负责人总体说明：%s\n", engineering.AnnotationTicketText(review.Summary))
	}
	fmt.Fprintf(&out, "\n拉取：`multica project baseline annotations %s --batch %s --with-sections`\n", project, batch)
	if appendReview {
		return out.String()
	}
	fmt.Fprintf(&out, "\n### 处理规程\n1. 只修改被批注的小节；需要更多上下文时用 `get --section`，不要拉整章。\n2. 提交：`multica project baseline propose %s --chapter %s --section \"<anchor>\" --content-file … --summary \"<变更说明>\" --source-issue <本任务> --base-current`；第二个及以后的小节加 `--replaces <候选号>`。\n", project, b.Chapter)
	if revision.Status == "candidate" {
		fmt.Fprintf(&out, "   审阅版本本身是候选，首次提交也必须加 `--replaces %d`。\n", revision.RevisionNumber)
	}
	fmt.Fprintf(&out, "3. 本章如果有既不是本批次审阅对象、也不是由本任务提交的候选：停止，按工作流置为 blocked 并说明原因。\n4. 用 `multica project baseline respond %s --batch %s --responses-file ./responses.json` 逐条写回应；不要自行解决批注。\n", project, batch)
	if b.CarrierKind == "source_issue" {
		out.WriteString("5. 候选已替换即完成，本次不改动来源任务状态。\n")
	}
	return out.String()
}

func (h *Handler) finishBaselineReview(w http.ResponseWriter, r *http.Request, s *engineeringState, b db.ProjectBaselineAnnotationBatch, review db.ProjectBaselineReview) {
	ctx := r.Context()
	if !b.IssueID.Valid {
		revision, err := h.Queries.LabrastroGetBaselineRevision(ctx, db.LabrastroGetBaselineRevisionParams{WorkspaceID: b.WorkspaceID, ProjectID: b.ProjectID, ID: review.ReviewedRevisionID})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		annotations, err := h.Queries.LabrastroListBaselineAnnotations(ctx, db.LabrastroListBaselineAnnotationsParams{WorkspaceID: b.WorkspaceID, ProjectID: b.ProjectID, BatchID: b.ID})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		result, err := h.IssueService.Create(ctx, service.IssueCreateParams{WorkspaceID: b.WorkspaceID, ProjectID: b.ProjectID, Title: "基线批注修订 · " + b.Chapter, Description: pgtype.Text{String: baselineReviewTicket(b, review, revision, annotations, false, false), Valid: true}, Status: "todo", Priority: "none", AssigneeType: pgtype.Text{String: "agent", Valid: true}, AssigneeID: b.AgentID, CreatorType: "member", CreatorID: b.CreatedByID, AllowDuplicate: true}, service.IssueCreateOpts{BaselineAnnotationBatchID: b.ID})
		if err != nil {
			if errors.Is(err, service.ErrBaselineAnnotationBatchClosed) {
				err = baselineError(409, "baseline_batch_closed")
			}
			writeEngineeringError(w, err)
			return
		}
		b.IssueID = result.Issue.ID
		h.baselineAnnotationChanged(b, baselineActor{kind: "member", id: review.CreatedByID})
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: b.WorkspaceID, ID: b.IssueID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeEngineeringError(w, err)
		return
	}
	via := "assign"
	if review.WakeCommentID.Valid {
		via = "mention"
	}
	writeJSON(w, 201, map[string]any{"batch": b, "review": review, "carrier": map[string]any{"kind": b.CarrierKind, "issue_id": b.IssueID, "identifier": fmt.Sprintf("%s-%d", s.issuePrefix, issue.Number)}, "woke": map[string]string{"agent_id": uuidToString(b.AgentID), "via": via}})
}
