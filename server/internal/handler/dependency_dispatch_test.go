package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func dispatchFixture(t *testing.T) (*Handler, *testutil.Fixture, string, string, string, string, string) {
	t.Helper()
	h, fx := dependencyFixture(t)
	runtime := fx.Runtime(t, "fake dependency runtime")
	agent := fx.Agent(t, "fake dependency agent", runtime)
	a := dependencyIssue(t, fx, "A")
	c := dependencyIssue(t, fx, "C")
	b := dependencyIssue(t, fx, "B", testutil.Cols{"status": "backlog"})
	replaceDependencies(t, h, fx, b, []string{a, c}, "task", http.StatusOK)
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM agent_task_queue WHERE agent_id=$1", agent) })
	return h, fx, a, b, c, agent, runtime
}

func TestDependencyRerunPreservesOtherThreadAndRejectedReplacement(t *testing.T) {
	h, fx, a, issueID, c, agentID, runtimeID := dispatchFixture(t)
	ctx := context.Background()
	fx.Exec(t, `UPDATE issue SET status='todo',assignee_type='agent',assignee_id=$2 WHERE id=$1`, issueID, agentID)
	first := fx.Comment(t, issueID, "first thread")
	second := fx.Comment(t, issueID, "second thread")
	oldRun := fx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID, "trigger_comment_id": first, "status": "completed"})
	queuedFirst := fx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID, "trigger_comment_id": first, "status": "queued"})
	queuedSecond := fx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID, "trigger_comment_id": second, "status": "queued"})
	rerun := func() (*db.AgentTaskQueue, error) {
		return h.TaskService.RerunIssue(ctx, parseUUID(issueID), parseUUID(oldRun), parseUUID(first), parseUUID(fx.UserID), func(db.Agent) bool { return true })
	}
	if _, err := rerun(); err == nil {
		t.Fatal("unsatisfied dependencies allowed a rerun")
	} else {
		var blocked *service.DependencyError
		if !errors.As(err, &blocked) || blocked.Code != "dependency_unsatisfied" {
			t.Fatalf("wrong refusal: %v", err)
		}
	}
	assertStatus := func(id, want string) {
		t.Helper()
		task, err := h.Queries.GetAgentTask(ctx, parseUUID(id))
		if err != nil || task.Status != want {
			t.Fatalf("task %s status=%s err=%v, want %s", id, task.Status, err, want)
		}
	}
	assertStatus(queuedFirst, "queued")
	assertStatus(queuedSecond, "queued")
	fx.Exec(t, `UPDATE issue SET status='done' WHERE id IN ($1,$2)`, a, c)
	task, err := rerun()
	if err != nil || task == nil || task.CommentThreadID != parseUUID(first) {
		t.Fatalf("admitted rerun lost its thread: task=%+v err=%v", task, err)
	}
	assertStatus(queuedFirst, "cancelled")
	assertStatus(queuedSecond, "queued")
}

func TestDependencyDispatchEntrypointMatrix(t *testing.T) {
	h, fx, a, b, c, agent, _ := dispatchFixture(t)
	squad := fx.Squad(t, "fake dependency squad", agent)
	row, err := h.Queries.GetIssue(context.Background(), parseUUID(b))
	if err != nil {
		t.Fatal(err)
	}
	row.AssigneeType = pgtype.Text{String: "agent", Valid: true}
	row.AssigneeID = parseUUID(agent)
	// Attribution remains human in every case; it grants no override authority.
	comment := fx.Comment(t, b, "ordinary input")
	for _, entry := range []struct {
		name string
		call func() (db.AgentTaskQueue, error)
	}{
		{"assign", func() (db.AgentTaskQueue, error) { return h.TaskService.EnqueueTaskForIssue(context.Background(), row) }},
		{"human_attributed", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueTaskForIssueByActor(context.Background(), row, parseUUID(fx.UserID))
		}},
		{"handoff", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueTaskForIssueWithHandoff(context.Background(), row, "handoff", parseUUID(fx.UserID))
		}},
		{"mention", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueTaskForMention(context.Background(), row, parseUUID(agent), parseUUID(comment))
		}},
		{"reply", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueTaskForThreadParent(context.Background(), row, parseUUID(agent), parseUUID(comment))
		}},
		{"squad", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueTaskForSquadLeader(context.Background(), row, parseUUID(agent), parseUUID(squad), parseUUID(comment))
		}},
		{"squad_actor", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueTaskForSquadLeaderByActor(context.Background(), row, parseUUID(agent), parseUUID(squad), parseUUID(fx.UserID))
		}},
		{"squad_handoff", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueTaskForSquadLeaderWithHandoff(context.Background(), row, parseUUID(agent), parseUUID(squad), "handoff", parseUUID(fx.UserID))
		}},
		{"channel_deferred", func() (db.AgentTaskQueue, error) {
			return h.TaskService.EnqueueDeferredChannelIssueTask(context.Background(), row, time.Now().Add(time.Minute))
		}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			task, err := entry.call()
			var dep *service.DependencyError
			if !errors.As(err, &dep) || dep.Code != "dependency_unsatisfied" || task.ID.Valid {
				t.Fatalf("entry produced execution: task=%v err=%v", task.ID, err)
			}
			if dep.View == nil || len(dep.View.Unsatisfied) != 2 {
				t.Fatalf("missing complete blockers: %+v", dep)
			}
		})
	}
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b).Scan(&count)
	if count != 0 {
		t.Fatal("rejected enqueue wrote tasks")
	}
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id=$1", a)
	if _, err = h.TaskService.EnqueueTaskForIssue(context.Background(), row); err == nil {
		t.Fatal("one completed predecessor was enough")
	}
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id=$1", c)
	if _, err = h.TaskService.EnqueueTaskForIssue(context.Background(), row); err != nil {
		t.Fatal(err)
	}
}

