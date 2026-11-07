package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type annotationReviewResult struct {
	Batch  db.ProjectBaselineAnnotationBatch `json:"batch"`
	Review db.ProjectBaselineReview          `json:"review"`
	Woke   struct {
		AgentID string `json:"agent_id"`
		Via     string `json:"via"`
	} `json:"woke"`
}
type annotationDetail struct {
	Batch       baselineAnnotationBatchResponse `json:"batch"`
	Annotations []baselineAnnotationResponse    `json:"annotations"`
	Sections    []struct {
		Anchor  string `json:"anchor"`
		Content string `json:"content_markdown"`
	} `json:"sections"`
}

func annotationFixture(t *testing.T) engineeringFixture {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	f := newEngineeringFixture(t)
	for _, table := range []string{"project_baseline_annotation", "project_baseline_review", "project_baseline_annotation_batch"} {
		dbfx.Cleanup(t, "DELETE FROM "+table+" WHERE workspace_id=$1 AND project_id=$2", testWorkspaceID, f.project)
	}
	dbfx.Cleanup(t, `DELETE FROM issue WHERE workspace_id=$1 AND project_id=$2`, testWorkspaceID, f.project)
	dbfx.Cleanup(t, `DELETE FROM comment WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1 AND project_id=$2)`, testWorkspaceID, f.project)
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1 AND project_id=$2)`, testWorkspaceID, f.project)
	f.enable()
	return f
}

func reviewBody(f engineeringFixture, revision baselineRevisionResponse) map[string]any {
	return map[string]any{"client_key": uuid.NewString(), "chapter": revision.Chapter, "reviewed_revision_id": uuidToString(revision.ID), "assignee": map[string]string{"type": "agent", "id": f.agent}, "summary": "统一规则 [@other](mention://agent/" + uuid.NewString() + ")", "annotations": []map[string]any{{"anchor_kind": "lines", "target_revision_id": uuidToString(revision.ID), "section_anchor": "RULE-1", "line_start": 2, "line_end": 2, "quote": "secret-quote", "note": "secret-note [@unwanted](mention://agent/" + uuid.NewString() + ")"}}}
}
func submitReview(t *testing.T, f engineeringFixture, body any) annotationReviewResult {
	t.Helper()
	var result annotationReviewResult
	testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(201).JSON(&result)
	return result
}
func readAnnotations(t *testing.T, f engineeringFixture, batch pgtype.UUID, query string) annotationDetail {
	t.Helper()
	var out annotationDetail
	r := f.request("GET", "/baseline/annotation-batches/"+uuidToString(batch)+query, nil, "task")
	chi.RouteContext(r.Context()).URLParams.Add("batch", uuidToString(batch))
	testutil.Call(t, testHandler.LabrastroReadAnnotationBatch, r).Want(200).JSON(&out)
	return out
}

func TestBaselineAnnotationsCarrierAndSingleWake(t *testing.T) {
	for _, mode := range []string{"reading", "candidate_without_source", "source_author_assigned", "source_other_assignee"} {
		t.Run(mode, func(t *testing.T) {
			f := annotationFixture(t)
			revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n### Child\nchild-body\n", nil, nil)
			var source string
			if strings.HasPrefix(mode, "source_") {
				assignee := f.agent
				if mode == "source_other_assignee" {
					assignee = dbfx.Agent(t, "Other "+uuid.NewString(), testRuntimeID)
				}
				source = dbfx.Issue(t, "source", testutil.Cols{"project_id": f.project, "assignee_type": "agent", "assignee_id": assignee, "status": "in_progress"})
				dbfx.Exec(t, `UPDATE project_baseline_revision SET source_issue_id=$2 WHERE id=$1`, uuidToString(revision.ID), source)
			}
			if mode == "reading" {
				testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", revision), "session")).Want(200)
				revision.ProjectBaselineRevision = f.readRevision(uuidToString(revision.ID))
			}
			body := reviewBody(f, revision)
			first := submitReview(t, f, body)
			again := submitReview(t, f, body)
			if first.Batch.ID != again.Batch.ID || first.Review.ID != again.Review.ID || first.Woke.AgentID != f.agent {
				t.Fatal("review replay changed identity/agent")
			}
			carrier := uuidToString(first.Batch.IssueID)
			if source != "" && (carrier != source || first.Batch.CarrierKind != "source_issue" || first.Woke.Via != "mention") {
				t.Fatalf("source route: %+v", first)
			}
			if source == "" && (first.Batch.CarrierKind != "revision_issue" || first.Woke.Via != "assign") {
				t.Fatalf("revision route: %+v", first)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, carrier); n != 1 {
				t.Fatalf("review replay queued %d tasks", n)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND agent_id<>$2`, carrier, f.agent); n != 0 {
				t.Fatal("woke an unrelated assignee")
			}
			var ticket string
			if source != "" {
				dbfx.QueryRow(t, `SELECT content FROM comment WHERE id=$1`, uuidToString(first.Review.WakeCommentID)).Scan(&ticket)
			} else {
				dbfx.QueryRow(t, `SELECT description FROM issue WHERE id=$1`, carrier).Scan(&ticket)
			}
			if strings.Contains(ticket, "secret-note") || strings.Contains(ticket, "secret-quote") || strings.Count(ticket, "mention://") > 1 {
				t.Fatalf("ticket leaked content: %s", ticket)
			}
			if mode == "candidate_without_source" && !strings.Contains(ticket, "--replaces 1") {
				t.Fatal("missing candidate replacement instruction")
			}
			// A later review of the same original candidate is Q4, even though the
			// newly-created carrier did not submit that candidate.
			body["client_key"] = uuid.NewString()
			second := submitReview(t, f, body)
			if second.Batch.ID != first.Batch.ID || second.Woke.Via != "mention" {
				t.Fatal("append review changed carrier")
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, carrier); n != 2 {
				t.Fatalf("append queued %d total tasks", n)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_annotation WHERE batch_id=$1`, uuidToString(first.Batch.ID)); n != 2 {
				t.Fatal("replay duplicated annotations")
			}
		})
	}
}

func TestBaselineAnnotationsActiveBatchScope(t *testing.T) {
	f := annotationFixture(t)
	revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
	body := reviewBody(f, revision)
	first := submitReview(t, f, body)
	for _, scope := range []string{"closed", "chapter", "project", "workspace"} {
		cols := testutil.Cols{
			"workspace_id": testWorkspaceID, "project_id": f.project, "chapter": "domain_rules",
			"carrier_kind": "revision_issue", "agent_id": f.agent,
			"created_by_type": "member", "created_by_id": testUserID,
		}
		switch scope {
		case "closed":
			cols["closed_at"], cols["close_reason"] = testutil.Raw("now()"), "manual"
		case "chapter":
			cols["chapter"] = "architecture"
		case "project":
			cols["project_id"] = uuid.NewString()
		case "workspace":
			cols["workspace_id"] = uuid.NewString()
		}
		dbfx.Insert(t, "project_baseline_annotation_batch", cols)
	}
	rows, err := testHandler.Queries.LabrastroListActiveAnnotationBatches(t.Context(), db.LabrastroListActiveAnnotationBatchesParams{
		WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), Chapter: "domain_rules",
	})
	if err != nil || len(rows) != 1 || rows[0].ID != first.Batch.ID {
		t.Fatalf("active batch scope: rows=%v err=%v", rows, err)
	}
	body["client_key"] = uuid.NewString()
	if next := submitReview(t, f, body); next.Batch.ID != first.Batch.ID {
		t.Fatal("history or unrelated scope changed the review carrier")
	}
}

func TestBaselineAnnotationsValidationRepliesAndPermissions(t *testing.T) {
	f := annotationFixture(t)
	revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n### Child\nnot parent lines\n", nil, nil)
	body := reviewBody(f, revision)
	for _, cred := range []string{"task", "cloud_pat", "other_workspace_task"} {
		testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, cred)).Want(403)
	}
	for _, change := range []map[string]any{{"line_end": 3}, {"line_start": 0}, {"section_anchor": "missing"}, {"target_revision_id": uuid.NewString()}, {"note": strings.Repeat("文", 1001)}, {"quote": strings.Repeat("文", 501)}} {
		invalid := reviewBody(f, revision)
		a := invalid["annotations"].([]map[string]any)[0]
		for k, v := range change {
			a[k] = v
		}
		testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", invalid, "session")).Want(400)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_review WHERE project_id=$1`, f.project); n != 0 {
		t.Fatal("invalid review committed rows")
	}
	result := submitReview(t, f, body)
	detail := readAnnotations(t, f, result.Batch.ID, "?with_sections=true")
	if len(detail.Annotations) != 1 || detail.Batch.Working != nil || len(detail.Sections) != 0 {
		t.Fatalf("candidate without carrier changes must use adopted: %+v", detail)
	}
	annotation := detail.Annotations[0]
	reply := reviewBody(f, revision)
	reply["annotations"] = []map[string]any{{"parent_annotation_id": uuidToString(annotation.ID), "note": "human-reply-secret", "section_anchor": "forged", "quote": "forged"}}
	submitReview(t, f, reply)
	detail = readAnnotations(t, f, result.Batch.ID, "")
	if len(detail.Annotations) != 2 || detail.Annotations[1].TargetRevisionID != annotation.TargetRevisionID || detail.Annotations[1].SectionAnchor != annotation.SectionAnchor || detail.Annotations[1].Quote != annotation.Quote {
		t.Fatal("reply did not copy parent anchor")
	}
	response := map[string]any{"responses": []map[string]string{{"annotation_id": uuidToString(annotation.ID), "response": "fixed"}}}
	testutil.Call(t, testHandler.LabrastroRespondAnnotations, f.request("POST", "/baseline/annotations/responses", response, "session")).Want(403)
	testutil.Call(t, testHandler.LabrastroRespondAnnotations, f.request("POST", "/baseline/annotations/responses", response, "task")).Want(403)
	t.Run("non_carrier_task", func(t *testing.T) {
		otherIssue := dbfx.Issue(t, "Other issue in the same project", testutil.Cols{"project_id": f.project})
		other := f
		other.task = dbfx.Task(t, f.agent, testutil.Cols{"issue_id": otherIssue, "runtime_id": testRuntimeID, "status": "running"})
		wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroRespondAnnotations,
			other.request("POST", "/baseline/annotations/responses", response, "task")).Want(403), "baseline_carrier_required")
		var storedResponse pgtype.Text
		var respondedAt pgtype.Timestamptz
		var respondedBy pgtype.UUID
		dbfx.QueryRow(t, `SELECT response, responded_at, responded_by_task_id FROM project_baseline_annotation WHERE id=$1`,
			uuidToString(annotation.ID)).Scan(&storedResponse, &respondedAt, &respondedBy)
		if storedResponse.Valid || respondedAt.Valid || respondedBy.Valid {
			t.Fatalf("non-carrier task changed response: text=%+v at=%+v task=%+v", storedResponse, respondedAt, respondedBy)
		}
	})
	dbfx.QueryRow(t, `SELECT id FROM agent_task_queue WHERE issue_id=$1 AND trigger_comment_id IS NULL`, uuidToString(result.Batch.IssueID)).Scan(&f.task)
	count := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, uuidToString(result.Batch.IssueID))
	testutil.Call(t, testHandler.LabrastroRespondAnnotations, f.request("POST", "/baseline/annotations/responses", response, "task")).Want(200)
	resolve := map[string]any{"annotation_ids": []string{uuidToString(annotation.ID)}, "resolved": true}
	testutil.Call(t, testHandler.LabrastroResolveAnnotations, f.request("POST", "/baseline/annotations/resolve", resolve, "task")).Want(403)
	testutil.Call(t, testHandler.LabrastroResolveAnnotations, f.request("POST", "/baseline/annotations/resolve", resolve, "session")).Want(200)
	if got := readAnnotations(t, f, result.Batch.ID, ""); len(got.Annotations) != 1 || got.Batch.Counts.Resolved != 1 {
		t.Fatal("open filter includes resolved annotation")
	}
	for _, credential := range []string{"task", "session"} {
		req := f.request("POST", "/baseline/annotation-batches/x/close", nil, credential)
		chi.RouteContext(req.Context()).URLParams.Add("batch", uuidToString(result.Batch.ID))
		want := 403
		if credential == "session" {
			want = 200
		}
		testutil.Call(t, testHandler.LabrastroCloseAnnotationBatch, req).Want(want)
	}
	testutil.Call(t, testHandler.LabrastroRespondAnnotations, f.request("POST", "/baseline/annotations/responses", response, "task")).Want(409)
	if got := readAnnotations(t, f, result.Batch.ID, ""); len(got.Annotations) != 0 || got.Batch.State != "closed" {
		t.Fatal("closed batch exposed open annotations")
	}
	if got := readAnnotations(t, f, result.Batch.ID, "?state=all"); len(got.Annotations) != 2 || got.Annotations[0].Response.String != "fixed" {
		t.Fatal("archived history lost")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, uuidToString(result.Batch.IssueID)); n != count {
		t.Fatal("response/resolve/close woke an agent")
	}
}

