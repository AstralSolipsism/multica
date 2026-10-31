package handler

import (
	"context"
	"net/http"
	"reflect"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestSendChatMessageIdempotency(t *testing.T) {
	agentID := createHandlerTestAgent(t, "ChatIdempotencyAgent", []byte("[]"))
	sessionID := createHandlerTestChatSession(t, agentID)
	key := uuidToString(dbid.NewV7())
	send := func(session, content, id string, status int) SendChatMessageResponse {
		t.Helper()
		req := newRequest("POST", "/api/chat/sessions/"+session+"/messages", map[string]any{
			"content": content, "client_message_id": id,
		})
		req = withChatTestWorkspaceCtx(t, withURLParam(req, "sessionId", session))
		var out SendChatMessageResponse
		response := testutil.Call(t, testHandler.SendChatMessage, req).Want(status)
		if status == http.StatusCreated {
			response.JSON(&out)
		}
		return out
	}
	var concurrent [8]SendChatMessageResponse
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range concurrent {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			concurrent[i] = send(sessionID, "same input", key, http.StatusCreated)
		}()
	}
	close(start)
	wg.Wait()
	first := concurrent[0]
	for _, got := range concurrent {
		if !reflect.DeepEqual(first, got) {
			t.Fatalf("concurrent receipts differ: first=%+v got=%+v", first, got)
		}
	}
	replay := send(sessionID, "same input", key, http.StatusCreated)
	if !reflect.DeepEqual(first, replay) {
		t.Fatalf("replay changed receipt: first=%+v replay=%+v", first, replay)
	}
	var tasks, messages int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM agent_task_queue WHERE chat_session_id = $1`, sessionID).Scan(&tasks); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM chat_message WHERE chat_session_id = $1 AND role = 'user'`, sessionID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if tasks != 1 || messages != 1 {
		t.Fatalf("replay persisted tasks=%d messages=%d, want 1 each", tasks, messages)
	}
	send(sessionID, "changed input", key, http.StatusConflict)
	send(sessionID, "same input", "invalid", http.StatusBadRequest)
	newSend := send(sessionID, "same input", uuidToString(dbid.NewV7()), http.StatusCreated)
	if newSend.TaskID == first.TaskID || !newSend.Queued {
		t.Fatalf("same text with a new key must queue new work: %+v", newSend)
	}
	legacyA := send(sessionID, "same input", "", http.StatusCreated)
	legacyB := send(sessionID, "same input", "", http.StatusCreated)
	if legacyA.TaskID == legacyB.TaskID {
		t.Fatal("legacy requests must retain their existing semantics")
	}
	other := send(createHandlerTestChatSession(t, agentID), "same input", key, http.StatusCreated)
	if other.TaskID == first.TaskID {
		t.Fatal("client keys must be scoped to the session")
	}
}
