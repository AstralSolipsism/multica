package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type yskFixture struct {
	*testutil.Fixture
	h                                    Handler
	runtime, agent, issue, comment, task string
}

func newYSKFixture(t *testing.T) *yskFixture {
	t.Helper()
	ws := dbfx.Workspace(t, "YSK", "ysk-"+uuid.NewString(), testutil.Cols{"issue_prefix": "YSK", "settings": `{"you_should_know_enabled":true}`})
	fx := testutil.New(testPool, ws, testUserID)
	fx.Member(t, ws, testUserID, "owner")
	f := &yskFixture{Fixture: fx, h: *testHandler}
	f.h.Bus = events.New()
	f.runtime = fx.Runtime(t, "YSK Claude", testutil.Cols{"provider": "claude", "daemon_id": "ysk-daemon", "runtime_mode": "local"})
	f.agent = fx.Agent(t, "YSK agent", f.runtime, testutil.Cols{"runtime_mode": "local"})
	f.issue = fx.Issue(t, "YSK issue")
	f.comment = fx.Comment(t, f.issue, "Human context")
	f.task = fx.Task(t, f.agent, testutil.Cols{
		"issue_id": f.issue, "runtime_id": f.runtime, "status": "running", "trigger_comment_id": f.comment,
		"dispatched_at": testutil.Raw("now()"), "started_at": testutil.Raw("now()"),
		"accountable_user_id": testUserID, "originator_user_id": testUserID, "originator_source": "direct_human",
	})
	fx.Cleanup(t, `DELETE FROM labrastro_issue_tip_state WHERE workspace_id=$1`, ws)
	fx.Cleanup(t, `DELETE FROM labrastro_issue_tip WHERE workspace_id=$1`, ws)
	fx.Cleanup(t, `DELETE FROM labrastro_known_topic WHERE workspace_id=$1`, ws)
	fx.Cleanup(t, `DELETE FROM task_token WHERE workspace_id=$1`, ws)
	fx.Cleanup(t, `DELETE FROM agent_task_queue WHERE issue_id=$1`, f.issue)
	return f
}

func (f *yskFixture) request(method string, body any, params ...string) *http.Request {
	r := newRequest(method, "/api/tips", body)
	r.Header.Set("X-Workspace-ID", f.WorkspaceID)
	return testutil.WithURLParams(r, params...)
}

func (f *yskFixture) tip(t *testing.T, line string, over ...testutil.Cols) string {
	t.Helper()
	cols := testutil.Cols{
		"workspace_id": f.WorkspaceID, "issue_id": f.issue, "task_id": f.task, "agent_id": f.agent, "anchor_comment_id": f.comment,
		"tag": "you_should_know", "line": line, "title": "Title", "explanation": "Explanation",
	}
	for _, overrides := range over {
		for k, v := range overrides {
			cols[k] = v
		}
	}
	return f.Insert(t, "labrastro_issue_tip", cols)
}

func (f *yskFixture) list(t *testing.T, active, all bool, user string) []LabrastroTipResponse {
	t.Helper()
	r := f.request("GET", nil, "id", f.issue)
	r.Header.Set("X-User-ID", user)
	if all {
		r.URL.RawQuery = "status=all"
	}
	h := f.h.LabrastroListIssueTips
	if active {
		h = f.h.LabrastroListActiveTips
	}
	var result struct {
		Tips []LabrastroTipResponse `json:"tips"`
	}
	testutil.Call(t, h, r).Want(200).JSON(&result)
	return result.Tips
}

func yskInput(line string) labrastroYSKInputTip {
	return labrastroYSKInputTip{Tag: "you_should_know", Line: line, Title: "提示", Explanation: "这是一条给人看的解释。"}
}

func (f *yskFixture) report(t *testing.T, body any) {
	t.Helper()
	testutil.Call(t, f.h.LabrastroReportTaskTips, f.request("POST", body, "taskId", f.task)).Want(204)
}

