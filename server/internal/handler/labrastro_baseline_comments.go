package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type wikiCommentResponse struct {
	ID           string  `json:"id"`
	Body         string  `json:"body_markdown"`
	AuthorType   string  `json:"author_type"`
	AuthorID     string  `json:"author_id"`
	AuthorTaskID *string `json:"author_task_id,omitempty"`
	CreatedAt    string  `json:"created_at"`
	EditedAt     *string `json:"edited_at,omitempty"`
}

type wikiThreadResponse struct {
	ID             string                      `json:"id"`
	PageID         string                      `json:"page_id"`
	Anchor         engineering.CommentSelector `json:"anchor"`
	AnchorState    string                      `json:"anchor_state"`
	Location       engineering.CommentLocation `json:"location"`
	IssueID        *string                     `json:"issue_id,omitempty"`
	Identifier     string                      `json:"identifier,omitempty"`
	ResolvedAt     *string                     `json:"resolved_at,omitempty"`
	ResolvedByType *string                     `json:"resolved_by_type,omitempty"`
	ResolvedByID   *string                     `json:"resolved_by_id,omitempty"`
	CreatedAt      string                      `json:"created_at"`
	UpdatedAt      string                      `json:"updated_at"`
	Comments       []wikiCommentResponse       `json:"comments"`
	Section        *engineering.CommentSection `json:"section,omitempty"`
}

func wikiCommentJSON(c db.ProjectBaselineComment) wikiCommentResponse {
	return wikiCommentResponse{uuidToString(c.ID), c.BodyMarkdown, c.AuthorType, uuidToString(c.AuthorID), uuidToPtr(c.AuthorTaskID), c.CreatedAt.Time.UTC().Format(time.RFC3339Nano), wikiCommentTime(c.EditedAt)}
}
func wikiCommentTime(t pgtype.Timestamptz) *string {
	if !t.Valid {
		return nil
	}
	s := t.Time.UTC().Format(time.RFC3339Nano)
	return &s
}
func wikiThreadSelector(t db.ProjectBaselineThread) engineering.CommentSelector {
	a := engineering.CommentSelector{Kind: t.AnchorKind, SectionAnchor: t.SectionAnchor, SectionTitle: t.SectionTitle, Exact: t.QuoteExact, Prefix: t.QuotePrefix, Suffix: t.QuoteSuffix, RevisionNumber: t.AnchorRevisionNumber.Int32}
	if t.QuoteStart.Valid {
		n := int(t.QuoteStart.Int32)
		a.Start = &n
	}
	return a
}

func (s *engineeringState) wikiCommentPage(ctx context.Context, ref string) (db.ProjectBaselinePage, db.ProjectBaselineRevision, error) {
	pages, err := s.q.LabrastroListBaselinePages(ctx, db.LabrastroListBaselinePagesParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID})
	if err != nil {
		return db.ProjectBaselinePage{}, db.ProjectBaselineRevision{}, err
	}
	i := wikiPageRef(pages, ref)
	if i < 0 {
		return db.ProjectBaselinePage{}, db.ProjectBaselineRevision{}, pgx.ErrNoRows
	}
	p := pages[i]
	r, err := s.wikiRevisionByNumber(ctx, p.ID, p.LastRevisionNumber)
	return p, r, err
}

func (s *engineeringState) wikiThreadsJSON(ctx context.Context, threads []db.ProjectBaselineThread, revision db.ProjectBaselineRevision, withSection bool) ([]wikiThreadResponse, error) {
	ids := make([]pgtype.UUID, 0, len(threads))
	for _, t := range threads {
		ids = append(ids, t.ID)
	}
	comments, err := s.q.LabrastroListBaselineComments(ctx, db.LabrastroListBaselineCommentsParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ThreadIds: ids})
	if err != nil {
		return nil, err
	}
	grouped := map[pgtype.UUID][]wikiCommentResponse{}
	for _, c := range comments {
		grouped[c.ThreadID] = append(grouped[c.ThreadID], wikiCommentJSON(c))
	}
	sections := engineering.CommentSections(revision.ContentMarkdown)
	out := make([]wikiThreadResponse, 0, len(threads))
	for _, t := range threads {
		a := wikiThreadSelector(t)
		location := engineering.LocateComment(sections, a)
		c := grouped[t.ID]
		if c == nil {
			c = []wikiCommentResponse{}
		}
		item := wikiThreadResponse{ID: uuidToString(t.ID), PageID: uuidToString(t.PageID), Anchor: a, AnchorState: location.State, Location: location, IssueID: uuidToPtr(t.IssueID), ResolvedAt: wikiCommentTime(t.ResolvedAt), ResolvedByID: uuidToPtr(t.ResolvedByID), CreatedAt: t.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: t.UpdatedAt.Time.UTC().Format(time.RFC3339Nano), Comments: c}
		if t.ResolvedByType.Valid {
			kind := t.ResolvedByType.String
			item.ResolvedByType = &kind
		}
		if t.IssueID.Valid {
			issue, e := s.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: s.project.WorkspaceID, ID: t.IssueID})
			if e == nil && issue.ProjectID == s.project.ID {
				item.Identifier = fmt.Sprintf("%s-%d", s.issuePrefix, issue.Number)
			}
		}
		if withSection {
			for _, section := range sections {
				if section.Anchor == location.SectionAnchor {
					item.Section = &section
					break
				}
			}
		}
		out = append(out, item)
	}
	return out, nil
}