func TestDependencyDispatchWriteRollbackAndOldAPI(t *testing.T) {
	h, fx, a, b, c, agent, _ := dispatchFixture(t)
	child := dependencyIssue(t, fx, "child", testutil.Cols{"parent_issue_id": b, "status": "backlog"})
	for _, kind := range []string{"task", "pat", "cloud_pat", "unknown", ""} {
		for _, target := range []string{b, child} {
			var failure map[string]any
			testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, target, map[string]any{"assignee_type": "agent", "assignee_id": agent, "suppress_run": true, "title": "must not persist"}, kind)).Want(http.StatusConflict).JSON(&failure)
			if failure["reason_code"] != "dependency_unsatisfied" {
				t.Fatal(failure)
			}
		}
	}
	before := 0
	fx.QueryRow(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", fx.WorkspaceID).Scan(&before)
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", map[string]any{"title": "atomic create", "blocked_by": []string{a, c}, "assignee_type": "agent", "assignee_id": agent}, "task")).Want(http.StatusConflict)
	testutil.Call(t, h.CreateIssue, dependencyRequest(fx, http.MethodPost, "", map[string]any{"title": "inherited create", "parent_issue_id": b, "assignee_type": "agent", "assignee_id": agent}, "task")).Want(http.StatusConflict)
	after := 0
	fx.QueryRow(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", fx.WorkspaceID).Scan(&after)
	if before != after {
		t.Fatal("rejected create left an issue")
	}
	// Human preassignment is allowed; activation and done semantics remain separate.
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"assignee_type": "agent", "assignee_id": agent, "suppress_run": true}, "jwt")).Want(http.StatusOK)
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"status": "todo", "title": "must roll back"}, "task")).Want(http.StatusConflict)
	row, err := h.Queries.GetIssue(context.Background(), parseUUID(b))
	if err != nil || row.Title != "B" || row.Status != "backlog" {
		t.Fatalf("partial update: %+v %v", row, err)
	}
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"status": "done"}, "task")).Want(http.StatusOK)
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"status": "in_progress"}, "task")).Want(http.StatusOK)
}

func dependencyConfirmation(t *testing.T, h *Handler, fx *testutil.Fixture, id string, mutation map[string]any, creating bool) service.DependencyOverride {
	t.Helper()
	body := map[string]any{"issue_ids": []string{id}, "mutation": mutation, "is_create": creating}
	if creating {
		delete(body, "issue_ids")
	}
	var preview IssueTriggerPreviewResponse
	testutil.Call(t, h.PreviewIssueTrigger, dependencyRequest(fx, http.MethodPost, "preview-trigger", body, "jwt")).Want(http.StatusOK).JSON(&preview)
	if len(preview.Triggers) != 0 || len(preview.Blocked) != 1 || preview.Blocked[0].Confirmation == nil {
		t.Fatalf("wrong blocked preview: %+v", preview)
	}
	return preview.Blocked[0].Confirmation.DependencyOverride
}