func TestLabrastroYSKClaimGatesAndIsolation(t *testing.T) {
	for _, tc := range []struct {
		name, settings, provider, capability string
		enabled                              bool
	}{
		{"missing", `{}`, "claude", protocol.DaemonCapabilityYouShouldKnowV1, false},
		{"off", `{"you_should_know_enabled":false}`, "claude", protocol.DaemonCapabilityYouShouldKnowV1, false},
		{"wrong setting type", `{"you_should_know_enabled":"true"}`, "claude", protocol.DaemonCapabilityYouShouldKnowV1, false},
		{"other provider", `{"you_should_know_enabled":true}`, "codex", protocol.DaemonCapabilityYouShouldKnowV1, false},
		{"old daemon", `{"you_should_know_enabled":true}`, "claude", "", false},
		{"substring", `{"you_should_know_enabled":true}`, "claude", "x-you-should-know-v1", false},
		{"enabled", `{"you_should_know_enabled":true}`, "claude", protocol.DaemonCapabilityYouShouldKnowV1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newYSKFixture(t)
			f.Exec(t, `UPDATE workspace SET settings=$2 WHERE id=$1`, f.WorkspaceID, tc.settings)
			task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(f.task))
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := f.h.Queries.GetAgentRuntime(context.Background(), parseUUID(f.runtime))
			if err != nil {
				t.Fatal(err)
			}
			runtime.Provider = tc.provider
			r := f.request("POST", nil)
			r.Header.Set("X-Client-Capabilities", tc.capability)
			resp := taskToResponse(task, f.WorkspaceID)
			resp.YouShouldKnow = f.h.labrastroYSKClaimContext(r, task, runtime, []byte(tc.settings), resp.IssueIdentifier)
			encoded, _ := json.Marshal(resp)
			if (resp.YouShouldKnow != nil) != tc.enabled || strings.Contains(string(encoded), `"you_should_know":`) != tc.enabled {
				t.Fatalf("claim gate enabled=%v response=%s", tc.enabled, encoded)
			}
			ordinary, _ := json.Marshal(taskToResponse(task, f.WorkspaceID))
			if strings.Contains(string(ordinary), `"you_should_know":`) {
				t.Fatal("claim context leaked through ordinary task projection")
			}
		})
	}
}

