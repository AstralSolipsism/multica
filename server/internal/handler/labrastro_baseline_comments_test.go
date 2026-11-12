package handler

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

type wikiCommentWriteOut struct {
	Thread  wikiThreadResponse      `json:"thread"`
	Comment wikiCommentResponse     `json:"comment"`
	Woke    []CommentTriggerOutcome `json:"woke"`
}

func commentFixture(t *testing.T) baselineWikiFixture {
	t.Helper()
	f := newBaselineWikiFixture(t)
	f.enable()
	f.create("session", "Discussion page", "discussion", nil, nil, "## A\nfirst needle\n### Child\nchild text\n## B\nsecond text")
	dbfx.Cleanup(t, `DELETE FROM issue WHERE project_id=$1`, f.project)
	dbfx.Cleanup(t, `DELETE FROM comment WHERE issue_id IN (SELECT id FROM issue WHERE project_id=$1)`, f.project)
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE project_id=$1)`, f.project)
	dbfx.Cleanup(t, `DELETE FROM project_baseline_thread WHERE project_id=$1`, f.project)
	dbfx.Cleanup(t, `DELETE FROM project_baseline_comment WHERE project_id=$1`, f.project)
	return f
}

func createWikiComment(t *testing.T, f baselineWikiFixture, credential, body string, extra map[string]any) wikiCommentWriteOut {
	t.Helper()
	input := map[string]any{"quote": "needle", "section": "A", "body_markdown": body}
	for k, v := range extra {
		input[k] = v
	}
	var out wikiCommentWriteOut
	testutil.Call(t, testHandler.LabrastroCreateWikiThread, f.request(credential, "POST", "/baseline/pages/discussion/threads", input, map[string]string{"page": "discussion"})).Want(201).JSON(&out)
	return out
}
func replyWikiComment(t *testing.T, f baselineWikiFixture, credential, id, body string) wikiCommentWriteOut {
	t.Helper()
	var out wikiCommentWriteOut
	testutil.Call(t, testHandler.LabrastroReplyWikiThread, f.request(credential, "POST", "/baseline/threads/"+id+"/comments", map[string]any{"body_markdown": body}, map[string]string{"thread": id})).Want(201).JSON(&out)
	return out
}
func resolveWikiComment(t *testing.T, f baselineWikiFixture, credential, id string, resolved bool) {
	t.Helper()
	testutil.Call(t, testHandler.LabrastroResolveWikiThread, f.request(credential, "POST", "/baseline/threads/"+id+"/resolve", map[string]any{"resolved": resolved}, map[string]string{"thread": id})).Want(200)
}
func showWikiComment(t *testing.T, f baselineWikiFixture, id string) wikiThreadResponse {
	t.Helper()
	var out struct {
		Thread wikiThreadResponse `json:"thread"`
	}
	testutil.Call(t, testHandler.LabrastroWikiThread, f.request("task", "GET", "/baseline/threads/"+id+"?with_section=true", nil, map[string]string{"thread": id})).Want(200).JSON(&out)
	return out.Thread
}

func TestBaselineCommentsPermissionsAndLifecycle(t *testing.T) {
	f := commentFixture(t)
	for _, credential := range []string{"session", "admin", "member", "pat", "task"} {
		t.Run(credential, func(t *testing.T) {
			created := createWikiComment(t, f, credential, "initial", nil)
			if len(created.Woke) != 0 || created.Thread.IssueID != nil {
				t.Fatalf("plain create side effects: %+v", created)
			}
			replyWikiComment(t, f, "member", created.Thread.ID, "reply")
			resolveWikiComment(t, f, credential, created.Thread.ID, true)
			if showWikiComment(t, f, created.Thread.ID).ResolvedAt == nil {
				t.Fatal("resolve lost")
			}
			resolveWikiComment(t, f, "task", created.Thread.ID, false)
			shown := showWikiComment(t, f, created.Thread.ID)
			if shown.ResolvedAt != nil || shown.Section == nil || strings.Contains(shown.Section.Markdown, "child text") {
				t.Fatalf("current own section: %+v", shown)
			}
			testutil.Call(t, testHandler.LabrastroEditWikiComment, f.request(credential, "PATCH", "/baseline/comments/x", map[string]any{"body_markdown": "edited"}, map[string]string{"comment": created.Comment.ID})).Want(200)
		})
	}
	created := createWikiComment(t, f, "task", "agent-authored", nil)
	for _, credential := range []string{"session", "admin", "member"} {
		wantBaselineWikiCode(t, testutil.Call(t, testHandler.LabrastroEditWikiComment, f.request(credential, "PATCH", "/baseline/comments/x", map[string]any{"body_markdown": "forged"}, map[string]string{"comment": created.Comment.ID})), 403, "baseline_comment_forbidden")
	}
	wantBaselineWikiCode(t, testutil.Call(t, testHandler.LabrastroDeleteWikiComment, f.request("member", "DELETE", "/baseline/comments/x", nil, map[string]string{"comment": created.Comment.ID})), 403, "baseline_comment_forbidden")
	testutil.Call(t, testHandler.LabrastroDeleteWikiComment, f.request("admin", "DELETE", "/baseline/comments/x", nil, map[string]string{"comment": created.Comment.ID})).Want(200)
	testutil.Call(t, testHandler.LabrastroWikiThread, f.request("session", "GET", "/baseline/threads/x", nil, map[string]string{"thread": created.Thread.ID})).Want(404)
	// An agent running on behalf of an owner is still an agent, not an admin.
	own := createWikiComment(t, f, "member", "member-authored", nil)
	testutil.Call(t, testHandler.LabrastroDeleteWikiComment, f.request("task", "DELETE", "/baseline/comments/x", nil, map[string]string{"comment": own.Comment.ID})).Want(403)
	for _, credential := range []string{"forged_wrong_user", "forged_bad_user_header", "forged_task_no_source", "forged_task_cloud_source", "forged_task_other_workspace"} {
		testutil.Call(t, testHandler.LabrastroCreateWikiThread, f.request(credential, "POST", "/baseline/pages/discussion/threads", map[string]any{"quote": "needle", "body_markdown": "forged"}, map[string]string{"page": "discussion"})).Want(403)
	}
	f.flip("session", "discussion", 1, nil, true)
	wantBaselineWikiCode(t, testutil.Call(t, testHandler.LabrastroCreateWikiThread, f.request("member", "POST", "/baseline/pages/discussion/threads", map[string]any{"quote": "needle", "body_markdown": "archived"}, map[string]string{"page": "discussion"})), 409, "baseline_page_archived")
	wantBaselineWikiCode(t, testutil.Call(t, testHandler.LabrastroReplyWikiThread, f.request("member", "POST", "/baseline/threads/x/comments", map[string]any{"body_markdown": "archived"}, map[string]string{"thread": own.Thread.ID})), 409, "baseline_page_archived")
}

func TestBaselineCommentsIsolationAndAnchoring(t *testing.T) {
	f := commentFixture(t)
	foreign := commentFixture(t)
	created := createWikiComment(t, f, "member", "secret-comment", nil)
	testutil.Call(t, testHandler.LabrastroWikiThread, foreign.request("session", "GET", "/baseline/threads/x", nil, map[string]string{"thread": created.Thread.ID})).Want(404)
	testutil.Call(t, testHandler.LabrastroDeleteWikiComment, foreign.request("session", "DELETE", "/baseline/comments/x", nil, map[string]string{"comment": created.Comment.ID})).Want(404)
	foreignIssue := dbfx.Issue(t, "foreign project issue", testutil.Cols{"project_id": foreign.project})
	testutil.Call(t, testHandler.LabrastroCreateWikiThread, f.request("task", "POST", "/baseline/pages/discussion/threads", map[string]any{"quote": "needle", "body_markdown": "bad link", "carrier_issue_id": foreignIssue}, map[string]string{"page": "discussion"})).Want(422)
	f.fullWrite("task", "discussion", 1, "## A\nfirst needle\n### Child\nchild entirely changed\n## B\nsecond text")
	if got := showWikiComment(t, f, created.Thread.ID); got.AnchorState != "anchored" {
		t.Fatalf("unrelated edit detached thread: %+v", got)
	}
	f.fullWrite("task", "discussion", 2, "## Renamed\nfirst needle\n## B\nsecond text")
	if got := showWikiComment(t, f, created.Thread.ID); got.AnchorState != "moved" || got.Location.SectionAnchor != "Renamed" {
		t.Fatalf("rename detached: %+v", got)
	}
	f.fullWrite("task", "discussion", 3, "## A\nremoved\n## B\nsecond text")
	if got := showWikiComment(t, f, created.Thread.ID); got.AnchorState != "section_only" {
		t.Fatal(got)
	}
	f.fullWrite("task", "discussion", 4, "## B\nsecond text")
	if got := showWikiComment(t, f, created.Thread.ID); got.AnchorState != "orphaned" {
		t.Fatal(got)
	}
	var anchor string
	dbfx.QueryRow(t, `SELECT section_anchor FROM project_baseline_thread WHERE id=$1`, created.Thread.ID).Scan(&anchor)
	if anchor != "A" {
		t.Fatal("read-time anchoring rewrote snapshot")
	}
	f.fullWrite("task", "discussion", 5, "## A\nneedle needle")
	for _, tc := range []struct{ quote, code string }{{"needle", "baseline_quote_ambiguous"}, {"missing", "baseline_quote_not_found"}} {
		wantBaselineWikiCode(t, testutil.Call(t, testHandler.LabrastroCreateWikiThread, f.request("task", "POST", "/baseline/pages/discussion/threads", map[string]any{"quote": tc.quote, "body_markdown": "body"}, map[string]string{"page": "discussion"})), 422, tc.code)
	}
}

func TestBaselineCommentsNoMentionNoSideEffects(t *testing.T) {
	f := commentFixture(t)
	counts := func() []int {
		return []int{dbfx.Count(t, `SELECT count(*) FROM issue WHERE workspace_id=$1`, testWorkspaceID), dbfx.Count(t, `SELECT count(*) FROM comment WHERE workspace_id=$1`, testWorkspaceID), dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id=$1)`, testWorkspaceID)}
	}
	before := counts()
	for _, body := range []string{"ordinary", "[@Human](mention://member/" + testUserID + ")", "[@all](mention://all/all)", "```md\n[@Agent](mention://agent/" + f.agent + ")\n```", "`[@Agent](mention://agent/" + f.agent + ")`"} {
		created := createWikiComment(t, f, "member", body, nil)
		replyWikiComment(t, f, "task", created.Thread.ID, body)
		testutil.Call(t, testHandler.LabrastroEditWikiComment, f.request("member", "PATCH", "/baseline/comments/x", map[string]any{"body_markdown": "[@Agent](mention://agent/" + f.agent + ")"}, map[string]string{"comment": created.Comment.ID})).Want(200)
		resolveWikiComment(t, f, "member", created.Thread.ID, true)
		if after := counts(); !reflect.DeepEqual(before, after) {
			t.Fatalf("side effects before=%v after=%v", before, after)
		}
	}
}