func (h *Handler) LabrastroWikiThreads(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	if state != "open" && state != "resolved" && state != "all" {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.release(r.Context())
	page, rev, err := s.wikiCommentPage(r.Context(), chi.URLParam(r, "page"))
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	threads, err := s.q.LabrastroListBaselineThreads(r.Context(), db.LabrastroListBaselineThreadsParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: page.ID})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	filtered := []db.ProjectBaselineThread{}
	for _, t := range threads {
		if state == "all" || (state == "resolved") == t.ResolvedAt.Valid {
			filtered = append(filtered, t)
		}
	}
	out, err := s.wikiThreadsJSON(r.Context(), filtered, rev, false)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"threads": out})
}

func (h *Handler) LabrastroWikiThread(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "thread"), "thread")
	if !ok {
		return
	}
	s, ok := h.engineeringState(w, r, false)
	if !ok {
		return
	}
	defer s.release(r.Context())
	thread, err := s.q.LabrastroGetBaselineThread(r.Context(), db.LabrastroGetBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	_, rev, err := s.wikiCommentPage(r.Context(), uuidToString(thread.PageID))
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	out, err := s.wikiThreadsJSON(r.Context(), []db.ProjectBaselineThread{thread}, rev, r.URL.Query().Get("with_section") == "true")
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	s.release(r.Context())
	writeJSON(w, 200, map[string]any{"thread": out[0]})
}

type wikiCommentInput struct {
	Anchor         *engineering.CommentSelector `json:"anchor"`
	Quote          string                       `json:"quote"`
	Section        string                       `json:"section"`
	Body           string                       `json:"body_markdown"`
	CarrierIssueID *string                      `json:"carrier_issue_id"`
}

func validWikiCommentBody(body string) bool {
	n := utf8.RuneCountInString(body)
	return utf8.ValidString(body) && !strings.ContainsRune(body, 0) && strings.TrimSpace(body) != "" && n <= 4000
}
func validWikiCommentAnchor(a engineering.CommentSelector) bool {
	return (a.Kind == "text" || a.Kind == "section") && a.SectionAnchor != "" && utf8.RuneCountInString(a.SectionAnchor) <= 300 && utf8.RuneCountInString(a.Exact) <= 500 && utf8.RuneCountInString(a.Prefix) <= 64 && utf8.RuneCountInString(a.Suffix) <= 64 && (a.Kind != "text" || strings.TrimSpace(a.Exact) != "") && (a.Start == nil || (*a.Start >= 0 && *a.Start <= 131072))
}

func (h *Handler) LabrastroCreateWikiThread(w http.ResponseWriter, r *http.Request) {
	h.writeWikiComment(w, r, true)
}
func (h *Handler) LabrastroReplyWikiThread(w http.ResponseWriter, r *http.Request) {
	h.writeWikiComment(w, r, false)
}

