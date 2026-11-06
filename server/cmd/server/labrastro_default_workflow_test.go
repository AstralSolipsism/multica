package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestExternalConversationDefaultWorkflowCustomStatuses(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	ctx, q := context.Background(), db.New(testPool)
	if err := issuestatus.Ensure(ctx, q, policyUUID(t, testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
	workflow, err := issueworkflow.EnsureDefault(ctx, q, policyUUID(t, testWorkspaceID))
	if err != nil {
		t.Fatal(err)
	}
	f.fx.Cleanup(t, `UPDATE issue_workflow SET steps=$2 WHERE id=$1`, workflow.ID, workflow.Steps)
	f.fx.Exec(t, `UPDATE issue_workflow SET steps='[{"status_key":"todo"},{"status_key":"blocked"},{"status_key":"done"},{"status_key":"cancelled"}]' WHERE id=$1`, workflow.ID)
	for key, category := range map[string]string{"backlog_2": "unstarted", "done_2": "done", "named_only": "started"} {
		f.fx.Insert(t, "issue_status", testutil.Cols{"workspace_id": testWorkspaceID, "key": key, "name": key, "category": category, "color": "#123456"})
	}
	f.fx.Insert(t, "issue_workflow", testutil.Cols{"workspace_id": testWorkspaceID, "name": "Named " + f.root,
		"initial_status_key": "backlog_2", "steps": `[{"status_key":"backlog_2"},{"status_key":"done_2"},{"status_key":"named_only"}]`})
	project := f.fx.Project(t, "Default external project")
	f.fx.Issue(t, "Existing discussion", testutil.Cols{"status": "backlog_2", "number": -1})
	f.fx.Issue(t, "Existing summary", testutil.Cols{"status": "done_2", "number": -2, "project_id": project})
	migration, err := os.ReadFile("../../migrations/9054_labrastro_default_workflow_keep_in_use_statuses.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	f.fx.Exec(t, string(migration))
	for _, projectID := range []string{"", project} {
		for _, status := range []string{"backlog_2", "done_2"} {
			body := map[string]any{"title": "External " + status, "status": status}
			if projectID != "" {
				body["project_id"] = projectID
			}
			response := policyRequest(t, f.token, http.MethodPost, "/api/issues", body)
			var created struct{ ID, Status string }
			if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil || response.Code != http.StatusCreated || created.Status != status {
				t.Fatalf("external create: %d %s (%v)", response.Code, response.Body, err)
			}
			f.fx.Cleanup(t, `DELETE FROM issue WHERE id=$1`, created.ID)
			for _, next := range []string{"todo", status} {
				updated := policyRequest(t, f.token, http.MethodPut, "/api/issues/"+created.ID, map[string]any{"status": next})
				if updated.Code != http.StatusOK {
					t.Fatalf("external update: %d %s", updated.Code, updated.Body)
				}
			}
		}
	}
	response := policyRequest(t, f.token, http.MethodPost, "/api/issues", map[string]any{"title": "Denied state", "status": "named_only"})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("named-only status accepted outside its workflow: %d %s", response.Code, response.Body)
	}
}
