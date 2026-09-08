package handler

// HTTP contract tests for the OL-27 personal/team notification-source
// surface (/api/message-routes, /api/message-approved-targets,
// /api/message-event-catalog). The cross-identity matrix of the acting-
// member seam is covered in autopilot_acting_member_test.go; these tests
// pin the SCOPE rules this surface layers on top: self-only inbox
// configuration, admin-only team configuration and approvals, and the
// revision guard.

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	messagedelivery "github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/testutil"
)

var srcOnce sync.Once

func requireSourceService(t *testing.T) *messagedelivery.Service {
	t.Helper()
	return requireDeliveryService(t)
}

// srcHTTPFixture is one active installation for the source HTTP tests.
type srcHTTPFixture struct {
	installID string
}

func newSourceHTTPFixture(t *testing.T, label string) srcHTTPFixture {
	t.Helper()
	requireSourceService(t)
	agentID := createWebhookTestAgent(t, "MD source agent "+label)
	installID := dbfx.Insert(t, "channel_installation", testutil.Cols{
		"workspace_id":      testWorkspaceID,
		"agent_id":          agentID,
		"channel_type":      "feishu",
		"config":            testutil.Raw(fmt.Sprintf(`'{"app_id":"cli_src_h_%s_%s"}'::jsonb`, mdFxFamily, label)),
		"status":            "active",
		"installer_user_id": testUserID,
	})
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM channel_installation WHERE id = $1 AND NOT EXISTS (
			SELECT 1 FROM labrastro_message_route WHERE installation_id = channel_installation.id)`, installID)
	})
	return srcHTTPFixture{installID: installID}
}

type sourceRouteResponse struct {
	Route struct {
		ID           string   `json:"id"`
		SourceKind   string   `json:"source_kind"`
		TargetType   string   `json:"target_type"`
		TargetUserID string   `json:"target_user_id"`
		TargetKey    string   `json:"target_key"`
		EventTypes   []string `json:"event_types"`
		Enabled      bool     `json:"enabled"`
		Revision     int32    `json:"revision"`
	} `json:"route"`
}

// TestMessageSourceRoutes_InboxCreateStampsActingMember: the server resolves
// the personal route's recipient — a caller-supplied target_user_id naming
// someone else is ignored, and only the recipient manages the route.
func TestMessageSourceRoutes_InboxCreateStampsActingMember(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSourceHTTPFixture(t, "self")
	other := plainMember(t, "md-src-other")
	dbfx.Insert(t, "channel_user_binding", testutil.Cols{
		"workspace_id":    testWorkspaceID,
		"multica_user_id": testUserID,
		"installation_id": fx.installID,
		"channel_type":    "feishu",
		"channel_user_id": "ou_src_owner",
	})

	// The workspace owner creates a personal route "for" another member:
	// the recipient is stamped as the OWNER, never the caller-supplied id.
	req := withURLParams(newRequest("POST", "/api/message-routes", map[string]any{
		"source_kind":     "inbox",
		"installation_id": fx.installID,
		"target_type":     "member",
		"target_user_id":  other,
		"event_types":     []string{"status_changed"},
	}), "routeId", "")
	created := testutil.Call(t, testHandler.CreateMessageSourceRoute, req).Want(http.StatusCreated)
	var out sourceRouteResponse
	created.JSON(&out)
	if out.Route.TargetUserID != testUserID {
		t.Fatalf("recipient = %q, want the acting member %q", out.Route.TargetUserID, testUserID)
	}
	if out.Route.SourceKind != "inbox" || out.Route.TargetType != "member" {
		t.Fatalf("route scope = %s/%s", out.Route.SourceKind, out.Route.TargetType)
	}
	if len(out.Route.EventTypes) != 1 || out.Route.EventTypes[0] != "status_changed" {
		t.Fatalf("event filter = %v", out.Route.EventTypes)
	}

	// Another member (the user the caller tried to name) cannot manage
	// someone else's personal route: 403 route_not_self.
	del := withURLParams(newRequestAs(other, "DELETE", "/api/message-routes/"+out.Route.ID, nil), "routeId", out.Route.ID)
	code := testutil.Call(t, testHandler.DeleteMessageSourceRoute, del).Want(http.StatusForbidden)
	if !strings.Contains(code.Body.String(), "route_not_self") {
		t.Fatalf("cross-user delete body = %s", code.Body.String())
	}

	// The recipient manages their own route: 204.
	del = withURLParams(newRequest("DELETE", "/api/message-routes/"+out.Route.ID, nil), "routeId", out.Route.ID)
	testutil.Call(t, testHandler.DeleteMessageSourceRoute, del).Want(http.StatusNoContent)
}

// TestMessageSourceRoutes_TeamRequiresAdminAndApproval: a plain member gets
// 403 on team configuration and approvals; an admin approves the target and
// then creates the route — an automation's approval is not consulted.
func TestMessageSourceRoutes_TeamRequiresAdminAndApproval(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSourceHTTPFixture(t, "team")
	member := plainMember(t, "md-src-plain")

	// Plain member: team route creation refused.
	req := newRequestAs(member, "POST", "/api/message-routes", map[string]any{
		"source_kind":     "activity",
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_src_team",
	})
	code := testutil.Call(t, testHandler.CreateMessageSourceRoute, req).Want(http.StatusForbidden)
	if !strings.Contains(code.Body.String(), "message_target_admin_required") {
		t.Fatalf("plain member team create body = %s", code.Body.String())
	}

	// Plain member: approval endpoint refused by the same gate.
	req = newRequestAs(member, "POST", "/api/message-approved-targets", map[string]any{
		"source_kind":     "activity",
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_src_team",
	})
	testutil.Call(t, testHandler.ApproveMessageSourceTarget, req).Want(http.StatusForbidden)

	// Admin approves the (activity, bot, target) scope, then the route saves.
	req = newRequest("POST", "/api/message-approved-targets", map[string]any{
		"source_kind":     "activity",
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_src_team",
	})
	testutil.Call(t, testHandler.ApproveMessageSourceTarget, req).Want(http.StatusCreated)

	projectID := dbfx.Project(t, "SRC http project")
	req = newRequest("POST", "/api/message-routes", map[string]any{
		"source_kind":     "activity",
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_src_team",
		"project_id":      projectID,
	})
	created := testutil.Call(t, testHandler.CreateMessageSourceRoute, req).Want(http.StatusCreated)
	var out sourceRouteResponse
	created.JSON(&out)
	if out.Route.SourceKind != "activity" || !out.Route.Enabled {
		t.Fatalf("team route = %+v", out.Route)
	}

	// The route save itself is a duplicate → 409 (fresh body: the first
	// request's reader is drained).
	dupReq := newRequest("POST", "/api/message-routes", map[string]any{
		"source_kind":     "activity",
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_src_team",
		"project_id":      projectID,
	})
	dup := testutil.Call(t, testHandler.CreateMessageSourceRoute, dupReq).Want(http.StatusConflict)
	if dup.Body == nil || !strings.Contains(dup.Body.String(), "route_already_exists") {
		t.Fatalf("duplicate create body = %s", dup.Body.String())
	}

	// A comment-scope approval does NOT cover an activity route to the same
	// chat (and vice versa): without a comment approval the save refuses.
	req = newRequest("POST", "/api/message-routes", map[string]any{
		"source_kind":     "comment",
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_src_team",
	})
	code = testutil.Call(t, testHandler.CreateMessageSourceRoute, req).Want(http.StatusBadRequest)
	if !strings.Contains(code.Body.String(), "route_target_not_approved") {
		t.Fatalf("cross-scope approval body = %s", code.Body.String())
	}

	// Personal (inbox) scope never enters the team approval surface.
	req = newRequest("POST", "/api/message-approved-targets", map[string]any{
		"source_kind":     "inbox",
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_src_team",
	})
	code = testutil.Call(t, testHandler.ApproveMessageSourceTarget, req).Want(http.StatusBadRequest)
	if !strings.Contains(code.Body.String(), "route_invalid") {
		t.Fatalf("inbox approval body = %s", code.Body.String())
	}
}

// TestMessageSourceRoutes_RevisionGuardAndEnable: the revision guard and the
// enable boundary behave like the automation surface.
func TestMessageSourceRoutes_RevisionGuardAndEnable(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newSourceHTTPFixture(t, "revision")
	dbfx.Insert(t, "channel_user_binding", testutil.Cols{
		"workspace_id":    testWorkspaceID,
		"multica_user_id": testUserID,
		"installation_id": fx.installID,
		"channel_type":    "feishu",
		"channel_user_id": "ou_src_revision",
	})

	req := newRequest("POST", "/api/message-routes", map[string]any{
		"source_kind":     "inbox",
		"installation_id": fx.installID,
		"target_type":     "member",
	})
	created := testutil.Call(t, testHandler.CreateMessageSourceRoute, req).Want(http.StatusCreated)
	var out sourceRouteResponse
	created.JSON(&out)

	// Stale revision → 409, never a silent overwrite.
	stale := withURLParams(newRequest("POST", "/api/message-routes/"+out.Route.ID+"/enable", map[string]any{
		"enabled":           false,
		"expected_revision": out.Route.Revision + 5,
	}), "routeId", out.Route.ID)
	code := testutil.Call(t, testHandler.SetMessageSourceRouteEnabled, stale).Want(http.StatusConflict)
	if !strings.Contains(code.Body.String(), "route_revision_conflict") {
		t.Fatalf("stale enable body = %s", code.Body.String())
	}

	// Current revision → disabled.
	ok := withURLParams(newRequest("POST", "/api/message-routes/"+out.Route.ID+"/enable", map[string]any{
		"enabled":           false,
		"expected_revision": out.Route.Revision,
	}), "routeId", out.Route.ID)
	testutil.Call(t, testHandler.SetMessageSourceRouteEnabled, ok).Want(http.StatusOK)

	// Run routes stay off this surface: 404 for the automation scope.
	agentID := createWebhookTestAgent(t, "SRC http agent")
	autopilotID := dbfx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id":    testWorkspaceID,
		"title":           "SRC http autopilot",
		"assignee_id":     agentID,
		"status":          "active",
		"execution_mode":  "run_only",
		"created_by_type": "member",
		"created_by_id":   testUserID,
	})
	runRouteID := dbfx.Insert(t, "labrastro_message_route", testutil.Cols{
		"id":              testutil.Raw("gen_random_uuid()"),
		"workspace_id":    testWorkspaceID,
		"autopilot_id":    autopilotID,
		"installation_id": fx.installID,
		"channel_type":    "feishu",
		"target_type":     "member",
		"target_user_id":  testutil.Raw("'" + testUserID + "'::uuid"),
		"target_key":      "member:" + testUserID,
		"created_by":      testutil.Raw("'" + testUserID + "'::uuid"),
		"updated_by":      testutil.Raw("'" + testUserID + "'::uuid"),
	})
	req = withURLParams(newRequest("PUT", "/api/message-routes/"+runRouteID, map[string]any{
		"expected_revision": 1,
	}), "routeId", runRouteID)
	testutil.Call(t, testHandler.UpdateMessageSourceRoute, req).Want(http.StatusNotFound)
}

// TestMessageEventCatalog_ReturnsCatalogForMembers: the catalog a config UI
// renders is reachable for a plain member and names the shared taxonomy.
func TestMessageEventCatalog_ReturnsCatalogForMembers(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	member := plainMember(t, "md-src-catalog")
	req := newRequestAs(member, "GET", "/api/message-event-catalog", nil)
	resp := testutil.Call(t, testHandler.GetMessageEventCatalog, req).Want(http.StatusOK)
	var catalog struct {
		Personal struct {
			SourceKind string `json:"source_kind"`
			EventTypes []struct {
				Type  string `json:"type"`
				Group string `json:"group"`
			} `json:"event_types"`
		} `json:"personal"`
		Team []struct {
			SourceKind string `json:"source_kind"`
			Events     []struct {
				Event string `json:"event"`
			} `json:"events"`
		} `json:"team"`
	}
	resp.JSON(&catalog)
	if catalog.Personal.SourceKind != "inbox" || len(catalog.Personal.EventTypes) == 0 {
		t.Fatalf("personal catalog = %+v", catalog.Personal)
	}
	found := false
	for _, e := range catalog.Personal.EventTypes {
		if e.Type == "status_changed" && e.Group == "status_changes" {
			found = true
		}
	}
	if !found {
		t.Fatalf("status_changed missing from personal catalog: %+v", catalog.Personal.EventTypes)
	}
	if len(catalog.Team) != 2 {
		t.Fatalf("team catalog = %+v", catalog.Team)
	}
}