func TestBaselineAnnotationsDecisionLifecycle(t *testing.T) {
	for _, action := range []string{"adopt", "reject"} {
		for _, relation := range []string{"reviewed", "carrier", "foreign", "keep"} {
			t.Run(action+"/"+relation, func(t *testing.T) {
				f := annotationFixture(t)
				first := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
				batch := submitReview(t, f, reviewBody(f, first)).Batch
				candidate := first
				if relation == "carrier" || relation == "foreign" {
					candidate = f.propose("domain_rules", "## [RULE-1] Rules\nchanged\n", nil, uuidToPtr(first.ID))
					if relation == "carrier" {
						dbfx.Exec(t, `UPDATE project_baseline_revision SET source_issue_id=$2 WHERE id=$1`, uuidToString(candidate.ID), uuidToString(batch.IssueID))
					}
				}
				req := decision(action, candidate).(map[string]any)
				if relation == "keep" {
					req["annotation_batch_action"] = "keep"
				}
				testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", req, "session")).Want(200)
				got := readAnnotations(t, f, batch.ID, "")
				closed := relation == "reviewed" || relation == "carrier"
				if got.Batch.ClosedAt.Valid != closed || closed && len(got.Annotations) != 0 || closed && got.Batch.ClosedRevisionID != candidate.ID {
					t.Fatalf("decision relation %s: %+v", relation, got.Batch)
				}
				if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, uuidToString(batch.IssueID)); n != 1 {
					t.Fatal("decision woke agent")
				}
			})
		}
	}
}

