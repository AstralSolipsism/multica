package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// External conversation work that existed before 9066 must not keep or regain
// execution rights once the sandbox is gone. The fully migrated test database
// no longer stamps roots, so the fixture writes the pre-upgrade lineage that
// 551 recorded and then applies the real 9066 file over it.
func TestRetiredConversationWorkLosesExecutionAfterUpgrade(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	ctx := context.Background()
	grantor := fx.User(t, "Retired grantor", "retired-grantor@example.test")
	fx.Member(t, testWorkspaceID, grantor, "member")
	runtime := fx.Runtime(t, "retired conversation runtime")
	agent := fx.Agent(t, "retired conversation agent", runtime, testutil.Cols{"owner_id": grantor})
	running := testutil.Cols{"runtime_id": runtime, "status": "running", "originator_user_id": grantor, "accountable_user_id": grantor}
	root := fx.Task(t, agent, merge(running, testutil.Cols{"originator_source": "channel_integration"}))
	fx.Exec(t, "UPDATE agent_task_queue SET conversation_root_task_id=id WHERE id=$1", root)
	config := fmt.Sprintf(`{"app_id":"cli_retired","chat_id":"oc_retired","conversation":{"id":%q,"authorized_by":%q,"scope":"workspace","chats":[{"chat_id":"oc_retired","chat_type":"group"}]}}`, root, grantor)
	install := fx.Insert(t, "channel_installation", testutil.Cols{"workspace_id": testWorkspaceID, "agent_id": agent, "channel_type": "feishu", "installer_user_id": testUserID, "status": "active", "config": config})
	fx.InsertNoID(t, "channel_task_delivery", testutil.Cols{"task_id": root, "binding_id": root, "installation_id": install, "channel_type": "feishu", "channel_chat_id": "oc_retired", "chat_type": "group", "route_revision": 1, "config": config}, "task_id=$1", root)
	external := map[string]string{"root": root}
	for _, lineage := range []string{"delegation", "retry"} {
		cols := merge(running, testutil.Cols{"originator_source": lineage, "delegated_from_task_id": root, "conversation_root_task_id": root})
		if lineage == "retry" {
			cols["retry_of_task_id"] = root
		}
		external[lineage] = fx.Task(t, agent, cols)
	}
	queued := fx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "status": "queued", "originator_source": "delegation",
		"originator_user_id": grantor, "accountable_user_id": grantor, "delegated_from_task_id": root, "conversation_root_task_id": root})
	member := fx.Task(t, agent, merge(running, testutil.Cols{"originator_source": "direct_human"}))
	tokens := map[string]string{}
	for lineage, task := range external {
		tokens[lineage] = mintAgentTaskToken(t, agent, task, testUserID)
	}
	memberToken := mintAgentTaskToken(t, agent, member, testUserID)
	issue := fx.Issue(t, "Retired conversation boundary")

	migration, err := os.ReadFile("../../migrations/9066_labrastro_retire_conversation_provenance.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	fx.Exec(t, string(migration))

	edit := func(token string) (int, string) {
		t.Helper()
		comment := fx.Comment(t, issue, "Owner-authored protected text")
		req := testutil.WithHeaders(testutil.JSONRequest(http.MethodPut, "/api/comments/"+comment, map[string]any{"content": "changed by task token"}), "Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		testServer.Config.Handler.ServeHTTP(w, req)
		var body string
		if err := testPool.QueryRow(ctx, "SELECT content FROM comment WHERE id=$1", comment).Scan(&body); err != nil {
			t.Fatal(err)
		}
		return w.Code, body
	}
	for lineage, token := range tokens {
		t.Run(lineage, func(t *testing.T) {
			if code, body := edit(token); code != http.StatusUnauthorized || body != "Owner-authored protected text" {
				t.Fatalf("retired %s token: HTTP %d, persisted %q", lineage, code, body)
			}
		})
	}
	for _, task := range append([]string{queued}, external["root"], external["delegation"], external["retry"]) {
		var status string
		if err := testPool.QueryRow(ctx, "SELECT status FROM agent_task_queue WHERE id=$1", task).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "cancelled" {
			t.Fatalf("retired task %s is %s; a runtime could still claim or resume it", task, status)
		}
	}
	var grantKept bool
	var status string
	if err := testPool.QueryRow(ctx, "SELECT config ? 'conversation', status FROM channel_installation WHERE id=$1", install).Scan(&grantKept, &status); err != nil {
		t.Fatal(err)
	}
	if grantKept || status != "active" {
		t.Fatalf("installation after retirement: grant kept=%v status=%s; want revoked grant on an active bot", grantKept, status)
	}
	// Ordinary member work on the same agent and runtime keeps upstream authority.
	if code, body := edit(memberToken); code != http.StatusOK || body != "changed by task token" {
		t.Fatalf("member task token: HTTP %d, persisted %q", code, body)
	}
	var memberStatus string
	if err := testPool.QueryRow(ctx, "SELECT status FROM agent_task_queue WHERE id=$1", member).Scan(&memberStatus); err != nil || memberStatus != "running" {
		t.Fatalf("member task status = %q (%v), want running", memberStatus, err)
	}
}

func merge(base, extra testutil.Cols) testutil.Cols {
	out := testutil.Cols{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}
