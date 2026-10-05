package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestExternalConversationTranscriptsStayWithinRoot(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	other := newExternalPolicyFixture(t, "root")
	child := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "status": "running", "originator_source": "delegation", "delegated_from_task_id": f.root,
		"originator_user_id": testUserID, "accountable_user_id": testUserID})
	ordinary := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "status": "running", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID})
	childToken := mintAgentTaskToken(t, f.agent, child, testUserID)
	ordinaryToken := mintAgentTaskToken(t, f.agent, ordinary, testUserID)
	issue := f.fx.Issue(t, "Transcript workspace")
	for _, id := range []string{f.root, other.root, child, ordinary} {
		f.fx.Exec(t, "UPDATE agent_task_queue SET issue_id=$2 WHERE id=$1", id, issue)
		f.fx.Insert(t, "task_message", testutil.Cols{"task_id": id, "seq": 1, "type": "text", "content": "transcript " + id})
	}
	for _, caller := range []struct{ name, token string }{{"root", f.token}, {"delegate", childToken}, {"first-party", ordinaryToken}, {"member", testToken}} {
		t.Run(caller.name, func(t *testing.T) {
			for _, target := range []struct{ name, id string }{{"own-root", f.root}, {"same-root", child}, {"other-root", other.root}, {"ordinary", ordinary}} {
				t.Run(target.name, func(t *testing.T) {
					want := 200
					if (caller.name == "root" || caller.name == "delegate") && (target.id == other.root || target.id == ordinary) {
						want = 404
					}
					for _, query := range []string{"", "?since=0"} {
						req := testutil.WithHeaders(testutil.JSONRequest("GET", "/api/tasks/"+target.id+"/messages"+query, nil), "Authorization", "Bearer "+caller.token, "X-Workspace-ID", testWorkspaceID)
						response := testutil.Call(t, testServer.Config.Handler.ServeHTTP, req).Want(want)
						if want == 200 {
							var messages []protocol.TaskMessagePayload
							response.JSON(&messages)
							if len(messages) != 1 || messages[0].Content != "transcript "+target.id {
								t.Fatalf("wrong transcript: %+v", messages)
							}
						}
					}
				})
			}
		})
	}
}

// Simulate deletion between the token lookup and the task lookup, without
// disabling the real schema's task-token cleanup trigger.
type taskAuthorizationFaultDB struct {
	db.DBTX
	err error
}

func (f taskAuthorizationFaultDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "-- name: GetAgentTask ") {
		return taskAuthorizationFaultRow{f.err}
	}
	return f.DBTX.QueryRow(ctx, sql, args...)
}

type taskAuthorizationFaultRow struct{ err error }

func (r taskAuthorizationFaultRow) Scan(...any) error { return r.err }

func TestTaskTokenTaskLookupFailure(t *testing.T) {
	f := newExternalPolicyFixture(t, "root")
	id := f.fx.Task(t, f.agent, testutil.Cols{"runtime_id": f.runtime, "status": "running", "originator_source": "direct_human", "originator_user_id": testUserID, "accountable_user_id": testUserID})
	token := mintAgentTaskToken(t, f.agent, id, testUserID)
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"deleted", pgx.ErrNoRows, 401},
		{"wrapped deletion", fmt.Errorf("lookup task: %w", pgx.ErrNoRows), 401},
		{"database unavailable", context.DeadlineExceeded, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(middleware.Auth(db.New(taskAuthorizationFaultDB{DBTX: testPool, err: tc.err}), nil, nil, nil))
			router.Get("/api/issues", func(http.ResponseWriter, *http.Request) { t.Fatal("unauthorized task reached handler") })
			req := testutil.WithHeaders(testutil.JSONRequest("GET", "/api/issues", nil), "Authorization", "Bearer "+token)
			testutil.Call(t, router.ServeHTTP, req).Want(tc.status)
		})
	}
}
