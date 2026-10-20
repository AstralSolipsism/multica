package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func externalWorkflowProject(t *testing.T, f externalPolicyFixture, target string) string {
	t.Helper()
	steps := fmt.Sprintf(`[{"status_key":"todo","handler":{"type":"none"}},{"status_key":"in_progress","handler":{"type":"agent","id":%q}}]`, target)
	workflow := f.fx.Insert(t, "issue_workflow", testutil.Cols{
		"workspace_id": testWorkspaceID, "name": "External " + target,
		"initial_status_key": "in_progress", "steps": steps,
	})
	return f.fx.Project(t, "External workflow", testutil.Cols{"workflow_id": workflow})
}

func TestExternalConversationCannotStopPreviousWorkflowRuns(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	target := f.fx.Agent(t, "Workflow target", f.runtime)
	previous := f.fx.Agent(t, "Previous assignee", f.runtime)
	project := externalWorkflowProject(t, f, target)
	for _, method := range []string{http.MethodPut, http.MethodPatch} {
		for _, mode := range []string{"status", "suppressed", "project-entry", "case-insensitive-field"} {
			for _, value := range []any{true, false, nil} {
				t.Run(fmt.Sprintf("%s/%s/%v", method, mode, value), func(t *testing.T) {
					issue := policyWakeIssue(t, f, previous)
					status := "todo"
					if mode == "project-entry" {
						status = "in_progress"
					} else {
						f.fx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", issue, project)
					}
					f.fx.Exec(t, "UPDATE issue SET status=$2 WHERE id=$1", issue, status)
					running := f.fx.Task(t, previous, testutil.Cols{
						"issue_id": issue, "runtime_id": f.runtime, "status": "running",
						"started_at": testutil.Raw("now()"),
					})
					body := map[string]any{
						"status": "in_progress", "description": "Must not persist",
						"stop_previous_assignee_runs": value, "suppress_run": mode == "suppressed",
					}
					if mode == "case-insensitive-field" {
						delete(body, "stop_previous_assignee_runs")
						body["STOP_PREVIOUS_ASSIGNEE_RUNS"] = value
					}
					if mode == "project-entry" {
						delete(body, "status")
						body["project_id"], body["enter_workflow_step"] = project, true
					}
					path := "/api/issues/" + issue
					if method == http.MethodPatch {
						version := policyRequest(t, f.token, http.MethodGet, path+"/dependencies", nil)
						var graph struct {
							DependencyVersion string `json:"dependency_version"`
						}
						if err := json.Unmarshal(version.Body.Bytes(), &graph); err != nil || version.Code != http.StatusOK || graph.DependencyVersion == "" {
							t.Fatalf("dependency snapshot: %d %s (%v)", version.Code, version.Body.String(), err)
						}
						path += "/with-dependencies"
						body["blocked_by"], body["expected_dependency_version"] = []string{}, graph.DependencyVersion
					}
					w := policyRequest(t, f.token, method, path, body)
					if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"code":"external_conversation_forbidden"`) {
						t.Fatalf("cancellation field accepted: %d %s", w.Code, w.Body.String())
					}
					var gotStatus, assignee, description, projectID string
					f.fx.QueryRow(t, `SELECT status,assignee_id::text,COALESCE(description,''),COALESCE(project_id::text,'')
						FROM issue WHERE id=$1`, issue).Scan(&gotStatus, &assignee, &description, &projectID)
					wantProject := project
					if mode == "project-entry" {
						wantProject = ""
					}
					if gotStatus != status || assignee != previous || description != "" || projectID != wantProject {
						t.Fatalf("rejected request mutated issue: %s %s %q %s", gotStatus, assignee, description, projectID)
					}
					var taskStatus string
					f.fx.QueryRow(t, "SELECT status FROM agent_task_queue WHERE id=$1", running).Scan(&taskStatus)
					if taskStatus != "running" || f.fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue) != 1 {
						t.Fatalf("rejected request changed runs: previous=%s", taskStatus)
					}
				})
			}
		}
	}
}

func TestExternalConversationWorkflowDispatchKeepsGrantor(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	grantor := fx.User(t, "Workflow grantor", "workflow-grantor@example.test")
	fx.Member(t, testWorkspaceID, grantor, "member")
	f := externalPolicyFixtureForGrantor(t, "root", grantor)
	fx.Exec(t, "UPDATE agent_runtime SET visibility='public' WHERE id=$1", f.runtime)
	target := fx.Agent(t, "Private workflow target", f.runtime, testutil.Cols{"owner_id": grantor, "permission_mode": "private"})
	project := externalWorkflowProject(t, f, target)
	for _, action := range []string{"create", "create-with-dependencies", "status", "project-entry"} {
		for _, runtimeOwnerOnly := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/runtime-owner-only=%t", action, runtimeOwnerOnly), func(t *testing.T) {
				owner := grantor
				if runtimeOwnerOnly {
					owner = testUserID
				}
				fx.Exec(t, "UPDATE agent SET owner_id=$2 WHERE id=$1", target, owner)
				method, path := http.MethodPost, "/api/issues"
				title := "External workflow " + t.Name()
				body := map[string]any{"title": title, "project_id": project, "status": "in_progress"}
				issue := ""
				switch action {
				case "create-with-dependencies":
					path += "/with-dependencies"
					body["blocked_by"] = []string{}
				case "status", "project-entry":
					issue = policyWakeIssue(t, f, "")
					method, path = http.MethodPut, "/api/issues/"+issue
					if action == "status" {
						fx.Exec(t, "UPDATE issue SET status='todo',project_id=$2 WHERE id=$1", issue, project)
						body = map[string]any{"status": "in_progress", "description": "External handoff"}
					} else {
						body = map[string]any{"project_id": project, "enter_workflow_step": true}
					}
				}
				w := policyRequest(t, f.token, method, path, body)
				if runtimeOwnerOnly {
					if w.Code != http.StatusForbidden {
						t.Fatalf("runtime owner lent invocation authority: %d %s", w.Code, w.Body.String())
					}
					if issue != "" && fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2", issue, target) != 0 {
						t.Fatal("denied workflow dispatched a run")
					}
					if issue == "" && fx.Count(t, "SELECT count(*) FROM issue WHERE title=$1 AND workspace_id=$2", title, testWorkspaceID) != 0 {
						t.Fatal("denied workflow created an issue")
					}
					return
				}
				want := http.StatusOK
				if method == http.MethodPost {
					want = http.StatusCreated
				}
				if w.Code != want {
					t.Fatalf("workflow dispatch: %d %s", w.Code, w.Body.String())
				}
				if issue == "" {
					var created struct{ ID string }
					if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.ID == "" {
						t.Fatalf("create response: %s (%v)", w.Body.String(), err)
					}
					issue = created.ID
					fx.Cleanup(t, "DELETE FROM issue WHERE id=$1", issue)
					fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
				}
				var originator, accountable, root string
				fx.QueryRow(t, `SELECT originator_user_id::text,accountable_user_id::text,conversation_root_task_id::text
					FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2`, issue, target).Scan(&originator, &accountable, &root)
				if originator != grantor || accountable != grantor || root != f.root {
					t.Fatalf("workflow lost authority: originator=%s accountable=%s root=%s", originator, accountable, root)
				}
			})
		}
	}
}