func TestBaselineAnnotationsConflictAndCancelledCarrier(t *testing.T) {
	f := annotationFixture(t)
	first := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
	batch := submitReview(t, f, reviewBody(f, first)).Batch
	foreign := f.propose("domain_rules", "## [RULE-1] Rules\nother\n", nil, uuidToPtr(first.ID))
	body := reviewBody(f, foreign)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(409), "baseline_review_conflict")
	dbfx.Exec(t, `UPDATE issue SET status='cancelled' WHERE id=$1`, uuidToString(batch.IssueID))
	if got := readAnnotations(t, f, batch.ID, ""); got.Batch.CloseReason.String != "issue_closed" || len(got.Annotations) != 0 {
		t.Fatal("cancelled carrier remained active")
	}
	delete(body, "assignee")
	testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(400)
	if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_annotation_batch WHERE id=$1 AND close_reason='issue_closed'`, uuidToString(batch.ID)); n != 1 {
		t.Fatal("failed new review rolled back carrier closure")
	}
	body["assignee"] = map[string]string{"type": "agent", "id": f.agent}
	next := submitReview(t, f, body)
	if next.Batch.ID == batch.ID {
		t.Fatal("reused cancelled carrier")
	}
	var reason string
	dbfx.QueryRow(t, `SELECT close_reason FROM project_baseline_annotation_batch WHERE id=$1`, uuidToString(batch.ID)).Scan(&reason)
	if reason != "issue_closed" {
		t.Fatal("old batch was not durably closed")
	}
}

type annotationFailBegin struct {
	inner interface {
		Begin(context.Context) (pgx.Tx, error)
	}
	fail bool
}

func (s *annotationFailBegin) Begin(ctx context.Context) (pgx.Tx, error) {
	if s.fail {
		s.fail = false
		return nil, errors.New("injected carrier creation failure")
	}
	return s.inner.Begin(ctx)
}

func TestBaselineAnnotationsResumeAndConcurrentReplay(t *testing.T) {
	f := annotationFixture(t)
	revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
	body := reviewBody(f, revision)
	h := *testHandler
	issueService := *h.IssueService
	issueService.TxStarter = &annotationFailBegin{inner: issueService.TxStarter, fail: true}
	h.IssueService = &issueService
	testutil.Call(t, h.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(500)
	if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_review WHERE project_id=$1`, f.project); n != 1 {
		t.Fatal("review not durable before carrier creation")
	}
	other := dbfx.User(t, "Revoked invocation", uuid.NewString()+"@example.test")
	dbfx.Exec(t, `UPDATE agent SET permission_mode='private',owner_id=$2 WHERE id=$1`, f.agent, other)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(403), "invocation_not_allowed")
	dbfx.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, testUserID)
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			testHandler.LabrastroSubmitBaselineReview(w, f.request("POST", "/baseline/reviews", body, "session"))
			results <- w
		}()
	}
	wg.Wait()
	close(results)
	var batch pgtype.UUID
	for response := range results {
		if response.Code != 201 {
			t.Fatalf("replay: %d %s", response.Code, response.Body.String())
		}
		var out annotationReviewResult
		if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if batch.Valid && batch != out.Batch.ID {
			t.Fatal("different batches")
		}
		batch = out.Batch.ID
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM issue WHERE project_id=$1`, f.project); n != 1 {
		t.Fatalf("retry created %d carriers", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE project_id=$1)`, f.project); n != 1 {
		t.Fatalf("retry queued %d runs", n)
	}
}

