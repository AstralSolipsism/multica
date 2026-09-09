package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestReviewOL27_PersonalListIsSelfOnly(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database unavailable")
	}
	fx := newSourceHTTPFixture(t, "review-list")
	other := plainMember(t, "review-list-other")
	for _, userID := range []string{testUserID, other} {
		dbfx.Insert(t, "labrastro_message_route", testutil.Cols{
			"id":              testutil.Raw("gen_random_uuid()"),
			"workspace_id":    testWorkspaceID,
			"installation_id": fx.installID,
			"channel_type":    "feishu",
			"target_type":     "member",
			"target_user_id":  userID,
			"target_key":      "member:" + userID,
			"source_kind":     "inbox",
			"created_by":      userID,
			"updated_by":      userID,
		})
	}
	req := newRequestAs(other, "GET", "/api/message-routes?source_kind=inbox", nil)
	var out struct {
		Routes []struct {
			TargetUserID string `json:"target_user_id"`
		} `json:"routes"`
	}
	testutil.Call(t, testHandler.ListMessageSourceRoutes, req).Want(http.StatusOK).JSON(&out)
	if len(out.Routes) != 1 {
		t.Fatalf("own personal route missing or extra routes visible: %d", len(out.Routes))
	}
	for _, route := range out.Routes {
		if route.TargetUserID != other {
			t.Fatalf("personal list exposed another recipient: got %s, acting member %s", route.TargetUserID, other)
		}
	}
}