func TestDependencyHumanConfirmationOnceAndRecovery(t *testing.T) {
	h, fx, a, b, _, agent, runtime := dispatchFixture(t)
	mutation := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	override := dependencyConfirmation(t, h, fx, b, mutation, false)
	mutation["dependency_override"] = override
	var first IssueResponse
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusOK).JSON(&first)
	if first.Dispatch == nil || first.Dispatch.TaskID == nil {
		t.Fatalf("missing dispatch result %+v", first)
	}
	var replay IssueResponse
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusOK).JSON(&replay)
	if replay.Dispatch == nil || *replay.Dispatch.TaskID != *first.Dispatch.TaskID {
		t.Fatal("request replay created another execution")
	}
	task, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
	if err != nil || task == nil {
		t.Fatalf("confirmed claim: %v %+v", err, task)
	}
	var admission map[string]any
	if json.Unmarshal(task.DependencyAdmission, &admission) != nil || admission["consumed_at"] == nil {
		t.Fatal("claim did not consume confirmation")
	}
	// A lost dispatch response is the same queue row, even after dependencies change.
	fx.Exec(t, "UPDATE issue SET revision=revision+1,status='in_review' WHERE id=$1", a)
	fx.Exec(t, "UPDATE agent_task_queue SET dispatched_at=now()-interval '2 minutes',prepare_lease_expires_at=now()-interval '1 second' WHERE id=$1", task.ID)
	recovered, err := h.TaskService.ClaimTaskForRuntime(context.Background(), parseUUID(runtime))
	if err != nil || recovered == nil || recovered.ID != task.ID {
		t.Fatalf("same-row recovery failed: %+v %v", recovered, err)
	}
	// A rejected rerun must leave the pending original untouched.
	testutil.Call(t, h.RerunIssue, dependencyRequest(fx, http.MethodPost, b, map[string]any{}, "jwt")).Want(http.StatusConflict)
	current, err := h.Queries.GetAgentTask(context.Background(), task.ID)
	if err != nil || current.Status != "dispatched" {
		t.Fatal("rejected rerun cancelled original")
	}
	fx.Exec(t, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", task.ID)
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusOK).JSON(&replay)
	if *replay.Dispatch.TaskID != *first.Dispatch.TaskID {
		t.Fatal("finished confirmation replay restarted work")
	}
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b).Scan(&count)
	if count != 1 {
		t.Fatalf("wanted exactly one row, got %d", count)
	}
}

func TestDependencyConfirmationStaleAndCredentialForgery(t *testing.T) {
	h, fx, a, b, _, agent, _ := dispatchFixture(t)
	mutation := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	override := dependencyConfirmation(t, h, fx, b, mutation, false)
	mutation["dependency_override"] = override
	for _, kind := range []string{"task", "pat", "cloud_pat", "unknown", ""} {
		r := dependencyRequest(fx, http.MethodPatch, b, mutation, kind)
		r.Header.Set("X-Actor-Source", "human")
		r.Header.Set("X-Human", "true")
		testutil.Call(t, h.UpdateIssueWithDependencies, r).Want(http.StatusForbidden)
	}
	mutation["title"] = "changed after preview"
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusConflict)
	delete(mutation, "title")
	fx.Exec(t, "UPDATE issue SET revision=revision+1 WHERE id=$1", a)
	var failure map[string]any
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusConflict).JSON(&failure)
	if failure["reason_code"] != "dependency_override_stale" {
		t.Fatal(failure)
	}
}

func TestDependencyClaimRecheckSkipsBlockedQueueHead(t *testing.T) {
	h, fx, _, b, _, agent, _ := dispatchFixture(t)
	free := dependencyIssue(t, fx, "ready after blocked head")
	blockedTask := fx.Task(t, agent, testutil.Cols{"issue_id": b, "runtime_id": testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + agent + "')"), "priority": 10})
	readyTask := fx.Task(t, agent, testutil.Cols{"issue_id": free, "runtime_id": testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + agent + "')")})
	task, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
	if err != nil || task == nil || uuidToString(task.ID) != readyTask {
		t.Fatalf("blocked queue head starved ready task: %+v %v", task, err)
	}
	blocked, err := h.Queries.GetAgentTask(context.Background(), parseUUID(blockedTask))
	if err != nil || blocked.Status != "failed" || blocked.FailureReason.String != "dependency_unsatisfied" {
		t.Fatalf("unobservable refusal: %+v %v", blocked, err)
	}
	again, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
	if err != nil || again != nil {
		t.Fatal("claim ran twice")
	}
}