func TestBaselineAnnotationsZeroPropagation(t *testing.T) {
	f := annotationFixture(t)
	revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", revision), "session")).Want(200)
	read := func() []string {
		ctx, err := testHandler.resolveClaimProjectContext(context.Background(), parseUUID(f.project), parseUUID(testWorkspaceID))
		if err != nil {
			t.Fatal(err)
		}
		out := []string{ctx.Description}
		for _, endpoint := range []struct {
			path    string
			handler http.HandlerFunc
		}{{"/engineering", testHandler.LabrastroGetEngineering}, {"/baseline?index=true", testHandler.LabrastroReadBaseline}, {"/baseline?chapter=domain_rules&section=RULE-1", testHandler.LabrastroReadBaseline}} {
			out = append(out, testutil.Call(t, endpoint.handler, f.request("GET", endpoint.path, nil, "task")).Want(200).Text())
		}
		return out
	}
	before := read()
	submitReview(t, f, reviewBody(f, revision))
	after := read()
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("annotation changed broadcast surface %d", i)
		}
		if strings.Contains(after[i], "annotation") || strings.Contains(after[i], "secret-note") {
			t.Fatal("annotation fields leaked")
		}
	}
}

func TestBaselineAnnotationsFourClaimPathsUnchanged(t *testing.T) {
	for _, kind := range []string{"issue", "chat", "autopilot", "quick_create"} {
		t.Run(kind, func(t *testing.T) {
			f := annotationFixture(t)
			revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
			testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", revision), "session")).Want(200)
			agent, runtime, daemon := createRuntimeGuardAgent(t, context.Background())
			cols := testutil.Cols{"runtime_id": runtime, "priority": 1000}
			switch kind {
			case "issue":
				cols["issue_id"] = dbfx.Issue(t, "unrelated claim", testutil.Cols{"project_id": f.project})
			case "chat":
				session := dbfx.ChatSession(t, agent, testutil.Cols{"project_id": f.project})
				cols["chat_session_id"] = session
				dbfx.Insert(t, "chat_message", testutil.Cols{"chat_session_id": session, "role": "user", "content": "unrelated conversation"})
			case "autopilot":
				autopilot := dbfx.Insert(t, "autopilot", testutil.Cols{"workspace_id": testWorkspaceID, "project_id": f.project, "title": "Unrelated autopilot", "assignee_id": agent, "execution_mode": "run_only", "created_by_type": "member", "created_by_id": testUserID})
				cols["autopilot_run_id"] = dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": autopilot, "source": "manual", "status": "running"})
			case "quick_create":
				payload, _ := json.Marshal(map[string]string{"type": "quick_create", "prompt": "create unrelated task", "requester_id": testUserID, "workspace_id": testWorkspaceID, "project_id": f.project})
				cols["context"] = payload
			}
			claim := func() string {
				task := dbfx.Task(t, agent, cols)
				req := withURLParam(newDaemonTokenRequest("POST", "/api/daemon/runtimes/"+runtime+"/claim", nil, testWorkspaceID, daemon), "runtimeId", runtime)
				var out struct {
					Task *struct {
						ID          string `json:"id"`
						Description string `json:"project_description"`
					} `json:"task"`
				}
				testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(200).JSON(&out)
				if out.Task == nil || out.Task.ID != task || out.Task.Description == "" {
					t.Fatalf("claim did not return expected context: %+v", out.Task)
				}
				dbfx.Exec(t, `UPDATE agent_task_queue SET status='completed' WHERE id=$1`, task)
				return out.Task.Description
			}
			before := claim()
			submitReview(t, f, reviewBody(f, revision))
			after := claim()
			if before != after {
				t.Fatalf("%s claim gained annotation context", kind)
			}
		})
	}
}

