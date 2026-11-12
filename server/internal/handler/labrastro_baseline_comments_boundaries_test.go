package handler

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestBaselineCommentsWakeFailureKeepsComment(t *testing.T) {
	f := commentFixture(t)
	agent, _, _ := createRuntimeGuardAgent(t, t.Context())
	created := createWikiComment(t, f, "member", "[@Private](mention://agent/"+agent+")", nil)
	if len(created.Woke) != 1 || created.Woke[0].ReasonCode != ReasonInvocationNotAllowed {
		t.Fatalf("%+v", created.Woke)
	}
	if got := showWikiComment(t, f, created.Thread.ID); len(got.Comments) != 1 {
		t.Fatal("blocked dispatch lost comment")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE issue_id=$1`, *created.Thread.IssueID); n != 0 {
		t.Fatal("blocked invocation enqueued task")
	}
}

func TestBaselineCommentsStorageConstraintsAndCascade(t *testing.T) {
	f := commentFixture(t)
	created := createWikiComment(t, f, "member", "body", nil)
	ctx := t.Context()
	for _, stmt := range []string{
		`UPDATE project_baseline_thread SET resolved_at=now() WHERE id=$1`,
		`UPDATE project_baseline_thread SET resolved_by_id=created_by_id WHERE id=$1`,
		`UPDATE project_baseline_thread SET quote_start=-1 WHERE id=$1`,
	} {
		if _, err := testPool.Exec(ctx, stmt, created.Thread.ID); err == nil {
			t.Fatalf("constraint accepted %s", stmt)
		}
	}
	for _, stmt := range []string{
		`UPDATE project_baseline_comment SET author_type='legacy_agent' WHERE id=$1`,
		`UPDATE project_baseline_comment SET author_id=NULL WHERE id=$1`,
		`UPDATE project_baseline_comment SET body_markdown=repeat('x',4001) WHERE id=$1`,
	} {
		if _, err := testPool.Exec(ctx, stmt, created.Comment.ID); err == nil {
			t.Fatalf("constraint accepted %s", stmt)
		}
	}
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := db.New(tx).LabrastroDeleteProjectEngineering(ctx, db.LabrastroDeleteProjectEngineeringParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_baseline_thread WHERE project_id=$1)+(SELECT count(*) FROM project_baseline_comment WHERE project_id=$1)`, f.project).Scan(&n); err != nil || n != 0 {
		t.Fatalf("cascade n=%d err=%v", n, err)
	}
}

func TestBaselineCommentsLimitsAndFilters(t *testing.T) {
	f := commentFixture(t)
	created := createWikiComment(t, f, "member", "body", nil)
	resolveWikiComment(t, f, "task", created.Thread.ID, true)
	for _, state := range []string{"open", "resolved", "all"} {
		var out struct {
			Threads []wikiThreadResponse `json:"threads"`
		}
		testutil.Call(t, testHandler.LabrastroWikiThreads, f.request("member", "GET", "/baseline/pages/discussion/threads?state="+state, nil, map[string]string{"page": "discussion"})).Want(200).JSON(&out)
		want := 1
		if state == "open" {
			want = 0
		}
		if len(out.Threads) != want {
			t.Fatalf("%s %+v", state, out.Threads)
		}
	}
	dbfx.Exec(t, `INSERT INTO project_baseline_comment(workspace_id,project_id,thread_id,body_markdown,author_type,author_id) SELECT workspace_id,project_id,id,'body','member',created_by_id FROM project_baseline_thread CROSS JOIN generate_series(1,199) WHERE id=$1`, created.Thread.ID)
	wantBaselineWikiCode(t, testutil.Call(t, testHandler.LabrastroReplyWikiThread, f.request("task", "POST", "/baseline/threads/x/comments", map[string]any{"body_markdown": "overflow"}, map[string]string{"thread": created.Thread.ID})), 422, "baseline_comment_limit")
	dbfx.Exec(t, `INSERT INTO project_baseline_thread(workspace_id,project_id,page_id,anchor_kind,section_anchor,created_by_type,created_by_id) SELECT workspace_id,project_id,page_id,'section','A','member',created_by_id FROM project_baseline_thread CROSS JOIN generate_series(1,499) WHERE id=$1`, created.Thread.ID)
	wantBaselineWikiCode(t, testutil.Call(t, testHandler.LabrastroCreateWikiThread, f.request("task", "POST", "/baseline/pages/discussion/threads", map[string]any{"quote": "needle", "body_markdown": "overflow"}, map[string]string{"page": "discussion"})), 422, "baseline_thread_limit")
}

func TestBaselineCommentsAgentAndSquadWakeReuseRouting(t *testing.T) {
	f := commentFixture(t)
	target, _, _ := createRuntimeGuardAgent(t, t.Context())
	squad := createCommentTriggerPreviewSquad(t, "Wiki squad", target)
	dbfx.Exec(t, `UPDATE agent_task_queue SET originator_user_id=$2, accountable_user_id=$2 WHERE id=$1`, f.task, testUserID)
	req := f.request("task", "POST", "/baseline/pages/discussion/threads", map[string]any{"quote": "needle", "body_markdown": "[@Target](mention://agent/" + target + ") [@Squad](mention://squad/" + squad + ")"}, map[string]string{"page": "discussion"})
	req.Header.Set("X-Task-ID", f.task)
	var out wikiCommentWriteOut
	testutil.Call(t, testHandler.LabrastroCreateWikiThread, req).Want(201).JSON(&out)
	if out.Thread.IssueID == nil || len(out.Woke) != 2 {
		t.Fatalf("%+v", out)
	}
	for _, w := range out.Woke {
		if w.Status == DispatchBlocked {
			t.Fatalf("%+v", out.Woke)
		}
	}
	if out.Comment.AuthorType != "agent" || out.Comment.AuthorID != f.agent || out.Comment.AuthorTaskID == nil || *out.Comment.AuthorTaskID != f.task {
		t.Fatalf("lost actor: %+v", out.Comment)
	}
	var count int
	var leader bool
	dbfx.QueryRow(t, `SELECT count(*),coalesce(bool_or(is_leader_task AND squad_id=$2),false) FROM agent_task_queue WHERE issue_id=$1`, *out.Thread.IssueID, squad).Scan(&count, &leader)
	if count != 1 || !leader {
		t.Fatalf("count=%d squad leader=%v", count, leader)
	}
}
