//go:build !oss

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/internal/seatcapacity"
	dbfx "github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

// wsLockID is the lock key form of a workspace id: the parsed UUID, so every
// spelling shares one key.
func wsLockID(id string) uuid.UUID {
	return uuid.UUID(util.MustParseUUID(id).Bytes)
}

// takeFolderFence holds the workspace's folder-write lock through the same
// seat-capacity locker the fence uses, and returns its release.
func takeFolderFence(t *testing.T, workspaceID string) func() {
	t.Helper()
	_, release, err := seatcapacity.NewWorkspaceLockerWithOptions(testPool, seatcapacity.WorkspaceLockerOptions{
		Namespace: projectFolderLockNamespace,
	}).Lock(context.Background(), wsLockID(workspaceID))
	if err != nil {
		t.Fatalf("take the fence: %v", err)
	}
	return release
}

// checkFilingAnswer asserts the racing filing reported one of the two
// outcomes the fence orders, with the handler's contract body: 200 echoing
// the filed ids when it landed (the delete's clear then emptied it), or 400
// "folder not found in this workspace" when the folder was deleted first.
// Anything else — a 500, say — is a filing failure the reference checks
// would silently forgive.
func checkFilingAnswer(t *testing.T, round int, answer routeAnswer, projectID, folderID string) {
	t.Helper()
	switch answer.status {
	case http.StatusOK:
		var resp struct {
			ProjectID string `json:"project_id"`
			FolderID  string `json:"folder_id"`
		}
		if err := json.Unmarshal([]byte(answer.body), &resp); err != nil || resp.ProjectID != projectID || resp.FolderID != folderID {
			t.Fatalf("round %d: filing 200 body = %s, want project %s filed in %s", round, strings.TrimSpace(answer.body), projectID, folderID)
		}
	case http.StatusBadRequest:
		if !strings.Contains(answer.body, "folder not found in this workspace") {
			t.Fatalf("round %d: filing 400 body = %s, want the folder-not-found contract", round, strings.TrimSpace(answer.body))
		}
	default:
		t.Fatalf("round %d: filing answer %v, want 200 (filed, then cleared) or 400 (folder deleted first)", round, answer)
	}
}