func (h *Handler) writeWikiComment(w http.ResponseWriter, r *http.Request, create bool) {
	actor, err := engineeringActor(r)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	var input wikiCommentInput
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768)).Decode(&input) != nil || !validWikiCommentBody(input.Body) {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, true)
	if !ok {
		return
	}
	defer s.release(r.Context())
	if err := s.wikiRequireEnabled(); err != nil {
		writeEngineeringError(w, err)
		return
	}
	var thread db.ProjectBaselineThread
	ref := chi.URLParam(r, "page")
	if !create {
		id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "thread"), "thread")
		if !ok {
			return
		}
		thread, err = s.q.LabrastroGetBaselineThread(r.Context(), db.LabrastroGetBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		ref = uuidToString(thread.PageID)
	}
	page, rev, err := s.wikiCommentPage(r.Context(), ref)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if page.ArchivedAt.Valid {
		writeEngineeringError(w, baselineError(409, "baseline_page_archived"))
		return
	}
	if create {
		threads, e := s.q.LabrastroListBaselineThreads(r.Context(), db.LabrastroListBaselineThreadsParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: page.ID})
		if e != nil {
			writeEngineeringError(w, e)
			return
		}
		if len(threads) >= 500 {
			writeEngineeringError(w, baselineError(422, "baseline_thread_limit"))
			return
		}
		var anchor engineering.CommentSelector
		if input.Anchor == nil {
			if input.Quote == "" && input.Section == "" {
				writeEngineeringError(w, baselineError(400, "invalid_request"))
				return
			}
			anchor, err = engineering.CompleteCommentQuote(engineering.CommentSections(rev.ContentMarkdown), input.Section, input.Quote, rev.RevisionNumber)
		} else {
			anchor = *input.Anchor
			if anchor.RevisionNumber == 0 {
				anchor.RevisionNumber = rev.RevisionNumber
			}
			snapshot := rev
			if anchor.RevisionNumber != rev.RevisionNumber {
				snapshot, err = s.wikiRevisionByNumber(r.Context(), page.ID, anchor.RevisionNumber)
			}
			if err == nil {
				sections := engineering.CommentSections(snapshot.ContentMarkdown)
				loc := engineering.LocateComment(sections, anchor)
				if loc.State != "anchored" {
					err = baselineError(422, "baseline_quote_not_found")
				} else {
					for _, section := range sections {
						if section.Anchor == anchor.SectionAnchor {
							anchor.SectionTitle = section.Title
							break
						}
					}
				}
			}
		}
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
		if !validWikiCommentAnchor(anchor) {
			writeEngineeringError(w, baselineError(400, "invalid_request"))
			return
		}
		issue := pgtype.UUID{}
		if input.CarrierIssueID != nil {
			issue, ok = parseUUIDOrBadRequest(w, *input.CarrierIssueID, "carrier_issue_id")
			if !ok {
				return
			}
			if err = s.wikiValidateSourceIssue(r.Context(), issue); err != nil {
				writeEngineeringError(w, err)
				return
			}
		}
		start := pgtype.Int4{}
		if anchor.Start != nil {
			start = pgtype.Int4{Int32: int32(*anchor.Start), Valid: true}
		}
		thread, err = s.q.LabrastroCreateBaselineThread(r.Context(), db.LabrastroCreateBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, PageID: page.ID, AnchorKind: anchor.Kind, SectionAnchor: anchor.SectionAnchor, SectionTitle: anchor.SectionTitle, QuoteExact: anchor.Exact, QuotePrefix: anchor.Prefix, QuoteSuffix: anchor.Suffix, QuoteStart: start, AnchorRevisionNumber: pgtype.Int4{Int32: anchor.RevisionNumber, Valid: true}, IssueID: issue, CreatedByType: actor.kind, CreatedByID: actor.id})
		if err != nil {
			writeEngineeringError(w, err)
			return
		}
	}
	comments, err := s.q.LabrastroListBaselineComments(r.Context(), db.LabrastroListBaselineCommentsParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ThreadIds: []pgtype.UUID{thread.ID}})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if len(comments) >= 200 {
		writeEngineeringError(w, baselineError(422, "baseline_comment_limit"))
		return
	}
	comment, err := s.q.LabrastroCreateBaselineComment(r.Context(), db.LabrastroCreateBaselineCommentParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ThreadID: thread.ID, BodyMarkdown: input.Body, AuthorType: actor.kind, AuthorID: actor.id, AuthorTaskID: actor.task})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err = s.q.LabrastroTouchBaselineThread(r.Context(), db.LabrastroTouchBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: thread.ID}); err != nil {
		writeEngineeringError(w, err)
		return
	}
	out, err := s.wikiThreadsJSON(r.Context(), []db.ProjectBaselineThread{thread}, rev, false)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	if err = s.tx.Commit(r.Context()); err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.wikiCommentChanged(thread, actor)
	woke := h.wakeWikiComment(r, s, page, &thread, comment, actor)
	out[0].IssueID = uuidToPtr(thread.IssueID)
	if thread.IssueID.Valid {
		if issue, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{WorkspaceID: thread.WorkspaceID, ID: thread.IssueID}); err == nil && issue.ProjectID == thread.ProjectID {
			out[0].Identifier = fmt.Sprintf("%s-%d", s.issuePrefix, issue.Number)
		}
		h.wikiCommentChanged(thread, actor)
	}
	writeJSON(w, 201, map[string]any{"thread": out[0], "comment": wikiCommentJSON(comment), "woke": woke})
}