func TestLabrastroYSKSingleAndBatchClaims(t *testing.T) {
	for _, tc := range []struct {
		batch  bool
		source string
	}{{false, "direct_human"}, {true, "direct_human"}, {false, "owner_fallback"}, {true, "owner_fallback"}} {
		t.Run(fmt.Sprintf("batch=%v/%s", tc.batch, tc.source), func(t *testing.T) {
			batch := tc.batch
			f := newYSKFixture(t)
			accountable := f.User(t, "represented member", uuid.NewString()+"@example.com")
			f.Member(t, f.WorkspaceID, accountable, "member")
			var originator any = accountable
			if tc.source == "owner_fallback" {
				originator = nil
			}
			f.Exec(t, `UPDATE agent_task_queue SET status='queued', started_at=NULL, dispatched_at=NULL,
				accountable_user_id=$2, originator_user_id=$3, originator_source=$4 WHERE id=$1`, f.task, accountable, originator, tc.source)
			f.Exec(t, `UPDATE agent SET visibility='workspace', permission_mode='public_to' WHERE id=$1`, f.agent)
			f.Exec(t, `UPDATE agent_runtime SET visibility='public' WHERE id=$1`, f.runtime)
			f.InsertNoID(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": "workspace", "target_id": f.WorkspaceID}, "agent_id=$1", f.agent)
			f.Exec(t, `INSERT INTO labrastro_known_topic(workspace_id,user_id,topic,updated_at)
				SELECT $1,$2,'topic-'||n,now()-n*interval '1 second' FROM generate_series(1,55) n`, f.WorkspaceID, accountable)
			f.Exec(t, `INSERT INTO labrastro_known_topic(workspace_id,user_id,topic) VALUES ($1,$2,'wrong person')`, f.WorkspaceID, testUserID)
			valid := f.tip(t, "a visible old tip")
			f.tip(t, "invalid old tip", testutil.Cols{"status": "overturned"})
			f.Comment(t, f.issue, strings.Repeat("中", 501))
			f.Comment(t, f.issue, "ignored agent language", testutil.Cols{"author_type": "agent", "author_id": f.agent})
			f.Comment(t, f.issue, "deleted human", testutil.Cols{"deleted_at": testutil.Raw("now()")})
			r := f.request("POST", nil, "runtimeId", f.runtime)
			var result AgentTaskResponse
			if batch {
				r = f.request("POST", map[string]any{"daemon_id": "ysk-daemon", "runtime_ids": []string{f.runtime}, "max_tasks": 1})
			}
			r.Header.Set("X-Client-Capabilities", protocol.DaemonCapabilityYouShouldKnowV1)
			if batch {
				var out struct {
					Tasks []AgentTaskResponse `json:"tasks"`
				}
				testutil.Call(t, f.h.ClaimTasksByRuntime, r).Want(200).JSON(&out)
				if len(out.Tasks) != 1 {
					t.Fatalf("claimed %d tasks", len(out.Tasks))
				}
				result = out.Tasks[0]
			} else {
				var out struct {
					Task AgentTaskResponse `json:"task"`
				}
				testutil.Call(t, f.h.ClaimTaskByRuntime, r).Want(200).JSON(&out)
				result = out.Task
			}
			c := result.YouShouldKnow
			if c == nil {
				t.Fatal("claim omitted context")
			}
			if c.Version != 1 || c.IssueIdentifier != "YSK-1" || c.AnchorCommentID == nil || *c.AnchorCommentID != f.comment ||
				c.LightTipCount != 3 || c.CheckEverySteps != 6 || c.Limits != (protocol.YouShouldKnowLimits{Line: 40, Title: 12, Explanation: 200}) {
				t.Fatalf("contract B: %+v", c)
			}
			if c.LatestHumanComment != strings.Repeat("中", 500) || len(c.ExistingTips) != 1 || c.ExistingTips[0].ID != valid ||
				len(c.KnownTopics) != 50 || c.KnownTopics[0] != "topic-1" || c.KnownTopics[49] != "topic-50" {
				t.Fatalf("wrong context data: %+v", c)
			}
		})
	}
}

func TestLabrastroYSKReportsValidateDeduplicateAndOverturn(t *testing.T) {
	f := newYSKFixture(t)
	oldTask := f.Task(t, f.agent, testutil.Cols{"issue_id": f.issue, "runtime_id": f.runtime, "status": "completed"})
	old := f.tip(t, "obsolete", testutil.Cols{"task_id": oldTask})
	foreign := newYSKFixture(t)
	foreignTip := foreign.tip(t, "another workspace")
	otherIssue := f.Issue(t, "other issue")
	otherTip := f.tip(t, "another issue", testutil.Cols{"issue_id": otherIssue, "task_id": oldTask})
	var captured []events.Event
	f.h.Bus.SubscribeAll(func(e events.Event) { captured = append(captured, e) })
	report := map[string]any{
		"ysk": 1, "kind": "light", "step": 1,
		"tips": []labrastroYSKInputTip{yskInput("有效提示"), yskInput(strings.Repeat("中", 40)), yskInput(strings.Repeat("中", 41)),
			{Tag: "unknown", Line: "bad", Title: "bad", Explanation: "bad"}, {Tag: "heads_up", Line: "wrong batch", Title: "bad", Explanation: "bad"},
			{Tag: "you_should_know", Line: "bad title", Title: strings.Repeat("中", 13), Explanation: "explanation"},
			{Tag: "you_should_know", Line: "bad explanation", Title: "title", Explanation: strings.Repeat("中", 201)}},
		"overturned": []map[string]string{{"tip_id": old, "reason": "changed decision"}, {"tip_id": foreignTip, "reason": "wrong workspace"}, {"tip_id": otherTip, "reason": "wrong issue"}, {"tip_id": "bad UUID", "reason": "invalid"}},
	}
	f.report(t, report)
	f.report(t, report)
	if len(captured) != 3 || captured[0].Type != protocol.EventIssueTipCreated || captured[2].Type != protocol.EventIssueTipUpdated {
		t.Fatalf("expected two creates and one overturn, got %+v", captured)
	}
	stored, err := f.h.Queries.LabrastroYSKGetTip(context.Background(), db.LabrastroYSKGetTipParams{WorkspaceID: parseUUID(f.WorkspaceID), ID: parseUUID(old)})
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "overturned" || uuidToString(stored.OverturnedByTaskID) != f.task || uuidToString(stored.OverturnedByCommentID) != f.comment || stored.OverturnedReason.String != "changed decision" {
		t.Fatalf("overturn provenance: %+v", stored)
	}
	if len(f.list(t, false, false, testUserID)) != 2 || len(foreign.list(t, false, false, testUserID)) != 1 {
		t.Fatal("invalid tips were written or foreign tips changed")
	}
	f.report(t, labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput("third"), yskInput("fourth")}})
	for i := 0; i < 2; i++ {
		f.report(t, labrastroYSKReport{Version: 1, Kind: "heads_up", Step: 6, Tips: []labrastroYSKInputTip{{Tag: "heads_up", Line: fmt.Sprintf("heads %d", i), Title: "提醒", Explanation: "说明"}}})
	}
	if count := f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE task_id=$1`, f.task); count != 4 {
		t.Fatalf("per-run cap: %d", count)
	}
	for _, tip := range f.list(t, false, false, testUserID) {
		if tip.AnchorCommentID == nil || *tip.AnchorCommentID != f.comment {
			t.Fatalf("wrong anchor: %+v", tip)
		}
	}
	for _, e := range captured {
		raw, _ := json.Marshal(e.Payload)
		if strings.Contains(string(raw), "user_state") || e.WorkspaceID != f.WorkspaceID {
			t.Fatalf("bad shared event: %s", raw)
		}
	}
}

func TestLabrastroYSKDescriptionAnchorAndRejectedReports(t *testing.T) {
	f := newYSKFixture(t)
	f.Exec(t, `UPDATE agent_task_queue SET trigger_comment_id=NULL WHERE id=$1`, f.task)
	valid := labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput("description tip")}}
	f.report(t, valid)
	tips := f.list(t, false, false, testUserID)
	if len(tips) != 1 || tips[0].AnchorCommentID != nil {
		t.Fatalf("description anchor: %+v", tips)
	}
	for _, change := range []string{"settings", "cancelled", "provider"} {
		t.Run(change, func(t *testing.T) {
			f := newYSKFixture(t)
			switch change {
			case "settings":
				f.Exec(t, `UPDATE workspace SET settings='{}' WHERE id=$1`, f.WorkspaceID)
			case "cancelled":
				f.Exec(t, `UPDATE agent_task_queue SET status='cancelled' WHERE id=$1`, f.task)
			case "provider":
				f.Exec(t, `UPDATE agent_runtime SET provider='codex' WHERE id=$1`, f.runtime)
			}
			f.report(t, valid)
			if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
				t.Fatal("ineligible report accepted")
			}
		})
	}
	for _, raw := range []string{`{`, `{"ysk":2,"kind":"light","step":1}`, `{"ysk":1,"kind":"light","step":1} {}`, strings.Repeat("x", 70<<10)} {
		r := httptest.NewRequest("POST", "/api/tips", strings.NewReader(raw))
		r.Header.Set("X-User-ID", testUserID)
		r = testutil.WithURLParams(r, "taskId", f.task)
		testutil.Call(t, f.h.LabrastroReportTaskTips, r).Want(204)
	}
}

func TestLabrastroYSKCommentChangesInvalidateAndRejectLateReports(t *testing.T) {
	for _, action := range []string{"legacy edit", "revision edit", "leaf delete", "tombstone"} {
		t.Run(action, func(t *testing.T) {
			f := newYSKFixture(t)
			id := f.tip(t, "prior tip")
			var updated []events.Event
			f.h.Bus.Subscribe(protocol.EventIssueTipUpdated, func(e events.Event) { updated = append(updated, e) })
			if action == "legacy edit" || action == "revision edit" {
				body := map[string]any{"content": "changed source"}
				if action == "revision edit" {
					body["expected_revision"] = 1
				}
				testutil.Call(t, f.h.UpdateComment, f.request("PUT", body, "commentId", f.comment)).Want(200)
			} else {
				if action == "tombstone" {
					f.Comment(t, f.issue, "reply", testutil.Cols{"parent_id": f.comment})
				}
				testutil.Call(t, f.h.DeleteComment, f.request("DELETE", nil, "commentId", f.comment)).Want(204)
			}
			if len(updated) != 1 {
				t.Fatalf("got %d invalidation events", len(updated))
			}
			var state string
			f.QueryRow(t, `SELECT status FROM labrastro_issue_tip WHERE id=$1`, id).Scan(&state)
			if state != "source_changed" || len(f.list(t, false, false, testUserID)) != 0 || len(f.list(t, false, true, testUserID)) != 1 {
				t.Fatalf("source remained visible: %s", state)
			}
			f.report(t, labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput("late report")}})
			if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE task_id=$1`, f.task) != 1 {
				t.Fatal("late report revived edited input")
			}
		})
	}
}