// While the workspace's folder-write lock is held, a folder write request
// waits for it; released, the request completes. That wait is what keeps a
// filing and a folder deletion from interleaving.
func TestProjectFolderWritesSerializePerWorkspace(t *testing.T) {
	fx := dbfx.New(testPool, testWorkspaceID, testUserID)
	fx.WorkspaceID = fx.Workspace(t, "Folder write fence", "folder-fence-"+uuid.NewString())
	fx.Cleanup(t, `DELETE FROM project_folder WHERE workspace_id = $1`, fx.WorkspaceID)
	_, token := privateRouteAdmin(fx, t, fx.WorkspaceID, "Folder fence admin")

	router, _ := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
	release := takeFolderFence(t, fx.WorkspaceID)
	defer release()

	done := make(chan routeAnswer, 1)
	go func() {
		done <- privateRouteCall(router, fx.WorkspaceID, token, http.MethodPost, "/api/project-folders/", `{"name":"Fenced"}`)
	}()
	select {
	case answer := <-done:
		t.Fatalf("a folder write completed while the fence was held: %v", answer)
	case <-time.After(300 * time.Millisecond):
	}
	release()
	select {
	case answer := <-done:
		if answer.status != http.StatusCreated {
			t.Fatalf("folder write after the fence lifted: %v", answer)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the folder write did not finish after the fence lifted")
	}
}

// The lock keys on the parsed workspace UUID, so a request that spells the
// workspace id differently (an uppercase header) waits on the same lock as
// the canonical spelling.
func TestProjectFolderWriteLockIgnoresWorkspaceSpelling(t *testing.T) {
	fx := dbfx.New(testPool, testWorkspaceID, testUserID)
	fx.WorkspaceID = fx.Workspace(t, "Folder fence spelling", "folder-spelling-"+uuid.NewString())
	fx.Cleanup(t, `DELETE FROM project_folder WHERE workspace_id = $1`, fx.WorkspaceID)
	_, token := privateRouteAdmin(fx, t, fx.WorkspaceID, "Folder spelling admin")

	router, _ := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
	release := takeFolderFence(t, fx.WorkspaceID)
	defer release()

	done := make(chan routeAnswer, 1)
	go func() {
		done <- privateRouteCall(router, strings.ToUpper(fx.WorkspaceID), token, http.MethodPost, "/api/project-folders/", `{"name":"Spelled"}`)
	}()
	select {
	case answer := <-done:
		t.Fatalf("an uppercase workspace spelling reached a folder write while the fence was held: %v", answer)
	case <-time.After(300 * time.Millisecond):
	}
	release()
	select {
	case answer := <-done:
		if answer.status != http.StatusCreated {
			t.Fatalf("folder write after the fence lifted: %v", answer)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the folder write did not finish after the fence lifted")
	}
}

// On the smallest supported pool the fence still completes every write: with
// two connections, concurrent filings and folder deletions all finish, none
// answers 5xx, and the committed references stay resolvable.
func TestProjectFolderWritesCompleteOnAMinimalPool(t *testing.T) {
	fx := dbfx.New(testPool, testWorkspaceID, testUserID)
	fx.WorkspaceID = fx.Workspace(t, "Folder fence pool", "folder-pool-"+uuid.NewString())
	fx.Cleanup(t, `DELETE FROM project_folder WHERE workspace_id = $1`, fx.WorkspaceID)
	_, token := privateRouteAdmin(fx, t, fx.WorkspaceID, "Folder pool admin")

	smallPool, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL")+"&pool_max_conns=2")
	if err != nil {
		t.Fatalf("open the small pool: %v", err)
	}
	defer smallPool.Close()
	router, _ := NewRouterWithOptions(smallPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
	call := func(method, path, body string) routeAnswer {
		return privateRouteCall(router, fx.WorkspaceID, token, method, path, body)
	}

	const pairs = 5
	folders := make([]string, pairs)
	projects := make([]string, pairs)
	for i := range pairs {
		var folder struct {
			ID string `json:"id"`
		}
		if created := call(http.MethodPost, "/api/project-folders/", fmt.Sprintf(`{"name":"Pooled %d"}`, i)); created.status != http.StatusCreated {
			t.Fatalf("create folder %d: %v", i, created)
		} else if err := json.Unmarshal([]byte(created.body), &folder); err != nil {
			t.Fatalf("create folder %d answered %v: %v", i, created, err)
		}
		folders[i] = folder.ID
		projects[i] = fx.Project(t, fmt.Sprintf("Pooled round %d", i))
	}

	type racing struct {
		kind   string
		pair   int
		answer routeAnswer
	}
	answers := make(chan racing, 2*pairs)
	for i := range pairs {
		go func() {
			answers <- racing{"filing", i, call(http.MethodPost, "/api/project-folders/file", fmt.Sprintf(`{"project_id":%q,"folder_id":%q}`, projects[i], folders[i]))}
		}()
		go func() {
			answers <- racing{"deleting", i, call(http.MethodDelete, "/api/project-folders/"+folders[i], "")}
		}()
	}
	for range 2 * pairs {
		select {
		case r := <-answers:
			if r.answer.status >= 500 {
				t.Fatalf("pair %d %s answered %v", r.pair, r.kind, r.answer)
			}
			switch r.kind {
			case "filing":
				checkFilingAnswer(t, r.pair, r.answer, projects[r.pair], folders[r.pair])
			case "deleting":
				if r.answer.status != http.StatusNoContent {
					t.Fatalf("pair %d deleting the fresh folder: %v", r.pair, r.answer)
				}
			}
		case <-time.After(30 * time.Second):
			t.Fatal("a racing write did not finish on the minimal pool")
		}
	}
	var dangling int
	fx.QueryRow(t, `SELECT count(*) FROM project p
		WHERE p.workspace_id = $1 AND p.folder_id IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM project_folder f WHERE f.id = p.folder_id)`, fx.WorkspaceID).Scan(&dangling)
	if dangling != 0 {
		t.Fatalf("%d committed folder_id values resolve to no folder", dangling)
	}
}

// The fence turns the file/delete race into an ordering. Every round files a
// project into a fresh folder while another request deletes that folder, both
// through their own transactions; once both finish, the filing must have
// reported one of the two ordered outcomes with its contract body, the
// project must not remain filed, and every committed folder_id in the
// workspace must resolve.
func TestProjectFolderFileAndDeleteRaceKeepsReferencesResolvable(t *testing.T) {
	fx := dbfx.New(testPool, testWorkspaceID, testUserID)
	fx.WorkspaceID = fx.Workspace(t, "Folder write races", "folder-races-"+uuid.NewString())
	fx.Cleanup(t, `DELETE FROM project_folder WHERE workspace_id = $1`, fx.WorkspaceID)
	_, token := privateRouteAdmin(fx, t, fx.WorkspaceID, "Folder race admin")

	router, _ := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
	call := func(method, path, body string) routeAnswer {
		return privateRouteCall(router, fx.WorkspaceID, token, method, path, body)
	}

	for round := range 15 {
		var folder struct {
			ID string `json:"id"`
		}
		if created := call(http.MethodPost, "/api/project-folders/", fmt.Sprintf(`{"name":"Race %d"}`, round)); created.status != http.StatusCreated {
			t.Fatalf("round %d: create folder: %v", round, created)
		} else if err := json.Unmarshal([]byte(created.body), &folder); err != nil {
			t.Fatalf("round %d: create folder answered %v: %v", round, created, err)
		}
		projectID := fx.Project(t, fmt.Sprintf("Race round %d", round))
		filing := make(chan routeAnswer, 1)
		deleting := make(chan routeAnswer, 1)
		go func() {
			filing <- call(http.MethodPost, "/api/project-folders/file", fmt.Sprintf(`{"project_id":%q,"folder_id":%q}`, projectID, folder.ID))
		}()
		go func() {
			deleting <- call(http.MethodDelete, "/api/project-folders/"+folder.ID, "")
		}()
		var fileAnswer, deleteAnswer routeAnswer
		for range 2 {
			select {
			case fileAnswer = <-filing:
			case deleteAnswer = <-deleting:
			case <-time.After(30 * time.Second):
				t.Fatalf("round %d: a racing request did not finish", round)
			}
		}
		if deleteAnswer.status != http.StatusNoContent {
			t.Fatalf("round %d: deleting the fresh folder: %v", round, deleteAnswer)
		}
		checkFilingAnswer(t, round, fileAnswer, projectID, folder.ID)
		var filed *string
		fx.QueryRow(t, `SELECT folder_id::text FROM project WHERE id = $1`, projectID).Scan(&filed)
		if filed != nil {
			t.Fatalf("round %d: the project stayed filed in a deleted folder (%s); filing=%v", round, *filed, fileAnswer)
		}
		var dangling int
		fx.QueryRow(t, `SELECT count(*) FROM project p
			WHERE p.workspace_id = $1 AND p.folder_id IS NOT NULL
			  AND NOT EXISTS (SELECT 1 FROM project_folder f WHERE f.id = p.folder_id)`, fx.WorkspaceID).Scan(&dangling)
		if dangling != 0 {
			t.Fatalf("round %d: %d committed folder_id values resolve to no folder (filing=%v)", round, dangling, fileAnswer)
		}
	}
}