func TestBaselineAnnotationPlatformMentionDeduplicatesAssignee(t *testing.T) {
	f := annotationFixture(t)
	issue := dbfx.Issue(t, "source with matching author and assignee", testutil.Cols{"project_id": f.project, "assignee_type": "agent", "assignee_id": f.agent, "status": "in_progress"})
	req := withURLParam(newRequest("POST", "/api/issues/"+issue+"/comments", map[string]string{"content": "[@Author](mention://agent/" + f.agent + ") Review ready"}), "id", issue)
	testutil.Call(t, testHandler.CreateComment, req).Want(201)
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, issue); n != 1 {
		t.Fatalf("platform mention+assignee queued %d runs", n)
	}
}

func TestBaselineAnnotationsInvocationAndNonDeciderGate(t *testing.T) {
	f := annotationFixture(t)
	revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
	other := dbfx.User(t, "Other", uuid.NewString()+"@example.test")
	dbfx.Member(t, testWorkspaceID, other, "member")
	private := dbfx.Agent(t, "Private "+uuid.NewString(), testRuntimeID, testutil.Cols{"owner_id": other, "permission_mode": "private"})
	body := reviewBody(f, revision)
	body["assignee"] = map[string]string{"type": "agent", "id": private}
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(403), "invocation_not_allowed")
	req := f.request("POST", "/baseline/reviews", reviewBody(f, revision), "session")
	req.Header.Set("X-User-ID", other)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, req).Want(403), "baseline_not_decider")
	result := submitReview(t, f, reviewBody(f, revision))
	req = f.request("GET", "/baseline/annotation-batches/"+uuidToString(result.Batch.ID), nil, "session")
	req.Header.Set("X-User-ID", other)
	chi.RouteContext(req.Context()).URLParams.Add("batch", uuidToString(result.Batch.ID))
	testutil.Call(t, testHandler.LabrastroReadAnnotationBatch, req).Want(200)
}

