package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestLabrastroYSKRealtimeScopes(t *testing.T) {
	bus := events.New()
	b := &fakeBroadcaster{}
	registerListeners(bus, b)
	for _, kind := range []string{protocol.EventCommentCreated, protocol.EventIssueTipCreated, protocol.EventIssueTipUpdated} {
		bus.Publish(events.Event{Type: kind, WorkspaceID: "ws", ActorType: "agent", ActorID: "agent", Payload: map[string]any{"tip": map[string]string{"id": "tip"}}})
	}
	if len(b.workspaceCalls) != 3 || len(b.userCalls) != 0 || b.broadcastCalled != 0 || len(b.scopeCalls) != 0 {
		t.Fatalf("tip events did not follow comment scope: %+v", b)
	}
	for _, call := range b.workspaceCalls {
		if call.workspaceID != "ws" {
			t.Fatalf("wrong workspace %s", call.workspaceID)
		}
	}
	bus.Publish(events.Event{
		Type: protocol.EventIssueTipStateChanged, WorkspaceID: "ws", ActorType: "member", ActorID: "alice",
		Payload: map[string]any{"workspace_id": "ws", "tip_id": "tip", "user_id": "alice", "state": "known"},
	})
	if len(b.workspaceCalls) != 3 || len(b.userCalls) != 1 || b.userCalls[0].userID != "alice" || len(b.userCalls[0].exclude) != 0 {
		t.Fatalf("personal state must reach only this user's sessions, including this workspace: %+v", b)
	}
	var frame map[string]any
	if err := json.Unmarshal(b.userCalls[0].msg, &frame); err != nil {
		t.Fatal(err)
	}
	if frame["type"] != protocol.EventIssueTipStateChanged {
		t.Fatalf("wrong event: %s", b.userCalls[0].msg)
	}
	bus.Publish(events.Event{Type: protocol.EventIssueTipStateChanged, WorkspaceID: "ws", Payload: map[string]any{"state": "known"}})
	if len(b.workspaceCalls) != 3 || len(b.userCalls) != 1 {
		t.Fatal("missing recipient must not fall back to a broadcast")
	}
}

func TestLabrastroYSKRouterRejectsTaskTokens(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	runtime := fx.Runtime(t, "YSK runtime")
	agent := fx.Agent(t, "YSK router agent", runtime)
	issue := fx.Issue(t, "YSK router isolation")
	task := fx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "issue_id": issue, "originator_user_id": testUserID, "accountable_user_id": testUserID, "originator_source": "direct_human"})
	tip := fx.Insert(t, "labrastro_issue_tip", testutil.Cols{
		"workspace_id": testWorkspaceID, "issue_id": issue, "task_id": task, "agent_id": agent,
		"tag": "you_should_know", "line": "Private tip", "title": "Title", "explanation": "Explanation",
	})
	token := mintAgentTaskToken(t, agent, task, testUserID)
	for _, tc := range []struct{ method, path string }{
		{"GET", fmt.Sprintf("/api/issues/%s/tips", issue)},
		{"GET", "/api/tips/active"},
		{"POST", fmt.Sprintf("/api/tips/%s/state", tip)},
		{"POST", fmt.Sprintf("/api/tips/%s/chat", tip)},
	} {
		req, err := http.NewRequest(tc.method, testServer.URL+tc.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		// Auth must replace client-forged actor identity with task_token.
		req.Header.Set("X-Actor-Source", "human")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, resp.StatusCode, body)
		}
	}
	resp := authRequest(t, "GET", fmt.Sprintf("/api/issues/%s/tips", issue), nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("human access: %d %s", resp.StatusCode, body)
	}
}
