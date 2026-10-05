package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type failingCollaboratorRead struct {
	db.DBTX
	hits int
}

func (f *failingCollaboratorRead) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.HasPrefix(sql, "-- name: IsAutopilotCollaborator ") {
		f.hits++
		return failedCollaboratorRow{}
	}
	return f.DBTX.QueryRow(ctx, sql, args...)
}

type failedCollaboratorRow struct{}

func (failedCollaboratorRow) Scan(...any) error {
	return errors.New("injected collaborator lookup failure")
}

func TestAutopilotCollaboratorLookupFailureDeniesWriteAndSecrets(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	apID := createAutopilotAs(t, "", "ap-permission-read-failure")
	member := createPlainMember(t, "ap-permission-read-failure@multica.test")
	grantAutopilotAccess(t, "", apID, member, http.StatusCreated)
	path := "/api/autopilots/" + apID + "?workspace_id=" + testWorkspaceID
	testutil.Call(t, testHandler.CreateAutopilotTrigger, withURLParam(newRequest("POST",
		"/api/autopilots/"+apID+"/triggers?workspace_id="+testWorkspaceID,
		map[string]any{"kind": "webhook"}), "id", apID)).Want(http.StatusCreated)

	// Copy the handler so this fault cannot escape into other request fixtures.
	h := *testHandler
	fault := &failingCollaboratorRead{DBTX: testPool}
	get := func() (bool, AutopilotTriggerResponse) {
		t.Helper()
		var view struct {
			Autopilot AutopilotResponse          `json:"autopilot"`
			Triggers  []AutopilotTriggerResponse `json:"triggers"`
		}
		testutil.Call(t, h.GetAutopilot, withURLParam(newRequestAs(member, "GET", path, nil), "id", apID)).Want(http.StatusOK).JSON(&view)
		if view.Autopilot.CanWrite == nil || len(view.Triggers) != 1 {
			t.Fatalf("missing permission or webhook trigger: %+v", view)
		}
		return *view.Autopilot.CanWrite, view.Triggers[0]
	}
	// Prove the caller really has a grant, and the fixture contains a secret.
	if canWrite, trigger := get(); !canWrite || trigger.WebhookToken == nil || *trigger.WebhookToken == "" {
		t.Fatal("healthy collaborator lookup did not grant write and token access")
	}
	h.Queries = db.New(fault)
	testutil.Call(t, h.UpdateAutopilot, withURLParam(newRequestAs(member, "PATCH", path,
		map[string]any{"title": "must not be written"}), "id", apID)).Want(http.StatusForbidden)
	if fault.hits == 0 {
		t.Fatal("write did not exercise collaborator lookup fault")
	}
	fault.hits = 0
	canWrite, trigger := get()
	if fault.hits == 0 || canWrite || trigger.WebhookToken != nil || trigger.WebhookPath != nil || trigger.WebhookURL != nil {
		t.Fatalf("lookup failure exposed authority: hits=%d can_write=%v secret_visible=%v", fault.hits, canWrite,
			trigger.WebhookToken != nil || trigger.WebhookPath != nil || trigger.WebhookURL != nil)
	}
}