func TestBaselineAnnotationsAtomicWakeFailureRecovery(t *testing.T) {
	for _, route := range []string{"revision", "source"} {
		for _, fault := range []string{"CreateAgentTask", "commit"} {
			t.Run(route+"/"+fault, func(t *testing.T) {
				f := annotationFixture(t)
				revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
				if route == "source" {
					issue := dbfx.Issue(t, "source", testutil.Cols{"project_id": f.project})
					dbfx.Exec(t, `UPDATE project_baseline_revision SET source_issue_id=$2 WHERE id=$1`, uuidToString(revision.ID), issue)
				}
				body := reviewBody(f, revision)
				h := *testHandler
				failure := &sqlFaultStarter{txStarter: h.TxStarter, query: fault, commit: fault == "commit"}
				if route == "revision" {
					svc := *h.IssueService
					svc.TxStarter = failure
					h.IssueService = &svc
				} else {
					h.TxStarter = failure
				}
				testutil.Call(t, h.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(500)
				if fault != "commit" {
					if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE project_id=$1)`, f.project); n != 0 {
						t.Fatal("failed transaction committed a task")
					}
					if n := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id IN (SELECT id FROM issue WHERE project_id=$1)`, f.project); n != 0 {
						t.Fatal("failed transaction committed a wake comment")
					}
				}
				result := submitReview(t, f, body)
				if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, uuidToString(result.Batch.IssueID)); n != 1 {
					t.Fatalf("retry after %s queued %d tasks", fault, n)
				}
				if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_review WHERE project_id=$1`, f.project); n != 1 {
					t.Fatal("retry duplicated review")
				}
			})
		}
	}
}

func TestBaselineAnnotationsQuotaIncludesHumanReplies(t *testing.T) {
	f := annotationFixture(t)
	revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
	body := reviewBody(f, revision)
	one := body["annotations"].([]map[string]any)[0]
	for _, size := range []int{0, 21} {
		annotations := []map[string]any{}
		for range size {
			annotations = append(annotations, one)
		}
		body["annotations"] = annotations
		testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(400)
	}
	body["annotations"] = []map[string]any{one}
	batch := submitReview(t, f, body).Batch
	first := readAnnotations(t, f, batch.ID, "").Annotations[0]
	for _, size := range []int{20, 20, 9} {
		body["client_key"] = uuid.NewString()
		annotations := []map[string]any{}
		for range size {
			annotations = append(annotations, map[string]any{"parent_annotation_id": uuidToString(first.ID), "note": "reply"})
		}
		body["annotations"] = annotations
		submitReview(t, f, body)
	}
	body["client_key"] = uuid.NewString()
	body["annotations"] = []map[string]any{one}
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", body, "session")).Want(409), "baseline_annotation_limit")
	if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_annotation WHERE batch_id=$1`, uuidToString(batch.ID)); n != 50 {
		t.Fatalf("batch total=%d", n)
	}
}

func TestBaselineAnnotationsWorkingVersionAndBeforeSide(t *testing.T) {
	f := annotationFixture(t)
	base := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n### Child\nChild body\n", nil, nil)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", base), "session")).Want(200)
	candidate := f.propose("domain_rules", "## [RULE-1] Rules\nextra\nsecret-quote\n### Child\nChild body\n", uuidToPtr(base.ID), nil)
	body := reviewBody(f, candidate)
	body["annotations"].([]map[string]any)[0]["target_revision_id"] = uuidToString(base.ID)
	batch := submitReview(t, f, body).Batch
	dbfx.Exec(t, `UPDATE project_baseline_revision SET source_issue_id=$2 WHERE id=$1`, uuidToString(candidate.ID), uuidToString(batch.IssueID))
	got := readAnnotations(t, f, batch.ID, "?with_sections=true")
	if got.Batch.Working == nil || got.Batch.Working.RevisionID != candidate.ID || len(got.Annotations) != 1 || got.Annotations[0].Side != "before" || got.Annotations[0].Location != "moved" || *got.Annotations[0].Located.LineStart != 3 || len(got.Sections) != 1 || !strings.Contains(got.Sections[0].Content, "Child body") {
		t.Fatalf("location/subtree=%+v", got)
	}
	listed := testutil.Call(t, testHandler.LabrastroListAnnotationBatches, f.request("GET", "/baseline/annotation-batches?chapter=domain_rules&state=open&issue_id="+uuidToString(batch.IssueID), nil, "task")).Want(200).Text()
	if strings.Contains(listed, "secret-quote") || strings.Contains(listed, "secret-note") || strings.Contains(listed, "annotations") {
		t.Fatalf("batch list leaked body: %s", listed)
	}
}

func TestBaselineAnnotationsProjectAndWorkspaceCleanup(t *testing.T) {
	a, b := annotationFixture(t), annotationFixture(t)
	for _, f := range []engineeringFixture{a, b} {
		revision := f.propose("domain_rules", "## [RULE-1] Rules\nsecret-quote\n", nil, nil)
		submitReview(t, f, reviewBody(f, revision))
	}
	testutil.Call(t, testHandler.DeleteProject, a.request("DELETE", "", nil, "session")).Want(204)
	tables := []string{"project_baseline_annotation", "project_baseline_review", "project_baseline_annotation_batch"}
	for _, table := range tables {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", a.project); n != 0 {
			t.Fatal("project cleanup retained " + table)
		}
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", b.project); n != 1 {
			t.Fatal("project cleanup removed other " + table)
		}
	}
	ws := dbfx.Workspace(t, "Annotation cleanup", "annotations-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	for _, table := range tables {
		dbfx.Exec(t, "INSERT INTO "+table+" SELECT (jsonb_populate_record(NULL::"+table+",to_jsonb(t)||jsonb_build_object('workspace_id',$2::text,'id',gen_random_uuid()))).* FROM "+table+" t WHERE t.project_id=$1", b.project, ws)
	}
	req := withURLParam(newRequest("DELETE", "/api/workspaces/"+ws, nil), "id", ws)
	req.Header.Set("X-Workspace-ID", ws)
	testutil.Call(t, testHandler.DeleteWorkspace, req).Want(204)
	for _, table := range tables {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws); n != 0 {
			t.Fatal("workspace cleanup retained " + table)
		}
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", b.project); n != 1 {
			t.Fatal("workspace cleanup removed unrelated " + table)
		}
	}
}

