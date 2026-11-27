package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/realtime"
	dbfx "github.com/multica-ai/multica/server/internal/testutil"
)

// Guests are deny-by-default (middleware/guest.go) and the graph route is not
// in their allowlist: the production router refuses a guest before the handler
// runs, whatever projects the guest may read. A member outside a private
// project still gets the graph, without that project's issues.
func TestIssueGraphRouteRefusesGuestsAndHidesPrivateProjects(t *testing.T) {
	fx := dbfx.New(testPool, testWorkspaceID, testUserID)
	fx.WorkspaceID = fx.Workspace(t, "Issue graph guests", "issue-graph-guests-"+uuid.NewString())
	fx.Cleanup(t, `DELETE FROM project WHERE workspace_id = $1`, fx.WorkspaceID)
	fx.Cleanup(t, `DELETE FROM issue WHERE workspace_id = $1`, fx.WorkspaceID)
	_, memberToken := privateRouteAdmin(fx, t, fx.WorkspaceID, "Issue graph member")
	guestID, guestToken := privateRouteAdmin(fx, t, fx.WorkspaceID, "Issue graph guest")
	fx.Exec(t, `UPDATE member SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`, fx.WorkspaceID, guestID)

	secret := fx.Project(t, "Private graph project", dbfx.Cols{"visibility": projectaccess.VisibilityPrivate})
	open := fx.Project(t, "Open graph project")
	hiddenIssue := fx.Issue(t, "Hidden by the private project", dbfx.Cols{"project_id": secret})
	openIssue := fx.Issue(t, "Open graph issue", dbfx.Cols{"project_id": open})
	fx.InsertNoID(t, "project_member", dbfx.Cols{"workspace_id": fx.WorkspaceID, "project_id": open, "user_id": guestID},
		"project_id = $1 AND user_id = $2", open, guestID)

	router, _ := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
	call := func(token, path string) routeAnswer {
		return privateRouteCall(router, fx.WorkspaceID, token, http.MethodGet, path, "")
	}
	// Control: the guest reads an issue of its project, so the refusal below
	// is the graph route's own boundary, not a missing grant.
	if got := call(guestToken, "/api/issues/"+openIssue); got.status != http.StatusOK {
		t.Fatalf("a guest reading an issue in its project got %v", got)
	}
	if got := call(guestToken, "/api/workspaces/"+fx.WorkspaceID+"/issues/graph"); got.status != http.StatusForbidden {
		t.Fatalf("a guest got %v; the graph route is outside the guest allowlist", got)
	}

	served := call(memberToken, "/api/workspaces/"+fx.WorkspaceID+"/issues/graph")
	if served.status != http.StatusOK {
		t.Fatalf("a member got %v", served)
	}
	var snapshot struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(served.body), &snapshot); err != nil {
		t.Fatalf("decode the member's graph: %v", err)
	}
	ids := make([]string, 0, len(snapshot.Nodes))
	for _, node := range snapshot.Nodes {
		ids = append(ids, node.ID)
	}
	if !slices.Contains(ids, openIssue) || slices.Contains(ids, hiddenIssue) || strings.Contains(served.body, secret) {
		t.Fatalf("a member outside the private project got %s; want %s, without the private project or %s", served.body, openIssue, hiddenIssue)
	}
}