func TestDependencyConfirmationConcurrentReplay(t *testing.T) {
	h, fx, _, b, _, agent, _ := dispatchFixture(t)
	mutation := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	mutation["dependency_override"] = dependencyConfirmation(t, h, fx, b, mutation, false)
	start := make(chan struct{})
	results := make(chan IssueResponse, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			var resp IssueResponse
			testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusOK).JSON(&resp)
			results <- resp
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	taskID := ""
	for resp := range results {
		if resp.Dispatch == nil || resp.Dispatch.TaskID == nil {
			t.Fatal("missing execution receipt")
		}
		if taskID != "" && taskID != *resp.Dispatch.TaskID {
			t.Fatal("concurrent replay made two tasks")
		}
		taskID = *resp.Dispatch.TaskID
	}
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b).Scan(&count)
	if count != 1 {
		t.Fatalf("concurrent replay rows=%d", count)
	}
}

func TestDependencyCompoundCreateConfirmation(t *testing.T) {
	h, fx, a, _, c, agent, _ := dispatchFixture(t)
	mutation := map[string]any{"title": "confirmed new issue", "blocked_by": []string{a, c}, "assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	mutation["dependency_override"] = dependencyConfirmation(t, h, fx, "", mutation, true)
	var first IssueResponse
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", mutation, "jwt")).Want(http.StatusCreated).JSON(&first)
	t.Cleanup(func() {
		fx.Exec(t, "DELETE FROM issue_dependency WHERE issue_id=$1", first.ID)
		fx.Exec(t, "DELETE FROM issue WHERE id=$1", first.ID)
	})
	var replay IssueResponse
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", mutation, "jwt")).Want(http.StatusCreated).JSON(&replay)
	if first.ID != replay.ID {
		t.Fatal("create replay left a second issue")
	}
	task, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
	if err != nil || task == nil || uuidToString(task.IssueID) != first.ID {
		t.Fatalf("new confirmed issue could not claim: %+v %v", task, err)
	}
}

func TestDependencyClaimInvalidatesConfirmation(t *testing.T) {
	for _, reason := range []string{"status", "new_edge", "reparent", "expiry", "membership", "leader"} {
		t.Run(reason, func(t *testing.T) {
			h, fx, a, b, _, agent, _ := dispatchFixture(t)
			mutation := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
			squad := ""
			if reason == "leader" {
				squad = fx.Squad(t, "confirmed squad", agent)
				mutation["assignee_type"] = "squad"
				mutation["assignee_id"] = squad
			}
			mutation["dependency_override"] = dependencyConfirmation(t, h, fx, b, mutation, false)
			var resp IssueResponse
			testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusOK).JSON(&resp)
			taskID := *resp.Dispatch.TaskID
			expected := "dependency_override_stale"
			switch reason {
			case "status":
				fx.Exec(t, "UPDATE issue SET status='in_review',revision=revision+1 WHERE id=$1", a)
			case "new_edge":
				d := dependencyIssue(t, fx, "D")
				fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": d, "type": "blocked_by"})
			case "reparent":
				parent := dependencyIssue(t, fx, "parent")
				testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"parent_issue_id": parent}, "jwt")).Want(http.StatusOK)
			case "expiry":
				fx.Exec(t, "UPDATE agent_task_queue SET dependency_admission=jsonb_set(dependency_admission,'{claim_before}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", taskID)
				expected = "dependency_override_expired"
			case "membership":
				fx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, fx.UserID)
				expected = "dependency_override_not_allowed"
			case "leader":
				other := fx.Agent(t, "changed leader", "")
				fx.Exec(t, "UPDATE squad SET leader_id=$2 WHERE id=$1", squad, other)
			}
			claimed, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
			if err != nil || claimed != nil {
				t.Fatalf("invalid confirmation executed: %+v %v", claimed, err)
			}
			row, err := h.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
			if err != nil || row.Status != "failed" || row.FailureReason.String != expected {
				t.Fatalf("wrong refusal: status=%s reason=%s err=%v", row.Status, row.FailureReason.String, err)
			}
			fx.Exec(t, "UPDATE issue SET status='in_progress' WHERE id=$1", b)
			if got := h.TaskService.HandleFailedTasks(context.Background(), []db.AgentTaskQueue{row}); got != 0 {
				t.Fatal("dependency refusal was retried")
			}
			current, _ := h.Queries.GetIssue(context.Background(), parseUUID(b))
			if current.Status != "in_progress" {
				t.Fatal("dependency refusal changed issue status")
			}
		})
	}
}

