package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Repaired default workflows keep custom statuses usable through the router.
func TestDefaultWorkflowCustomStatusesThroughRouter(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	ctx, q := context.Background(), db.New(testPool)
	workspace := toPgUUID(t, testWorkspaceID)
	if err := issuestatus.Ensure(ctx, q, workspace); err != nil {
		t.Fatal(err)
	}
	workflow, err := issueworkflow.EnsureDefault(ctx, q, workspace)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path string, body any) (int, []byte) {
		t.Helper()
		resp := authRequest(t, method, path, body)
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, raw
	}
	fx.Cleanup(t, `UPDATE issue_workflow SET steps=$2 WHERE id=$1`, workflow.ID, workflow.Steps)
	fx.Exec(t, `UPDATE issue_workflow SET steps='[{"status_key":"todo"},{"status_key":"blocked"},{"status_key":"done"},{"status_key":"cancelled"}]' WHERE id=$1`, workflow.ID)
	for key, category := range map[string]string{"backlog_2": "unstarted", "done_2": "done", "named_only": "started"} {
		fx.Insert(t, "issue_status", testutil.Cols{"workspace_id": testWorkspaceID, "key": key, "name": key, "category": category, "color": "#123456"})
	}
	fx.Insert(t, "issue_workflow", testutil.Cols{"workspace_id": testWorkspaceID, "name": "Named default workflow repair",
		"initial_status_key": "backlog_2", "steps": `[{"status_key":"backlog_2"},{"status_key":"done_2"},{"status_key":"named_only"}]`})
	project := fx.Project(t, "Default workflow project")
	fx.Issue(t, "Existing discussion", testutil.Cols{"status": "backlog_2", "number": -1})
	fx.Issue(t, "Existing summary", testutil.Cols{"status": "done_2", "number": -2, "project_id": project})
	migration, err := os.ReadFile("../../migrations/9054_labrastro_default_workflow_keep_in_use_statuses.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	fx.Exec(t, string(migration))
	for _, projectID := range []string{"", project} {
		for _, status := range []string{"backlog_2", "done_2"} {
			body := map[string]any{"title": "Custom " + status, "status": status}
			if projectID != "" {
				body["project_id"] = projectID
			}
			code, raw := request(http.MethodPost, "/api/issues", body)
			var created struct{ ID, Status string }
			if err := json.Unmarshal(raw, &created); err != nil || code != http.StatusCreated || created.Status != status {
				t.Fatalf("create: %d %s (%v)", code, raw, err)
			}
			fx.Cleanup(t, `DELETE FROM issue WHERE id=$1`, created.ID)
			for _, next := range []string{"todo", status} {
				if code, raw := request(http.MethodPut, "/api/issues/"+created.ID, map[string]any{"status": next}); code != http.StatusOK {
					t.Fatalf("update: %d %s", code, raw)
				}
			}
		}
	}
	if code, raw := request(http.MethodPost, "/api/issues", map[string]any{"title": "Denied state", "status": "named_only"}); code != http.StatusBadRequest {
		t.Fatalf("named-only status accepted outside its workflow: %d %s", code, raw)
	}
}
