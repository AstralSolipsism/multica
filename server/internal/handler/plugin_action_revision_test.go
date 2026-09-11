package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	publicapiv1 "github.com/multica-ai/multica/server/pkg/publicapi/v1"
)

type pluginContentTxStarter struct {
	beforeBegin func()
}

func (s pluginContentTxStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	s.beforeBegin()
	return testPool.Begin(ctx)
}

func TestPluginIssueConditionalPatchAfterDeletion(t *testing.T) {
	for _, source := range []string{"If-Match", "expected_revision"} {
		t.Run(source, func(t *testing.T) {
			installation := installPluginForAction(t, []string{"issues:read", "issues:write"})
			id := dbfx.Issue(t, "Conditional content deletion")
			issue, err := testHandler.Queries.GetIssue(context.Background(), parseUUID(id))
			if err != nil {
				t.Fatal(err)
			}
			h := *testHandler
			issueService := *h.IssueService
			h.IssueService = &issueService
			deleted := false
			// Delete after the real handler has loaded the issue and checked its revision.
			issueService.TxStarter = pluginContentTxStarter{beforeBegin: func() {
				dbfx.Exec(t, "DELETE FROM issue WHERE id=$1", id)
				deleted = true
			}}
			body := map[string]any{"title": "Conditional update"}
			if source == "expected_revision" {
				body[source] = issue.Revision
			}
			r := pluginActionRequest(http.MethodPatch, "/v1/issues/"+id, installation, body, map[string]string{"issue_ref": id})
			if source == "If-Match" {
				r.Header.Set(source, fmt.Sprintf(`W/"%d"`, issue.Revision))
			}
			var problem publicapiv1.Problem
			response := testutil.Call(t, h.PatchPluginIssue, r).Want(http.StatusConflict).JSON(&problem)
			if !deleted || problem.Code != "revision_conflict" || problem.Status != http.StatusConflict {
				t.Fatalf("conditional deletion: deleted=%t problem=%+v", deleted, problem)
			}
			if response.Header().Get("ETag") != "" || dbfx.Count(t, "SELECT count(*) FROM issue WHERE id=$1", id) != 0 {
				t.Fatal("failed conditional update published a revision or recreated the deleted issue")
			}
		})
	}
}

func TestPluginContentUpdateAfterWorkspaceDeletion(t *testing.T) {
	for _, conditional := range []bool{false, true} {
		t.Run(fmt.Sprintf("conditional=%t", conditional), func(t *testing.T) {
			h, fx := dependencyFixture(t)
			id := fx.Issue(t, "Deleted workspace content")
			ctx := context.Background()
			issue, err := h.Queries.GetIssue(ctx, parseUUID(id))
			if err != nil {
				t.Fatal(err)
			}
			fx.Exec(t, "DELETE FROM issue WHERE id=$1", id)
			fx.Exec(t, "DELETE FROM workspace WHERE id=$1", fx.WorkspaceID)
			title := "Must not be written"
			patch := service.IssueContentPatch{Title: &title}
			wantErr := pgx.ErrNoRows
			if conditional {
				patch.ExpectedRevision = &issue.Revision
				wantErr = service.ErrIssueRevisionConflict
			}
			if _, err := h.IssueService.UpdateContent(ctx, issue, patch); !errors.Is(err, wantErr) {
				t.Fatalf("update after workspace deletion: got %v, want %v", err, wantErr)
			}
		})
	}
}