func TestBaselineCommentsCarrierAndExplicitWake(t *testing.T) {
	f := commentFixture(t)
	agent, runtime, _ := createRuntimeGuardAgent(t, t.Context())
	handler := dbfx.Agent(t, "Workflow handler "+uuid.NewString(), runtime)
	wf := createTestWorkflowSteps(t, "Wiki "+uuid.NewString(), []map[string]any{{"status_key": "backlog"}, {"status_key": "todo", "handler": map[string]any{"type": "agent", "id": handler}}})
	setProjectWorkflow(t, f.project, map[string]any{"workflow_id": wf.ID}).Want(200)
	// Context snapshots contain syntactically valid mentions but remain inert.
	heading := "Ask [@Other](mention://agent/" + handler + ")"
	f.fullWrite("session", "discussion", 1, "## "+heading+"\nfirst needle")
	selector := map[string]any{"section": heading}
	created := createWikiComment(t, f, "session", "[@Target](mention://agent/"+agent+") Please inspect", selector)
	if created.Thread.Anchor.SectionTitle != heading {
		t.Fatalf("mention missing from section snapshot: %+v", created.Thread.Anchor)
	}
	if created.Thread.IssueID == nil || len(created.Woke) != 1 || created.Woke[0].TargetID != agent || created.Woke[0].Status == DispatchBlocked {
		t.Fatalf("explicit wake: %+v", created)
	}
	carrier := *created.Thread.IssueID
	var status string
	var assigned bool
	dbfx.QueryRow(t, `SELECT status,assignee_id IS NOT NULL FROM issue WHERE id=$1`, carrier).Scan(&status, &assigned)
	if status != "backlog" || assigned {
		t.Fatalf("carrier status=%s assigned=%v", status, assigned)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2`, carrier, handler); n != 0 {
		t.Fatalf("workflow handler enqueued %d", n)
	}
	second := replyWikiComment(t, f, "session", created.Thread.ID, "[@Target](mention://agent/"+agent+") follow-up")
	if second.Thread.IssueID == nil || *second.Thread.IssueID != carrier {
		t.Fatal("carrier was not reused")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM issue WHERE project_id=$1`, f.project); n != 1 {
		t.Fatalf("carriers=%d", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM comment WHERE issue_id=$1 AND author_type='member'`, carrier); n != 2 {
		t.Fatalf("carrier comments=%d", n)
	}
	var content string
	dbfx.QueryRow(t, `SELECT content FROM comment WHERE issue_id=$1 AND author_type='member' ORDER BY created_at LIMIT 1`, carrier).Scan(&content)
	mentions := util.ParseMentions(content)
	if len(mentions) != 1 || mentions[0].ID != agent {
		t.Fatalf("context activated mention: %v", mentions)
	}
	if !strings.Contains(content, "--with-section") || !strings.Contains(content, "thread=") {
		t.Fatal("missing pull instructions")
	}
	related := f.readPage("discussion", "?with=related_issues").RelatedIssues
	if len(related) != 1 || related[0].ID != carrier {
		t.Fatalf("carrier missing from footer: %+v", related)
	}
	// Binding an existing issue does not add an issue or comment until @.
	bound := createWikiComment(t, f, "task", "plain bound", map[string]any{"carrier_issue_id": carrier, "section": heading})
	if bound.Thread.IssueID == nil || *bound.Thread.IssueID != carrier || len(bound.Woke) != 0 {
		t.Fatal(bound)
	}
}

func TestBaselineCommentsCarrierTitlePlainText(t *testing.T) {
	f := commentFixture(t)
	agent, _, _ := createRuntimeGuardAgent(t, t.Context())
	f.fullWrite("session", "discussion", 1, "## A\nToken-TTL: 15 min.")
	f.tryPatch("session", "discussion", map[string]any{"base_revision_number": 2, "title": "Auth   v1.2 (draft)"}).Want(200)
	created := createWikiComment(t, f, "session", "[@Target](mention://agent/"+agent+") Please inspect", map[string]any{"quote": "Token-TTL: 15 min."})
	if created.Thread.IssueID == nil {
		t.Fatalf("carrier missing: %+v", created)
	}
	const want = "Wiki 讨论 · Auth v1.2 (draft) · Token-TTL: 15 min."
	var title string
	dbfx.QueryRow(t, `SELECT title FROM issue WHERE id=$1`, *created.Thread.IssueID).Scan(&title)
	if title != want {
		t.Errorf("carrier title = %q, want %q", title, want)
	}
	related := f.readPage("discussion", "?with=related_issues").RelatedIssues
	if len(related) != 1 || related[0].Title != want {
		t.Fatalf("footer title: %+v", related)
	}
}

func TestBaselineCommentsConcurrentCarrier(t *testing.T) {
	f := commentFixture(t)
	created := createWikiComment(t, f, "member", "initial", nil)
	agent, _, _ := createRuntimeGuardAgent(t, t.Context())
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() { replyWikiComment(t, f, "member", created.Thread.ID, "[@Target](mention://agent/"+agent+")") })
	}
	wg.Wait()
	if n := dbfx.Count(t, `SELECT count(*) FROM issue WHERE project_id=$1`, f.project); n != 1 {
		t.Fatalf("concurrent carriers=%d", n)
	}
}

func TestBaselineCommentsZeroPropagation(t *testing.T) {
	f := commentFixture(t)
	read := func() []string {
		ctx, err := testHandler.resolveClaimProjectContext(t.Context(), parseUUID(f.project), parseUUID(testWorkspaceID))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(ctx)
		return []string{string(raw), testutil.Call(t, testHandler.LabrastroWikiTree, f.request("task", "GET", "/baseline/tree", nil, nil)).Want(200).Text(), testutil.Call(t, testHandler.LabrastroReadWikiPage, f.request("task", "GET", "/baseline/pages/discussion", nil, map[string]string{"page": "discussion"})).Want(200).Text()}
	}
	before := read()
	created := createWikiComment(t, f, "member", "SECRET-COMMENT", nil)
	assert := func() {
		t.Helper()
		after := read()
		if !reflect.DeepEqual(before, after) {
			t.Fatal("comments changed context/tree/get")
		}
		for _, body := range after {
			for _, needle := range []string{`"comment"`, `"comments"`, `"thread"`, `"threads"`, "SECRET-COMMENT"} {
				if strings.Contains(body, needle) {
					t.Fatalf("leaked %s", needle)
				}
			}
		}
	}
	assert()
	replyWikiComment(t, f, "task", created.Thread.ID, "SECRET-COMMENT")
	assert()
	resolveWikiComment(t, f, "member", created.Thread.ID, true)
	assert()
}

func TestBaselineCommentsFourClaimPathsUnchanged(t *testing.T) {
	for _, kind := range []string{"issue", "chat", "autopilot", "quick_create"} {
		t.Run(kind, func(t *testing.T) {
			f := commentFixture(t)
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
			created := createWikiComment(t, f, "member", "SECRET-COMMENT", nil)
			replyWikiComment(t, f, "task", created.Thread.ID, "SECRET-COMMENT")
			resolveWikiComment(t, f, "member", created.Thread.ID, true)
			after := claim()
			if before != after {
				t.Fatalf("%s claim gained comment context", kind)
			}
		})
	}
}