func TestDependencyCommentsSavedAndDispatchReported(t *testing.T) {
	h, fx, _, b, _, agent, _ := dispatchFixture(t)
	content := "Please review [@agent](mention://agent/" + agent + ")"
	var resp struct {
		ID       string                  `json:"id"`
		Outcomes []CommentTriggerOutcome `json:"trigger_outcomes"`
	}
	testutil.Call(t, h.CreateComment, dependencyRequest(fx, http.MethodPost, b, map[string]any{"content": content}, "jwt")).Want(http.StatusCreated).JSON(&resp)
	if resp.ID == "" || len(resp.Outcomes) != 1 || resp.Outcomes[0].Status != DispatchBlocked || resp.Outcomes[0].ReasonCode != "dependency_unsatisfied" {
		t.Fatalf("saved and refused results lost: %+v", resp)
	}
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM comment WHERE id=$1", resp.ID) })
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b).Scan(&count)
	if count != 0 {
		t.Fatal("ordinary human comment authorized early execution")
	}
}

func TestDependencyCommentCannotBorrowQueuedConfirmation(t *testing.T) {
	h, fx, _, b, _, agent, _ := dispatchFixture(t)
	mutation := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	mutation["dependency_override"] = dependencyConfirmation(t, h, fx, b, mutation, false)
	var assigned IssueResponse
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusOK).JSON(&assigned)
	id := parseUUID(*assigned.Dispatch.TaskID)
	before, _ := h.Queries.GetAgentTask(context.Background(), id)
	var comment struct {
		ID       string                  `json:"id"`
		Outcomes []CommentTriggerOutcome `json:"trigger_outcomes"`
	}
	testutil.Call(t, h.CreateComment, dependencyRequest(fx, http.MethodPost, b, map[string]any{"content": "[@agent](mention://agent/" + agent + ")"}, "jwt")).Want(http.StatusCreated).JSON(&comment)
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM comment WHERE id=$1", comment.ID) })
	after, _ := h.Queries.GetAgentTask(context.Background(), id)
	if string(before.DependencyAdmission) != string(after.DependencyAdmission) || after.TriggerCommentID.Valid || len(after.CoalescedCommentIds) > 0 {
		t.Fatal("new comment changed the confirmed execution")
	}
	if len(comment.Outcomes) != 1 || comment.Outcomes[0].ReasonCode != "dependency_unsatisfied" {
		t.Fatalf("borrowed confirmation: %+v", comment)
	}
}

func TestDependencyBatchPartialResultsAndPerTargetConfirmation(t *testing.T) {
	h, fx, _, b, _, agent, _ := dispatchFixture(t)
	free := dependencyIssue(t, fx, "free", testutil.Cols{"status": "backlog"})
	updates := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	var partial struct {
		Updated int `json:"updated"`
		Results []struct {
			IssueID  string           `json:"issue_id"`
			Updated  bool             `json:"updated"`
			Reason   string           `json:"reason_code"`
			Dispatch *DispatchOutcome `json:"dispatch"`
		} `json:"results"`
	}
	testutil.Call(t, h.BatchUpdateIssues, dependencyRequest(fx, http.MethodPost, "batch-update", map[string]any{"issue_ids": []string{b, free}, "updates": updates}, "task")).Want(http.StatusOK).JSON(&partial)
	if partial.Updated != 1 || len(partial.Results) != 2 || partial.Results[0].Updated || partial.Results[0].Reason != "dependency_unsatisfied" || partial.Results[1].Dispatch == nil || partial.Results[1].Dispatch.TaskID == nil {
		t.Fatalf("inaccurate batch result: %+v", partial)
	}
	override := dependencyConfirmation(t, h, fx, b, updates, false)
	testutil.Call(t, h.BatchUpdateIssues, dependencyRequest(fx, http.MethodPost, "batch-update", map[string]any{"issue_ids": []string{b}, "updates": updates, "dependency_overrides": map[string]any{b: override}}, "jwt")).Want(http.StatusOK).JSON(&partial)
	if partial.Updated != 1 || partial.Results[0].Dispatch == nil || partial.Results[0].Dispatch.TaskID == nil {
		t.Fatalf("per-target confirmation did not enqueue: %+v", partial)
	}
}