func TestLabrastroYSKStatesKnownTopicBoundAndMemberIsolation(t *testing.T) {
	f := newYSKFixture(t)
	other := f.User(t, "second viewer", uuid.NewString()+"@example.com")
	f.Member(t, f.WorkspaceID, other, "member")
	ids := make([]string, 60)
	for i := range ids {
		ids[i] = f.tip(t, fmt.Sprintf("topic %02d", i))
	}
	var mu sync.Mutex
	var captured []events.Event
	f.h.Bus.Subscribe(protocol.EventIssueTipStateChanged, func(e events.Event) { mu.Lock(); defer mu.Unlock(); captured = append(captured, e) })
	var wg sync.WaitGroup
	statuses := make(chan int, len(ids))
	for _, id := range ids {
		r := f.request("POST", map[string]any{"state": "known", "feedback": "helpful"}, "tipId", id)
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			f.h.LabrastroSetTipState(w, r)
			statuses <- w.Code
		}()
	}
	wg.Wait()
	close(statuses)
	for code := range statuses {
		if code != 200 {
			t.Fatalf("concurrent state write: %d", code)
		}
	}
	if n := f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, testUserID); n != 50 {
		t.Fatalf("known topics count=%d", n)
	}
	if len(captured) != 60 {
		t.Fatalf("state events=%d", len(captured))
	}
	// Re-learning a topic refreshes it rather than using another slot.
	testutil.Call(t, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "known"}, "tipId", ids[0])).Want(200)
	if f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, testUserID) != 50 ||
		f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1 AND user_id=$2 AND topic='topic 00'`, f.WorkspaceID, testUserID) != 1 {
		t.Fatal("known-topic refresh did not retain the latest 50 unique topics")
	}
	for _, tip := range f.list(t, false, false, other) {
		if tip.UserState != nil {
			t.Fatal("personal state leaked to another member")
		}
	}
	r := f.request("POST", map[string]any{"state": "dismissed", "feedback": "not_understood"}, "tipId", ids[0])
	r.Header.Set("X-User-ID", other)
	testutil.Call(t, f.h.LabrastroSetTipState, r).Want(200)
	if f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, other) != 0 {
		t.Fatal("dismissal marked a topic known")
	}
	for _, tip := range f.list(t, true, false, testUserID) {
		if tip.UserState == nil || tip.UserState.State != "known" {
			t.Fatalf("state did not persist: %+v", tip)
		}
	}
	f.Exec(t, `UPDATE agent_task_queue SET status='completed' WHERE id=$1`, f.task)
	if len(f.list(t, true, false, testUserID)) != 0 {
		t.Fatal("inactive issue leaked into active tips")
	}
	f.Exec(t, `UPDATE agent_task_queue SET status='running' WHERE id=$1`, f.task)
	f.Task(t, f.agent, testutil.Cols{"issue_id": f.issue, "runtime_id": f.runtime, "status": "running"})
	if len(f.list(t, true, false, testUserID)) != 60 {
		t.Fatal("active list lost or duplicated tips for an issue with multiple running tasks")
	}
}

func TestLabrastroYSKReportRejectsSelfOverturnAndForeignAnchor(t *testing.T) {
	f := newYSKFixture(t)
	id := f.tip(t, "same run must not overturn itself")
	f.report(t, labrastroYSKReport{Version: 1, Kind: "light", Step: 1,
		Overturned: []labrastroYSKInputOverturn{{TipID: id, Reason: "still the same run"}}})
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE id=$1 AND status='valid'`, id) != 1 {
		t.Fatal("report overturned its own run's tip")
	}
	otherIssue := f.Issue(t, "other issue")
	comment := f.Comment(t, otherIssue, "belongs elsewhere")
	// Keep the timestamp eligible so only the issue ownership check rejects it.
	f.Exec(t, `UPDATE comment SET updated_at=(SELECT dispatched_at FROM agent_task_queue WHERE id=$2)-interval '1 second' WHERE id=$1`, comment, f.task)
	f.Exec(t, `UPDATE agent_task_queue SET trigger_comment_id=$2 WHERE id=$1`, f.task, comment)
	f.report(t, labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput("wrong comment anchor")}})
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE task_id=$1`, f.task) != 1 {
		t.Fatal("report accepted a comment from another issue")
	}
}

type yskFailInvalidationStarter struct{}
type yskFailInvalidationTx struct{ pgx.Tx }

func (yskFailInvalidationStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := testPool.Begin(ctx)
	return yskFailInvalidationTx{tx}, err
}

func (tx yskFailInvalidationTx) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if strings.Contains(query, "-- name: LabrastroYSKInvalidateComment") {
		return nil, errors.New("injected tip invalidation failure")
	}
	return tx.Tx.Query(ctx, query, args...)
}

func TestLabrastroYSKInvalidationIsAtomicWithCommentMutation(t *testing.T) {
	for _, deleting := range []bool{false, true} {
		t.Run(fmt.Sprint("delete=", deleting), func(t *testing.T) {
			f := newYSKFixture(t)
			id := f.tip(t, "valid before attempted edit")
			f.h.TxStarter = yskFailInvalidationStarter{}
			var eventsSent int
			f.h.Bus.Subscribe(protocol.EventIssueTipUpdated, func(events.Event) { eventsSent++ })
			if deleting {
				testutil.Call(t, f.h.DeleteComment, f.request("DELETE", nil, "commentId", f.comment)).Want(500)
			} else {
				testutil.Call(t, f.h.UpdateComment, f.request("PUT", map[string]any{"content": "new source", "expected_revision": 1}, "commentId", f.comment)).Want(500)
			}
			var content, status string
			f.QueryRow(t, `SELECT content FROM comment WHERE id=$1 AND deleted_at IS NULL`, f.comment).Scan(&content)
			f.QueryRow(t, `SELECT status FROM labrastro_issue_tip WHERE id=$1`, id).Scan(&status)
			if content != "Human context" || status != "valid" || eventsSent != 0 {
				t.Fatalf("partial mutation: content=%q status=%q events=%d", content, status, eventsSent)
			}
		})
	}
}

func TestLabrastroYSKConcurrentReportsRespectRunQuota(t *testing.T) {
	f := newYSKFixture(t)
	var wg sync.WaitGroup
	statuses := make(chan int, 10)
	for i := 0; i < 10; i++ {
		r := f.request("POST", labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput(fmt.Sprintf("tip %d", i))}}, "taskId", f.task)
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			f.h.LabrastroReportTaskTips(w, r)
			statuses <- w.Code
		}()
	}
	wg.Wait()
	close(statuses)
	for code := range statuses {
		if code != 204 {
			t.Fatalf("report status=%d", code)
		}
	}
	if count := f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE task_id=$1`, f.task); count != 3 {
		t.Fatalf("concurrent reports exceeded cap: %d", count)
	}
	// Even a still-running task cannot publish from a source changed after dispatch.
	f.Exec(t, `DELETE FROM labrastro_issue_tip WHERE task_id=$1`, f.task)
	f.Exec(t, `UPDATE comment SET updated_at=now()+interval '1 second' WHERE id=$1`, f.comment)
	f.report(t, labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput("stale context")}})
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE task_id=$1`, f.task) != 0 {
		t.Fatal("stale context accepted from an active task")
	}
}

func TestLabrastroYSKMemberRemovalClearsPersonalData(t *testing.T) {
	f := newYSKFixture(t)
	user := f.User(t, "departing viewer", uuid.NewString()+"@example.com")
	member := f.Member(t, f.WorkspaceID, user, "member")
	id := f.tip(t, "viewer knows this")
	r := f.request("POST", map[string]any{"state": "known"}, "tipId", id)
	r.Header.Set("X-User-ID", user)
	testutil.Call(t, f.h.LabrastroSetTipState, r).Want(200)
	testutil.Call(t, f.h.DeleteMember, f.request("DELETE", nil, "id", f.WorkspaceID, "memberId", member)).Want(204)
	if f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, user) != 0 ||
		f.Count(t, `SELECT count(*) FROM labrastro_issue_tip_state WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, user) != 0 {
		t.Fatal("departed member left personal YSK data")
	}
}

