package handler

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestLabrastroPrivateProjectTipListAndState(t *testing.T) {
	f := newYSKFixture(t)
	project := f.Project(t, "private tips", testutil.Cols{"visibility": "private"})
	f.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
	user := f.User(t, "tip outsider", uuid.NewString()+"@test.invalid")
	f.Member(t, f.WorkspaceID, user, "member")
	tip := f.tip(t, "secret topic")
	if len(f.list(t, true, false, user)) != 0 || len(f.list(t, true, false, testUserID)) != 1 {
		t.Fatal("active list did not respect private project membership")
	}
	state := func(id string, want int) string {
		return testutil.Call(t, f.h.LabrastroSetTipState, asUser(f.request("POST", map[string]any{"state": "known"}, "tipId", id), user)).Want(want).Text()
	}
	if state(tip, 404) != state(uuid.NewString(), 404) {
		t.Fatal("state response reveals hidden tip existence")
	}
	if f.Count(t, "SELECT count(*) FROM labrastro_issue_tip_state WHERE tip_id=$1", tip) != 0 || f.Count(t, "SELECT count(*) FROM labrastro_known_topic WHERE user_id=$1", user) != 0 {
		t.Fatal("denied state update persisted private material")
	}
	f.InsertNoID(t, "project_member", testutil.Cols{"workspace_id": f.WorkspaceID, "project_id": project, "user_id": user}, "project_id=$1 AND user_id=$2", project, user)
	if len(f.list(t, true, false, user)) != 1 {
		t.Fatal("project member lost active tip")
	}
	state(tip, 200)
}

func TestLabrastroPrivateProjectTipChatRevocation(t *testing.T) {
	for _, change := range []string{"caller", "agent_owner", "issue_moved"} {
		t.Run(change, func(t *testing.T) {
			f := newTipChatFixture(t)
			f.Exec(t, "UPDATE agent_runtime SET visibility='public' WHERE id=$1", f.runtime)
			project := f.Project(t, "private source", testutil.Cols{"visibility": "private"})
			user := f.User(t, "tip reader", uuid.NewString()+"@test.invalid")
			owner := f.User(t, "tip agent owner", uuid.NewString()+"@test.invalid")
			for _, id := range []string{user, owner} {
				f.Member(t, f.WorkspaceID, id, "member")
				if change != "issue_moved" {
					f.InsertNoID(t, "project_member", testutil.Cols{"workspace_id": f.WorkspaceID, "project_id": project, "user_id": id}, "project_id=$1 AND user_id=$2", project, id)
				}
			}
			f.Exec(t, "UPDATE agent SET owner_id=$2, visibility='workspace', permission_mode='public_to' WHERE id=$1", f.agent, owner)
			f.InsertNoID(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": "workspace", "target_id": f.WorkspaceID}, "agent_id=$1", f.agent)
			if change != "issue_moved" {
				f.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
			}
			tip := f.tip(t, "private model input")
			var session ChatSessionResponse
			testutil.Call(t, f.h.LabrastroOpenTipChat, asUser(f.request("POST", nil, "tipId", tip), user)).Want(201).JSON(&session)
			testutil.Call(t, f.tipChatHandler(f.h.SendChatMessage), asUser(f.request("POST", map[string]any{"content": "Explain"}, "sessionId", session.ID), user)).Want(201)
			if change == "issue_moved" {
				f.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
			} else {
				removed := user
				if change == "agent_owner" {
					removed = owner
				}
				f.Exec(t, "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2", project, removed)
			}
			testutil.Call(t, f.h.LabrastroOpenTipChat, asUser(f.request("POST", nil, "tipId", tip), user)).Want(404)
			testutil.Call(t, f.tipChatHandler(f.h.GetChatSession), asUser(f.request("GET", nil, "sessionId", session.ID), user)).Want(404)
			testutil.Call(t, f.tipChatHandler(f.h.ListChatMessages), asUser(f.request("GET", nil, "sessionId", session.ID), user)).Want(404)
			testutil.Call(t, f.tipChatHandler(f.h.SendChatMessage), asUser(f.request("POST", map[string]any{"content": "Again"}, "sessionId", session.ID), user)).Want(404)
			list := testutil.Call(t, f.tipChatHandler(f.h.ListChatSessions), asUser(f.request("GET", nil), user)).Want(200).Text()
			if strings.Contains(list, session.ID) || strings.Contains(list, "private model input") {
				t.Fatal("revoked side chat retained source or preview in list")
			}
			history, err := f.h.chatMessageHistory(f.request("GET", nil), chatHistoryScope{sessionID: parseUUID(session.ID)})
			if !errors.Is(err, service.ErrProjectAccessDenied) || len(history.Messages) != 0 {
				t.Fatalf("revoked model history: %+v, %v", history, err)
			}
			body := testutil.Call(t, f.h.ClaimTaskByRuntime, f.request("POST", nil, "runtimeId", f.runtime)).Want(403).Text()
			if strings.Contains(body, "private model input") {
				t.Fatal("queued task disclosed old private context")
			}
		})
	}
}

func TestLabrastroPrivateProjectTipChatRejectsUnprivilegedAgentOwner(t *testing.T) {
	f := newTipChatFixture(t)
	f.Exec(t, "UPDATE agent_runtime SET visibility='public' WHERE id=$1", f.runtime)
	project := f.Project(t, "private source", testutil.Cols{"visibility": "private"})
	f.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
	owner := f.User(t, "external agent owner", uuid.NewString()+"@test.invalid")
	f.Member(t, f.WorkspaceID, owner, "member")
	f.Exec(t, "UPDATE agent SET owner_id=$2, visibility='workspace',permission_mode='public_to' WHERE id=$1", f.agent, owner)
	f.InsertNoID(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": "workspace", "target_id": f.WorkspaceID}, "agent_id=$1", f.agent)
	tip := f.tip(t, "owner must not receive")
	testutil.Call(t, f.h.LabrastroOpenTipChat, f.request("POST", nil, "tipId", tip)).Want(404)
	if f.Count(t, "SELECT count(*) FROM labrastro_tip_chat WHERE tip_id=$1", tip) != 0 {
		t.Fatal("denied agent owner still received a source snapshot")
	}
}