func (h *Handler) LabrastroEditWikiComment(w http.ResponseWriter, r *http.Request) {
	h.mutateWikiComment(w, r, "edit")
}
func (h *Handler) LabrastroDeleteWikiComment(w http.ResponseWriter, r *http.Request) {
	h.mutateWikiComment(w, r, "delete")
}
func (h *Handler) LabrastroResolveWikiThread(w http.ResponseWriter, r *http.Request) {
	h.mutateWikiComment(w, r, "resolve")
}

func (h *Handler) mutateWikiComment(w http.ResponseWriter, r *http.Request, action string) {
	actor, err := engineeringActor(r)
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	param := "comment"
	if action == "resolve" {
		param = "thread"
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, param), param)
	if !ok {
		return
	}
	var input struct {
		Body     string `json:"body_markdown"`
		Resolved *bool  `json:"resolved"`
	}
	if action != "delete" && json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768)).Decode(&input) != nil {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	if (action == "edit" && !validWikiCommentBody(input.Body)) || (action == "resolve" && input.Resolved == nil) {
		writeEngineeringError(w, baselineError(400, "invalid_request"))
		return
	}
	s, ok := h.engineeringState(w, r, true)
	if !ok {
		return
	}
	defer s.release(r.Context())
	if err := s.wikiRequireEnabled(); err != nil {
		writeEngineeringError(w, err)
		return
	}
	tid := id
	if action != "resolve" {
		comment, e := s.q.LabrastroGetBaselineComment(r.Context(), db.LabrastroGetBaselineCommentParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id})
		if e != nil {
			writeEngineeringError(w, e)
			return
		}
		own := comment.AuthorType == actor.kind && comment.AuthorID == actor.id
		admin := actor.kind == "member" && roleAllowed(s.member.Role, "owner", "admin")
		if !own && (action != "delete" || !admin) {
			writeEngineeringError(w, baselineError(403, "baseline_comment_forbidden"))
			return
		}
		tid = comment.ThreadID
	}
	thread, err := s.q.LabrastroGetBaselineThread(r.Context(), db.LabrastroGetBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: tid})
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	switch action {
	case "edit":
		err = s.q.LabrastroEditBaselineComment(r.Context(), db.LabrastroEditBaselineCommentParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id, BodyMarkdown: input.Body})
	case "delete":
		err = s.q.LabrastroDeleteBaselineComment(r.Context(), db.LabrastroDeleteBaselineCommentParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: id})
	case "resolve":
		params := db.LabrastroResolveBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: tid}
		if *input.Resolved {
			params.ResolvedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			params.ResolvedByType = pgtype.Text{String: actor.kind, Valid: true}
			params.ResolvedByID = actor.id
		}
		err = s.q.LabrastroResolveBaselineThread(r.Context(), params)
	}
	if err == nil {
		err = s.q.LabrastroTouchBaselineThread(r.Context(), db.LabrastroTouchBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: tid})
	}
	if err == nil && action == "delete" {
		err = s.q.LabrastroDeleteEmptyBaselineThread(r.Context(), db.LabrastroDeleteEmptyBaselineThreadParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, ID: tid})
	}
	if err == nil {
		err = s.tx.Commit(r.Context())
	}
	if err != nil {
		writeEngineeringError(w, err)
		return
	}
	h.wikiCommentChanged(thread, actor)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) wikiCommentChanged(thread db.ProjectBaselineThread, actor baselineActor) {
	h.publish(protocol.EventProjectBaselineCommentChanged, uuidToString(thread.WorkspaceID), actor.kind, uuidToString(actor.id), map[string]any{"project_id": uuidToString(thread.ProjectID), "page_id": uuidToString(thread.PageID), "thread_id": uuidToString(thread.ID)})
}

