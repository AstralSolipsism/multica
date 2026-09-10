package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// OL-42's canonical integration layer: the actual CLI talks to OL-39/41's
// handlers, real auth middleware and PostgreSQL. No daemon or agent CLI runs.
func TestDependencyCLIIntegration(t *testing.T) {
	h, fx, a, b, c, agent, runtimeID := dispatchFixture(t)
	_, source, _, _ := runtime.Caller(0)
	bin := filepath.Join(t.TempDir(), "multica")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", bin, "../../cmd/multica")
	build.Dir = filepath.Dir(source)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	token := "mat_" + fx.WorkspaceID
	sourceAgent := fx.Agent(t, "fake CLI planner", runtimeID)
	task := fx.Task(t, sourceAgent, testutil.Cols{"runtime_id": runtimeID, "status": "running", "originator_user_id": fx.UserID, "accountable_user_id": fx.UserID})
	fx.Insert(t, "task_token", testutil.Cols{"token_hash": auth.HashToken(token), "task_id": task, "agent_id": sourceAgent, "workspace_id": fx.WorkspaceID, "user_id": fx.UserID, "expires_at": time.Now().Add(time.Hour)})
	// Also collect rows created by the CLI, which are outside fixture builders.
	t.Cleanup(func() {
		fx.Exec(t, "DELETE FROM agent_task_queue WHERE agent_id=$1", agent)
		fx.Exec(t, "DELETE FROM comment WHERE workspace_id=$1", fx.WorkspaceID)
		fx.Exec(t, "DELETE FROM issue_dependency WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", fx.WorkspaceID)
		fx.Exec(t, "DELETE FROM issue WHERE workspace_id=$1", fx.WorkspaceID)
	})
	router := chi.NewRouter()
	router.Use(middleware.Auth(h.Queries, nil, nil), middleware.RequireWorkspaceMember(h.Queries))
	router.Get("/api/issues/{id}", h.GetIssue)
	router.Get("/api/issues/{id}/dependencies", h.GetIssueDependencies)
	router.Post("/api/issues", h.CreateIssue)
	router.Post("/api/issues/with-dependencies", h.CreateIssueWithDependencies)
	router.Patch("/api/issues/{id}/with-dependencies", h.UpdateIssueWithDependencies)
	router.Put("/api/issues/{id}", h.UpdateIssue)
	router.Post("/api/issues/{id}/comments", h.CreateComment)
	router.Post("/api/issues/preview-trigger", h.PreviewIssueTrigger)
	router.Get("/api/agents", h.ListAgents)
	router.Get("/api/workspaces/{id}/members", h.ListMembersWithUser)
	router.Get("/api/squads", h.ListSquads)
	server := httptest.NewServer(router)
	defer server.Close()
	dir := t.TempDir()
	run := func(wantExit int, args ...string) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, append(args, "--output", "json")...)
		cmd.Dir = dir
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "MULTICA_SERVER_URL=" + server.URL, "MULTICA_WORKSPACE_ID=" + fx.WorkspaceID,
			"MULTICA_TOKEN=" + token, "MULTICA_TASK_CONFIG_ROOT=" + dir, "MULTICA_AGENT_ID=" + sourceAgent, "MULTICA_TASK_ID=" + task}
		var out, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &stderr
		err := cmd.Run()
		exit := 0
		if err != nil {
			if e, ok := err.(*exec.ExitError); ok {
				exit = e.ExitCode()
			} else {
				t.Fatal(err)
			}
		}
		if exit != wantExit {
			t.Fatalf("%v: exit=%d want=%d\nstdout=%s\nstderr=%s", args, exit, wantExit, out.String(), stderr.String())
		}
		var result map[string]any
		if err := json.Unmarshal(out.Bytes(), &result); err != nil {
			t.Fatalf("invalid CLI JSON: %s\nstderr=%s", out.String(), stderr.String())
		}
		return result
	}
	countIssues := func() int { return fx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", fx.WorkspaceID) }
	countRuns := func(id string) int {
		return fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND status<>'completed'", id)
	}
	p1, p2 := fx.Project(t, "Accounts"), fx.Project(t, "Orders")
	fx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", a, p1)
	fx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", c, p2)
	parent := dependencyIssue(t, fx, "Checkout feature", testutil.Cols{"project_id": p2})
	created := run(0, "issue", "create", "--title", "CLI checkout", "--parent", parent, "--project", p2, "--stage", "3", "--blocked-by", a, "--blocked-by", c, "--status", "backlog")
	id := created["id"].(string)
	if created["parent_issue_id"] != parent || created["stage"] != float64(3) || len(dependencies(t, h, fx, id).BlockedBy) != 2 || countRuns(id) != 0 {
		t.Fatal("compound planning did not preserve ownership, stage and dependencies", created)
	}
	before := countIssues()
	failure := run(1, "issue", "create", "--title", "must not exist", "--blocked-by", a, "--blocked-by", c, "--assignee-id", agent, "--status", "todo")
	if failure["reason_code"] != "dependency_unsatisfied" || countIssues() != before {
		t.Fatal("blocked compound create left an issue", failure)
	}
	d := dependencyIssue(t, fx, "additional prerequisite", testutil.Cols{"status": "done"})
	failure = run(1, "issue", "update", id, "--blocked-by", a, "--blocked-by", c, "--blocked-by", d, "--title", "must roll back", "--assignee-id", agent, "--no-start")
	row := run(0, "issue", "get", id)
	if failure["reason_code"] != "dependency_unsatisfied" || row["title"] != "CLI checkout" || row["assignee_id"] != nil || countRuns(id) != 0 || len(dependencies(t, h, fx, id).BlockedBy) != 2 {
		t.Fatal("blocked compound update partially committed", row)
	}
	for _, args := range [][]string{{"issue", "update", id, "--clear-blocked-by"}, {"issue", "dependency", "remove", id, "--blocked-by", a}} {
		if got := run(3, args...); got["reason_code"] != "dependency_change_not_allowed" {
			t.Fatal(got)
		}
	}
	child := dependencyIssue(t, fx, "inherited CLI target", testutil.Cols{"parent_issue_id": b, "status": "backlog"})
	view := run(0, "issue", "dependency", "list", child)
	if len(view["inherited_blocked_by"].([]any)) != 2 || len(view["blocked_by"].([]any)) != 0 {
		t.Fatal("inherited projection lost", view)
	}
	if got := run(1, "issue", "assign", child, "--to-id", agent, "--no-start"); got["reason_code"] != "dependency_unsatisfied" || countRuns(child) != 0 {
		t.Fatal("legacy assignment bypassed inheritance", got)
	}
	content := fmt.Sprintf("[@fake](mention://agent/%s)", agent)
	if err := os.WriteFile(filepath.Join(dir, "comment.md"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	comment := run(1, "issue", "comment", "add", id, "--content-file", "./comment.md")
	if comment["id"] == nil || fx.Count(t, "SELECT count(*) FROM comment WHERE issue_id=$1", id) != 1 || countRuns(id) != 0 {
		t.Fatal("comment was lost, duplicated or dispatched", comment)
	}

	// The human half is the existing UI/API contract, not a force flag or an
	// agent borrowing a profile. Sign an isolated test JWT and exercise Auth.
	jwtToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": fx.UserID, "email": "cli-fixture@example.test", "exp": time.Now().Add(time.Hour).Unix()}).SignedString(auth.JWTSecret())
	if err != nil {
		t.Fatal(err)
	}
	human := cli.NewAPIClient(server.URL, fx.WorkspaceID, jwtToken)
	mutation := map[string]any{"assignee_type": "agent", "assignee_id": agent, "status": "todo"}
	var preview IssueTriggerPreviewResponse
	if err := human.PostJSON(context.Background(), "/api/issues/preview-trigger", map[string]any{"issue_ids": []string{b}, "mutation": mutation}, &preview); err != nil {
		t.Fatal(err)
	}
	if len(preview.Blocked) != 1 || preview.Blocked[0].Confirmation == nil {
		t.Fatal("human preview lacks confirmation", preview)
	}
	mutation["dependency_override"] = preview.Blocked[0].Confirmation.DependencyOverride
	var first, replay IssueResponse
	for _, dst := range []*IssueResponse{&first, &replay} {
		if err := human.PatchJSON(context.Background(), "/api/issues/"+b+"/with-dependencies", mutation, dst); err != nil {
			t.Fatal(err)
		}
	}
	if first.Dispatch == nil || first.Dispatch.TaskID == nil || replay.Dispatch == nil || replay.Dispatch.TaskID == nil || *first.Dispatch.TaskID != *replay.Dispatch.TaskID || countRuns(b) != 1 {
		t.Fatal("human confirmation did not produce exactly one execution")
	}
	run(0, "issue", "status", a, "done", "--no-start")
	if got := run(1, "issue", "assign", id, "--to-id", agent); got["reason_code"] != "dependency_unsatisfied" || countRuns(id) != 0 {
		t.Fatal("one completed prerequisite permitted execution", got)
	}
	run(0, "issue", "status", c, "done", "--no-start")
	assigned := run(0, "issue", "assign", id, "--to-id", agent)
	if assigned["assignee_id"] != agent || countRuns(id) != 0 {
		t.Fatal("ready backlog assignment must preserve backlog planning", assigned)
	}
	ready := run(0, "issue", "status", id, "todo")
	if ready["dispatch"].(map[string]any)["status"] != "queued" || countRuns(id) != 1 {
		t.Fatal("completed prerequisites did not restore execution", ready)
	}
	run(0, "issue", "dependency", "remove", id, "--blocked-by", a)
	run(0, "issue", "update", id, "--clear-blocked-by")
	if len(dependencies(t, h, fx, id).BlockedBy) != 0 {
		t.Fatal("completed prerequisites could not be removed")
	}
	t.Log("CLI/API: compound planning, blocked create/update rollback, inherited admission, removal authorization, saved comment/refused dispatch, authenticated human one-shot confirmation, partial/all prerequisites complete passed")
}