func TestLabrastroYSKStateWriteLosesToMemberRevocation(t *testing.T) {
	f := newYSKFixture(t)
	user := f.User(t, "revoked viewer", uuid.NewString()+"@example.com")
	f.Member(t, f.WorkspaceID, user, "member")
	id := f.tip(t, "do not recreate personal data")
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := f.h.Queries.WithTx(tx)
	if err = q.LockSubscriberWrites(ctx, db.LockSubscriberWritesParams{WorkspaceID: parseUUID(f.WorkspaceID), UserID: parseUUID(user)}); err != nil {
		t.Fatal(err)
	}
	// Pause revocation after cleanup but BEFORE deleting the member. A member
	// row lock alone cannot protect this interval against recreated YSK data.
	if err = q.LabrastroYSKDeleteMember(ctx, db.LabrastroYSKDeleteMemberParams{WorkspaceID: parseUUID(f.WorkspaceID), UserID: parseUUID(user)}); err != nil {
		t.Fatal(err)
	}
	r := f.request("POST", map[string]any{"state": "known"}, "tipId", id)
	r.Header.Set("X-User-ID", user)
	yskAssertBlockedRequest(t, tx, f.h.LabrastroSetTipState, r, func() {
		if _, err = tx.Exec(ctx, `DELETE FROM member WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, user); err != nil {
			t.Fatal(err)
		}
	}, 404)
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip_state WHERE workspace_id=$1`, f.WorkspaceID) != 0 ||
		f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("personal data resurrected after revocation")
	}
}

func TestLabrastroYSKAPIGuardsAndNoAgentProjection(t *testing.T) {
	f := newYSKFixture(t)
	id := f.tip(t, "UNIQUE YSK HUMAN ONLY CONTENT")
	foreign := newYSKFixture(t)
	foreignID := foreign.tip(t, "other tenant")
	for _, source := range []string{"task_token", "cloud_pat"} {
		for _, h := range []http.HandlerFunc{f.h.LabrastroListIssueTips, f.h.LabrastroListActiveTips, f.h.LabrastroSetTipState} {
			r := f.request("GET", nil, "id", f.issue, "tipId", id)
			r.Header.Set("X-Actor-Source", source)
			testutil.Call(t, h, r).Want(403)
		}
	}
	testutil.Call(t, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "known"}, "tipId", foreignID)).Want(404)
	testutil.Call(t, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "unknown"}, "tipId", id)).Want(400)
	testutil.Call(t, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "known", "feedback": "bad"}, "tipId", id)).Want(400)
	outsider := f.User(t, "outsider", uuid.NewString()+"@example.com")
	r := f.request("GET", nil)
	r.Header.Set("X-User-ID", outsider)
	testutil.Call(t, f.h.LabrastroListActiveTips, r).Want(404)
	for _, h := range []http.HandlerFunc{f.h.GetIssue, f.h.ListComments, f.h.ListTasksByIssue} {
		out := testutil.Call(t, h, f.request("GET", nil, "id", f.issue)).Want(200)
		if strings.Contains(out.Body.String(), "UNIQUE YSK") || strings.Contains(out.Body.String(), `"you_should_know":`) {
			t.Fatalf("agent-readable surface leaked tip: %s", out.Body.String())
		}
	}
	r = f.request("POST", labrastroYSKReport{Version: 1, Kind: "light", Step: 1}, "taskId", f.task)
	r = r.WithContext(middleware.WithDaemonContext(r.Context(), f.WorkspaceID, "wrong-daemon"))
	testutil.Call(t, f.h.LabrastroReportTaskTips, r).Want(404)
}

