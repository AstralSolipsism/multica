//go:build !oss

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/realtime"
	dbfx "github.com/multica-ai/multica/server/internal/testutil"
)

// The commercial project-folder routes exist only when the binary links
// server/ee (cmd/server/ee.go), so the route-parameter classification they
// need registers only in that build. An -tags oss build keeps exhausting its
// own, smaller router with the same walk in private_project_routes_test.go.
func init() {
	routeParamsOutsideProjects["project-folders/{id}"] = outsideProjectParam{why: "a workspace folder of projects"}
}

// Project folders carry no access of their own, so the probe above judges
// nothing on their routes; but filing names a project, which may be private.
// A workspace admin outside the project must not see where it is filed, and
// moving it must answer as for a project that does not exist.
func TestProjectFolderRoutesHidePrivateProjects(t *testing.T) {
	fx := dbfx.New(testPool, testWorkspaceID, testUserID)
	fx.WorkspaceID = fx.Workspace(t, "Private project folders", "private-folders-"+uuid.NewString())
	fx.Cleanup(t, `DELETE FROM project_folder WHERE workspace_id = $1`, fx.WorkspaceID)
	insiderID, insiderToken := privateRouteAdmin(fx, t, fx.WorkspaceID, "Private folders insider")
	_, outsiderToken := privateRouteAdmin(fx, t, fx.WorkspaceID, "Private folders outsider")

	privateID := fx.Project(t, "Private folders project", dbfx.Cols{"visibility": projectaccess.VisibilityPrivate})
	publicID := fx.Project(t, "Public folders project")
	fx.InsertNoID(t, "project_member", dbfx.Cols{"workspace_id": fx.WorkspaceID, "project_id": privateID, "user_id": insiderID},
		"project_id = $1 AND user_id = $2", privateID, insiderID)

	router, _ := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
	call := func(token, method, path, body string) routeAnswer {
		return privateRouteCall(router, fx.WorkspaceID, token, method, path, body)
	}
	var folder struct {
		ID string `json:"id"`
	}
	if created := call(insiderToken, http.MethodPost, "/api/project-folders/", `{"name":"Clients"}`); created.status != http.StatusCreated {
		t.Fatalf("create folder: %v", created)
	} else if err := json.Unmarshal([]byte(created.body), &folder); err != nil {
		t.Fatalf("create folder answered %v: %v", created, err)
	}
	file := func(token, projectID string) routeAnswer {
		return call(token, http.MethodPost, "/api/project-folders/file", fmt.Sprintf(`{"project_id":%q,"folder_id":%q}`, projectID, folder.ID))
	}
	// filedBy lists the projects the caller sees filed in folders.
	filedBy := func(token string) []string {
		list := call(token, http.MethodGet, "/api/project-folders/", "")
		var resp struct {
			Filed []struct {
				ProjectID string `json:"project_id"`
			} `json:"filed"`
		}
		if err := json.Unmarshal([]byte(list.body), &resp); err != nil {
			t.Fatalf("list folders answered %v: %v", list, err)
		}
		var ids []string
		for _, p := range resp.Filed {
			ids = append(ids, p.ProjectID)
		}
		return ids
	}

	// Control: the member files both projects, and sees both.
	for _, projectID := range []string{privateID, publicID} {
		if moved := file(insiderToken, projectID); moved.status != http.StatusOK {
			t.Fatalf("a project member files %s: %v", projectID, moved)
		}
		if !slices.Contains(filedBy(insiderToken), projectID) {
			t.Errorf("a project member does not see %s filed", projectID)
		}
	}
	// The outsider sees the public project where it is filed, and the private
	// one nowhere: not in the list, and moving it answers as for a project
	// that does not exist.
	if !slices.Contains(filedBy(outsiderToken), publicID) {
		t.Errorf("a workspace admin outside the project does not see the public project filed")
	}
	if slices.Contains(filedBy(outsiderToken), privateID) {
		t.Errorf("a workspace admin outside the project sees the private project filed")
	}
	if hidden, missing := file(outsiderToken, privateID), file(outsiderToken, uuid.NewString()); hidden != missing {
		t.Errorf("a workspace admin outside the project got %v; a project that does not exist gets %v", hidden, missing)
	}
}