func TestDependencyProviderRetryCannotInheritConfirmation(t *testing.T) {
	h, fx, a, b, c, agent, _ := dispatchFixture(t)
	mutation := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	mutation["dependency_override"] = dependencyConfirmation(t, h, fx, b, mutation, false)
	var resp IssueResponse
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusOK).JSON(&resp)
	task, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
	if err != nil || task == nil {
		t.Fatal(err)
	}
	fx.Exec(t, "UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1", task.ID)
	failed, err := h.TaskService.FailTask(context.Background(), task.ID, "network interrupted", "", "", "", "agent_error.provider_network", false, "", "")
	if err != nil || failed == nil || failed.Status != "failed" {
		t.Fatalf("parent failure did not commit: %+v %v", failed, err)
	}
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", b).Scan(&count)
	if count != 1 {
		t.Fatal("provider retry inherited early-execution permission")
	}
	child, err := h.TaskService.MaybeRetryFailedTask(context.Background(), *failed)
	var dep *service.DependencyError
	if child != nil || !errors.As(err, &dep) || dep.Code != "dependency_unsatisfied" {
		t.Fatalf("sweeper retry bypass: %+v %v", child, err)
	}
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
	child, err = h.TaskService.MaybeRetryFailedTask(context.Background(), *failed)
	if err != nil || child == nil || len(child.DependencyAdmission) != 0 {
		t.Fatalf("ordinary retry copied confirmation: %+v %v", child, err)
	}

}

func TestDependencyMutationAndClaimSerialize(t *testing.T) {
	// Status and structural writers overlap enqueue/claim with an observed lock wait,
	// so the assertion cannot pass merely because goroutines ran serially.
	for _, scenario := range []string{"status/claim", "status/enqueue", "structure/claim", "structure/enqueue"} {
		t.Run(scenario, func(t *testing.T) {
			parts := strings.Split(scenario, "/")
			operation := parts[1]
			h, fx, a, b, c, agent, runtime := dispatchFixture(t)
			fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
			fx.Exec(t, "UPDATE issue SET assignee_type='agent',assignee_id=$2 WHERE id=$1", b, agent)
			row, _ := h.Queries.GetIssue(context.Background(), parseUUID(b))
			var pending string
			if operation == "claim" {
				pending = fx.Task(t, agent, testutil.Cols{"issue_id": b, "runtime_id": runtime})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			tx, err := testPool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if parts[0] == "status" {
				if _, err = tx.Exec(ctx, "UPDATE issue SET status='todo',revision=revision+1 WHERE id=$1", a); err != nil {
					t.Fatal(err)
				}
			} else {
				d := dependencyIssue(t, fx, "concurrent new blocker")
				q := h.Queries.WithTx(tx)
				deps := h.IssueService.Dependencies
				if err := deps.LockWrite(ctx, q, parseUUID(fx.WorkspaceID)); err != nil {
					t.Fatal(err)
				}
				before, err := deps.LoadForWrite(ctx, q, parseUUID(fx.WorkspaceID))
				if err != nil {
					t.Fatal(err)
				}
				refs := []pgtype.UUID{parseUUID(a), parseUUID(c), parseUUID(d)}
				if _, _, err = deps.Apply(ctx, q, before, row, service.DependencyWrite{BlockedBy: &refs, ExpectedVersion: before.Version(b), IncludeView: true}); err != nil {
					t.Fatal(err)
				}
			}
			var ownerPID int
			if err = tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&ownerPID); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				if operation == "claim" {
					task, err := h.TaskService.ClaimTask(ctx, parseUUID(agent))
					if task != nil {
						err = errors.New("blocked claim returned an execution")
					}
					result <- err
				} else {
					_, err := h.TaskService.EnqueueTaskForIssue(ctx, row)
					result <- err
				}
			}()
			waiting := false
			for ctx.Err() == nil {
				if err = testPool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))", ownerPID).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case err := <-result:
					t.Fatalf("operation did not wait for status lock: %v", err)
				case <-time.After(time.Millisecond):
				}
			}
			if !waiting {
				t.Fatal("no overlapping database lock wait observed")
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-result
			if operation == "enqueue" {
				var dep *service.DependencyError
				if !errors.As(err, &dep) || dep.Code != "dependency_unsatisfied" {
					t.Fatalf("enqueue read stale status: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				task, _ := h.Queries.GetAgentTask(ctx, parseUUID(pending))
				if task.Status != "failed" || task.FailureReason.String != "dependency_unsatisfied" {
					t.Fatal("claim read stale status")
				}
			}
		})
	}
}