func TestLabrastroYSKPreferencesAndCleanup(t *testing.T) {
	f := newYSKFixture(t)
	id := f.tip(t, "remember me")
	member, err := f.h.Queries.GetMemberByUserAndWorkspace(context.Background(), db.GetMemberByUserAndWorkspaceParams{WorkspaceID: parseUUID(f.WorkspaceID), UserID: parseUUID(testUserID)})
	if err != nil {
		t.Fatal(err)
	}
	r := f.request("GET", nil)
	r = r.WithContext(middleware.SetMemberContext(r.Context(), f.WorkspaceID, member))
	var prefs struct {
		Preferences map[string]string `json:"preferences"`
	}
	testutil.Call(t, f.h.GetNotificationPreferences, r).Want(200).JSON(&prefs)
	if prefs.Preferences["you_should_know"] != "all" {
		t.Fatalf("default preference=%v", prefs.Preferences)
	}
	r = f.request("PATCH", map[string]any{"preferences": map[string]string{"you_should_know": "muted"}})
	r = r.WithContext(middleware.SetMemberContext(r.Context(), f.WorkspaceID, member))
	testutil.Call(t, f.h.PatchNotificationPreferences, r).Want(200).JSON(&prefs)
	if prefs.Preferences["you_should_know"] != "muted" {
		t.Fatal("muted preference not saved")
	}
	testutil.Call(t, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "known"}, "tipId", id)).Want(200)
	testutil.Call(t, f.h.DeleteIssue, f.request("DELETE", nil, "id", f.issue)).Want(204)
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE workspace_id=$1`, f.WorkspaceID) != 0 || f.Count(t, `SELECT count(*) FROM labrastro_issue_tip_state WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("issue delete orphaned tips/states")
	}
	testutil.Call(t, f.h.DeleteWorkspace, f.request("DELETE", nil, "id", f.WorkspaceID)).Want(204)
	if f.Count(t, `SELECT count(*) FROM labrastro_known_topic WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("workspace delete orphaned topics")
	}
}