func TestBaselineAnnotationTextBlockLines(t *testing.T) {
	f := annotationFixture(t)
	revision := f.propose("domain_rules", "## [RULE-1] Rules\nfirst block\n\nsecond block\n", nil, nil)
	body := reviewBody(f, revision)
	a := body["annotations"].([]map[string]any)[0]
	a["anchor_kind"] = "text"
	a["quote"] = "first block"
	a["line_start"] = 2
	a["line_end"] = 2
	result := submitReview(t, f, body)
	detail := readAnnotations(t, f, result.Batch.ID, "")
	if len(detail.Annotations) != 1 || detail.Annotations[0].LineStart.Int32 != 2 || detail.Annotations[0].LineEnd.Int32 != 2 {
		t.Fatalf("text block lines were not preserved: %+v", detail.Annotations)
	}
	for _, kind := range []string{"section", "text"} {
		invalid := reviewBody(f, revision)
		annotation := invalid["annotations"].([]map[string]any)[0]
		annotation["anchor_kind"] = kind
		if kind == "text" {
			delete(annotation, "line_end")
		}
		testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", invalid, "session")).Want(400)
	}
	outOfRange := reviewBody(f, revision)
	annotation := outOfRange["annotations"].([]map[string]any)[0]
	annotation["anchor_kind"] = "text"
	annotation["line_start"] = 2
	annotation["line_end"] = 5
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroSubmitBaselineReview, f.request("POST", "/baseline/reviews", outOfRange, "session")).Want(400), "invalid_annotation_lines")
}