func (h *Handler) wakeWikiComment(r *http.Request, s *engineeringState, page db.ProjectBaselinePage, thread *db.ProjectBaselineThread, comment db.ProjectBaselineComment, actor baselineActor) []CommentTriggerOutcome {
	mentions := util.ParseMentions(comment.BodyMarkdown)
	if !hasAgentOrSquadMention(mentions) {
		return []CommentTriggerOutcome{}
	}
	failed := func() []CommentTriggerOutcome {
		out := []CommentTriggerOutcome{}
		for _, m := range mentions {
			if m.Type == "agent" || m.Type == "squad" {
				out = append(out, CommentTriggerOutcome{m.Type, m.ID, DispatchBlocked, ReasonInternalError})
			}
		}
		return out
	}
	pid, tid := uuidToString(s.project.ID), uuidToString(thread.ID)
	inert := engineering.AnnotationTicketText
	excerpt := []rune(thread.QuoteExact)
	if len(excerpt) > 24 {
		excerpt = excerpt[:24]
	}
	deep := url.Values{"page": {page.Slug}, "section": {thread.SectionAnchor}, "thread": {tid}}
	workspace, workspaceErr := h.Queries.GetWorkspace(r.Context(), thread.WorkspaceID)
	if workspaceErr != nil {
		return failed()
	}
	description := fmt.Sprintf("Wiki: /%s/projects/%s/engineering?%s\n\nThread: %s\n\n`multica project baseline comment show %s --thread %s --with-section`\n\n`multica project baseline comment reply %s --thread %s --content-file reply.md`", url.PathEscape(workspace.Slug), pid, deep.Encode(), tid, pid, tid, pid, tid)
	var issue db.Issue
	var err error
	if thread.IssueID.Valid {
		issue, err = h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{WorkspaceID: thread.WorkspaceID, ID: thread.IssueID})
		if err == nil && issue.ProjectID != thread.ProjectID {
			return failed()
		}
	} else {
		result, e := h.IssueService.Create(r.Context(), service.IssueCreateParams{WorkspaceID: thread.WorkspaceID, ProjectID: thread.ProjectID, Title: "Wiki 讨论 · " + inert(page.Title) + " · " + inert(string(excerpt)), Description: pgtype.Text{String: description, Valid: true}, Priority: "medium", CreatorType: actor.kind, CreatorID: actor.id}, service.IssueCreateOpts{BaselineThreadID: thread.ID, ActorID: uuidToString(actor.id)})
		issue, err = result.Issue, e
	}
	if err != nil {
		return failed()
	}
	thread.IssueID = issue.ID
	quote := []rune(thread.QuoteExact)
	if len(quote) > 120 {
		quote = quote[:120]
	}
	header := fmt.Sprintf("Wiki: %s · %s\n\n> %s\n\n%s\n\n`multica project baseline write %s --page %s --base %d --source-issue %s --content-file page.md`\n\n---\n\n", inert(page.Title), inert(thread.SectionTitle), inert(string(quote)), description, pid, page.Slug, page.LastRevisionNumber, uuidToString(issue.ID))
	row, err := h.Queries.CreateComment(r.Context(), db.CreateCommentParams{WorkspaceID: thread.WorkspaceID, IssueID: issue.ID, AuthorType: actor.kind, AuthorID: actor.id, SourceTaskID: actor.task, Type: "comment", Content: header + comment.BodyMarkdown})
	if err != nil {
		return failed()
	}
	carrier := db.Comment{ID: row.ID, WorkspaceID: thread.WorkspaceID, IssueID: issue.ID, AuthorType: actor.kind, AuthorID: actor.id, SourceTaskID: actor.task, Content: row.Content, Type: row.Type, CreatedAt: row.CreatedAt}
	h.publish(protocol.EventCommentCreated, uuidToString(thread.WorkspaceID), actor.kind, uuidToString(actor.id), map[string]any{"comment": commentToResponse(carrier, nil, nil), "issue_title": issue.Title, "issue_assignee_type": textToPtr(issue.AssigneeType), "issue_assignee_id": uuidToPtr(issue.AssigneeID), "issue_status": issue.Status})
	outcomes := h.triggerTasksForComment(r.Context(), issue, carrier, nil, actor.kind, uuidToString(actor.id), h.invokeOriginatorFromRequest(r, actor.kind, uuidToString(actor.id)), nil, commentSteerRequest{})
	if outcomes == nil {
		outcomes = []CommentTriggerOutcome{}
	}
	return outcomes
}
