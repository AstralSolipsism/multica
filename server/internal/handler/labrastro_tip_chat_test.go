package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/llm"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func (f *yskFixture) tipChatHandler(next http.HandlerFunc) http.HandlerFunc {
	return middleware.RequireWorkspaceMember(f.h.Queries)(next).ServeHTTP
}

func newTipChatFixture(t *testing.T) *yskFixture {
	t.Helper()
	f := newYSKFixture(t)
	f.h.TaskService = service.NewTaskService(f.h.Queries, testPool, f.h.Hub, f.h.Bus)
	f.Exec(t, `UPDATE agent SET max_concurrent_tasks=6 WHERE id=$1`, f.agent)
	f.Cleanup(t, `DELETE FROM labrastro_tip_chat WHERE workspace_id=$1`, f.WorkspaceID)
	f.Cleanup(t, `DELETE FROM chat_session WHERE workspace_id=$1`, f.WorkspaceID)
	f.Cleanup(t, `DELETE FROM agent_task_queue WHERE agent_id=$1`, f.agent)
	return f
}

func (f *yskFixture) openTipChat(t *testing.T, tipID string, status int) ChatSessionResponse {
	t.Helper()
	var out ChatSessionResponse
	testutil.Call(t, f.h.LabrastroOpenTipChat, f.request("POST", nil, "tipId", tipID)).Want(status).JSON(&out)
	return out
}

func (f *yskFixture) sendTipChat(t *testing.T, session, content string) SendChatMessageResponse {
	t.Helper()
	var out SendChatMessageResponse
	testutil.Call(t, f.tipChatHandler(f.h.SendChatMessage), f.request("POST", map[string]any{"content": content}, "sessionId", session)).Want(201).JSON(&out)
	return out
}

func TestLabrastroTipChatLifecycle(t *testing.T) {
	f := newTipChatFixture(t)
	project := f.Project(t, "Tip project")
	f.Exec(t, `UPDATE issue SET project_id=$2 WHERE id=$1`, f.issue, project)
	tip := f.tip(t, "one tip")
	session := f.openTipChat(t, tip, 201)
	if session.AgentID != f.agent || session.CreatorID != testUserID || session.ProjectID == nil || *session.ProjectID != project || session.Title != "YSK-1 · Title" {
		t.Fatalf("wrong chat identity: %+v", session)
	}
	if session.TipSource == nil || session.TipSource.TipID != tip || session.TipSource.IssueID != f.issue || session.TipSource.SourceTaskID != f.task || session.TipSource.Tip.Line != "one tip" {
		t.Fatalf("wrong source: %+v", session.TipSource)
	}
	if f.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1 AND role='user' AND message_kind='hidden_context' AND task_id IS NULL`, session.ID) != 1 ||
		f.Count(t, `SELECT count(*) FROM agent_task_queue WHERE chat_session_id=$1`, session.ID) != 0 ||
		f.Count(t, `SELECT count(*) FROM chat_session WHERE id=$1 AND explicitly_created_at IS NOT NULL`, session.ID) != 0 {
		t.Fatal("opening must write exactly one hidden input, no task or explicit marker")
	}
	var detail ChatSessionResponse
	testutil.Call(t, f.tipChatHandler(f.h.GetChatSession), f.request("GET", nil, "sessionId", session.ID)).Want(200).JSON(&detail)
	if detail.TipSource == nil || detail.TipSource.TipID != tip {
		t.Fatal("empty side chat must remain addressable with its source")
	}
	for _, status := range []string{"", "all"} {
		r := f.request("GET", nil)
		r.URL.RawQuery = "status=" + status
		var sessions []ChatSessionResponse
		testutil.Call(t, f.tipChatHandler(f.h.ListChatSessions), r).Want(200).JSON(&sessions)
		if len(sessions) != 0 {
			t.Fatalf("hidden-only chat appeared in list: %+v", sessions)
		}
	}
	for _, paged := range []bool{false, true} {
		r := f.request("GET", nil, "sessionId", session.ID)
		if paged {
			var page ChatMessagesPageResponse
			testutil.Call(t, f.tipChatHandler(f.h.ListChatMessagesPage), r).Want(200).JSON(&page)
			if len(page.Messages) != 0 || page.HasMore {
				t.Fatalf("hidden input in page: %+v", page)
			}
		} else {
			var messages []ChatMessageResponse
			testutil.Call(t, f.tipChatHandler(f.h.ListChatMessages), r).Want(200).JSON(&messages)
			if len(messages) != 0 {
				t.Fatal("hidden input in legacy list")
			}
		}
	}
	// Reopening does not refresh the original material or change tip state.
	f.Exec(t, `UPDATE labrastro_issue_tip SET status='overturned',overturned_reason='new evidence' WHERE id=$1`, tip)
	again := f.openTipChat(t, tip, 200)
	if again.ID != session.ID || again.TipSource.Tip.Status != "valid" {
		t.Fatal("reopen replaced the session or its snapshot")
	}
	testutil.Call(t, f.tipChatHandler(f.h.SetChatSessionArchived), f.request("PATCH", map[string]any{"archived": true}, "sessionId", session.ID)).Want(200)
	again = f.openTipChat(t, tip, 200)
	if again.ID != session.ID || again.Status != "active" {
		t.Fatal("archive was not reversed")
	}
	oldTask := f.Task(t, f.agent, testutil.Cols{"status": "completed", "runtime_id": f.runtime, "chat_session_id": session.ID})
	testutil.Call(t, f.tipChatHandler(f.h.DeleteChatSession), f.request("DELETE", nil, "sessionId", session.ID)).Want(204)
	if f.Count(t, `SELECT count(*) FROM labrastro_tip_chat WHERE chat_session_id=$1`, session.ID) != 0 ||
		f.Count(t, `SELECT count(*) FROM agent_task_queue WHERE id=$1 AND chat_session_id IS NULL`, oldTask) != 1 {
		t.Fatal("session delete must clear source and detach task")
	}
	recreated := f.openTipChat(t, tip, 201)
	if recreated.ID == session.ID || recreated.TipSource.Tip.Status != "overturned" {
		t.Fatal("deleted chat not recreated with a new snapshot")
	}
	if reopened := f.openTipChat(t, tip, 200); reopened.ID != recreated.ID {
		t.Fatal("recreated chat was not reused")
	}
	// A stale soft reference from another deletion path is recoverable too.
	f.Exec(t, `DELETE FROM chat_session WHERE id=$1`, recreated.ID)
	repaired := f.openTipChat(t, tip, 201)
	if repaired.ID == recreated.ID {
		t.Fatal("stale source reference was reused")
	}
	if reopened := f.openTipChat(t, tip, 200); reopened.ID != repaired.ID {
		t.Fatal("repaired source mapping did not reuse its new chat")
	}
	detail = ChatSessionResponse{}
	testutil.Call(t, f.tipChatHandler(f.h.GetChatSession), f.request("GET", nil, "sessionId", repaired.ID)).Want(200).JSON(&detail)
	if detail.TipSource == nil || detail.TipSource.TipID != tip || detail.TipSource.Tip.Status != "overturned" {
		t.Fatal("repaired chat detail lost its source")
	}
	if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip_state WHERE tip_id=$1`, tip) != 0 {
		t.Fatal("opening a chat changed the user's tip state")
	}
}

func TestLabrastroTipChatConcurrentOpens(t *testing.T) {
	f := newTipChatFixture(t)
	tip := f.tip(t, "concurrent")
	const n = 6
	results := make(chan *httptest.ResponseRecorder, n)
	var wg sync.WaitGroup
	for range n {
		wg.Go(func() {
			w := httptest.NewRecorder()
			f.h.LabrastroOpenTipChat(w, f.request("POST", nil, "tipId", tip))
			results <- w
		})
	}
	wg.Wait()
	close(results)
	created, id := 0, ""
	for w := range results {
		if w.Code != 200 && w.Code != 201 {
			t.Fatalf("concurrent open: %d %s", w.Code, w.Body.String())
		}
		if w.Code == 201 {
			created++
		}
		var session ChatSessionResponse
		if err := json.Unmarshal(w.Body.Bytes(), &session); err != nil {
			t.Fatal(err)
		}
		if id != "" && id != session.ID {
			t.Fatal("concurrent requests opened different chats")
		}
		id = session.ID
	}
	if created != 1 || f.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1`, id) != 1 {
		t.Fatal("concurrent open duplicated the hidden input or session")
	}
}

func TestLabrastroTipChatSourceRetentionAndCleanup(t *testing.T) {
	f := newTipChatFixture(t)
	tip := f.tip(t, "retained source")
	session := f.openTipChat(t, tip, 201)
	testutil.Call(t, f.h.DeleteIssue, f.request("DELETE", nil, "id", f.issue)).Want(204)
	var detail ChatSessionResponse
	testutil.Call(t, f.tipChatHandler(f.h.GetChatSession), f.request("GET", nil, "sessionId", session.ID)).Want(200).JSON(&detail)
	if detail.TipSource == nil || detail.TipSource.TipID != tip || detail.TipSource.Tip.Line != "retained source" {
		t.Fatal("deleting the issue lost the side chat's historical source")
	}
	testutil.Call(t, f.h.DeleteWorkspace, f.request("DELETE", nil, "id", f.WorkspaceID)).Want(204)
	if f.Count(t, `SELECT count(*) FROM labrastro_tip_chat WHERE workspace_id=$1`, f.WorkspaceID) != 0 ||
		f.Count(t, `SELECT count(*) FROM chat_session WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("workspace deletion left private side chat data")
	}
}

func TestLabrastroTipChatMemberRemovalClearsOnlyTheirSource(t *testing.T) {
	f := newTipChatFixture(t)
	user := f.User(t, "departing viewer", uuid.NewString()+"@example.test")
	member := f.Member(t, f.WorkspaceID, user, "member")
	f.Exec(t, `UPDATE agent SET visibility='workspace',permission_mode='public_to' WHERE id=$1`, f.agent)
	f.InsertNoID(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": "workspace", "target_id": f.WorkspaceID}, "agent_id=$1", f.agent)
	tip := f.tip(t, "member cleanup")
	f.openTipChat(t, tip, 201)
	r := f.request("POST", nil, "tipId", tip)
	r.Header.Set("X-User-ID", user)
	testutil.Call(t, f.h.LabrastroOpenTipChat, r).Want(201)
	testutil.Call(t, f.h.DeleteMember, f.request("DELETE", nil, "id", f.WorkspaceID, "memberId", member)).Want(204)
	if f.Count(t, `SELECT count(*) FROM labrastro_tip_chat WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, user) != 0 ||
		f.Count(t, `SELECT count(*) FROM labrastro_tip_chat WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, testUserID) != 1 {
		t.Fatal("member removal failed to scope private source cleanup")
	}
}

func TestLabrastroTipChatAccess(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		status     int
	}{
		{"private", "invocation_not_allowed", 403},
		{"archived", "agent_archived", 409},
		{"unbound", "agent_no_runtime", 409},
		{"private archived", "invocation_not_allowed", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTipChatFixture(t)
			tip := f.tip(t, "access")
			if strings.Contains(tc.name, "private") {
				other := f.User(t, "Other", uuid.NewString()+"@example.test")
				f.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, other)
			}
			if strings.Contains(tc.name, "archived") {
				f.Exec(t, `UPDATE agent SET archived_at=now() WHERE id=$1`, f.agent)
			}
			if tc.name == "unbound" {
				f.Exec(t, `UPDATE agent SET runtime_id=NULL WHERE id=$1`, f.agent)
			}
			var result map[string]string
			testutil.Call(t, f.h.LabrastroOpenTipChat, f.request("POST", nil, "tipId", tip)).Want(tc.status).JSON(&result)
			if result["code"] != tc.code || f.Count(t, `SELECT count(*) FROM labrastro_tip_chat WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
				t.Fatalf("wrong denial or writes: %v", result)
			}
		})
	}
	f := newTipChatFixture(t)
	tip := f.tip(t, "isolation")
	outsider := f.User(t, "Outsider", uuid.NewString()+"@example.test")
	r := f.request("POST", nil, "tipId", tip)
	r.Header.Set("X-User-ID", outsider)
	testutil.Call(t, f.h.LabrastroOpenTipChat, r).Want(404)
	r = f.request("POST", nil, "tipId", tip)
	r.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, f.h.LabrastroOpenTipChat, r).Want(403)
	r = f.request("POST", nil, "tipId", tip)
	r.Header.Set("X-Workspace-ID", testWorkspaceID)
	testutil.Call(t, f.h.LabrastroOpenTipChat, r).Want(404)
	testutil.Call(t, f.h.LabrastroOpenTipChat, f.request("POST", nil, "tipId", "invalid")).Want(400)
	// Separate members get separate chats, even for one shared tip.
	f.Member(t, f.WorkspaceID, outsider, "member")
	f.Exec(t, `UPDATE agent SET visibility='workspace',permission_mode='public_to' WHERE id=$1`, f.agent)
	f.InsertNoID(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": "workspace", "target_id": f.WorkspaceID}, "agent_id=$1", f.agent)
	one := f.openTipChat(t, tip, 201)
	r = f.request("POST", nil, "tipId", tip)
	r.Header.Set("X-User-ID", outsider)
	var two ChatSessionResponse
	testutil.Call(t, f.h.LabrastroOpenTipChat, r).Want(201).JSON(&two)
	if one.ID == two.ID || two.CreatorID != outsider {
		t.Fatal("members share a private side chat")
	}
	r = f.request("GET", nil, "sessionId", one.ID)
	r.Header.Set("X-User-ID", outsider)
	testutil.Call(t, f.tipChatHandler(f.h.GetChatSession), r).Want(403)
}

func TestLabrastroTipChatFirstTurnAndVisibility(t *testing.T) {
	f := newTipChatFixture(t)
	tip := f.tip(t, "unique tip material")
	var eventsSeen []string
	f.h.Bus.SubscribeAll(func(e events.Event) {
		encoded, _ := json.Marshal(e.Payload)
		eventsSeen = append(eventsSeen, string(encoded))
	})
	session := f.openTipChat(t, tip, 201)
	if len(eventsSeen) != 0 {
		t.Fatal("opening emitted realtime activity")
	}
	ctx := context.Background()
	hasPublic, err := f.h.Queries.ChatSessionHasPublicUserMessage(ctx, parseUUID(session.ID))
	if err != nil || hasPublic || f.h.labrastroAllowChatAutoTitle(ctx, parseUUID(session.ID)) {
		t.Fatal("hidden context affected user-message or title detection")
	}
	sent := f.sendTipChat(t, session.ID, "Tell me more")
	var hidden string
	f.QueryRow(t, `SELECT content FROM chat_message WHERE chat_session_id=$1 AND message_kind='hidden_context'`, session.ID).Scan(&hidden)
	input, err := f.h.Queries.ListChatInputMessages(ctx, parseUUID(sent.TaskID))
	if err != nil || len(input) != 2 || input[0].Content != hidden || input[1].Content != "Tell me more" {
		t.Fatalf("first input order: %+v %v", input, err)
	}
	pending, err := f.h.Queries.ListPendingChatTasksForSession(ctx, parseUUID(session.ID))
	if err != nil || len(pending) != 1 || pending[0].Content != "Tell me more" {
		t.Fatalf("queue preview exposed hidden input: %+v %v", pending, err)
	}
	var sessions []ChatSessionResponse
	testutil.Call(t, f.tipChatHandler(f.h.ListChatSessions), f.request("GET", nil)).Want(200).JSON(&sessions)
	if len(sessions) != 1 || sessions[0].Title != session.Title || sessions[0].LastMessage == nil || sessions[0].LastMessage.Content != "Tell me more" || sessions[0].TipSource == nil {
		t.Fatalf("visible session preview: %+v", sessions)
	}
	var claimed struct {
		Task AgentTaskResponse `json:"task"`
	}
	testutil.Call(t, f.h.ClaimTaskByRuntime, f.request("POST", nil, "runtimeId", f.runtime)).Want(200).JSON(&claimed)
	if claimed.Task.ID != sent.TaskID || claimed.Task.ChatMessage != hidden+"\n\nTell me more" || claimed.Task.YouShouldKnow != nil {
		t.Fatalf("claim did not carry exactly hidden context then user input: %+v", claimed.Task)
	}
	if strings.Contains(claimed.Task.Agent.Instructions, "unique tip material") {
		t.Fatal("tip material leaked into the agent instruction file")
	}
	// The agent may read its own hidden context back through chat history.
	history, err := f.h.chatMessageHistory(f.request("GET", nil), chatHistoryScope{sessionID: parseUUID(session.ID)})
	if err != nil || len(history.Messages) != 2 {
		t.Fatalf("agent history lost context: %+v %v", history, err)
	}
	next := f.sendTipChat(t, session.ID, "And then?")
	input, err = f.h.Queries.ListChatInputMessages(ctx, parseUUID(next.TaskID))
	if err != nil || len(input) != 1 || input[0].Content != "And then?" {
		t.Fatal("later turn adopted hidden context again")
	}
	for _, event := range eventsSeen {
		if strings.Contains(event, "unique tip material") || strings.Contains(event, "hidden_context") {
			t.Fatalf("hidden context reached realtime: %s", event)
		}
	}
	// Machine-readable list/detail responses must not discover tip snapshots.
	r := f.request("GET", nil, "sessionId", session.ID)
	r.Header.Set("X-Actor-Source", "task_token")
	var machine ChatSessionResponse
	testutil.Call(t, f.tipChatHandler(f.h.GetChatSession), r).Want(200).JSON(&machine)
	if machine.TipSource != nil {
		t.Fatal("tip source exposed to a machine credential")
	}
}

func TestLabrastroTipChatCancelAndEditKeepContext(t *testing.T) {
	for _, action := range []string{"", "edit", "remove"} {
		for _, queuedSuccessor := range []bool{false, true} {
			t.Run(action+"/successor="+map[bool]string{false: "no", true: "yes"}[queuedSuccessor], func(t *testing.T) {
				f := newTipChatFixture(t)
				session := f.openTipChat(t, f.tip(t, "cancel context"), 201)
				first := f.sendTipChat(t, session.ID, "first prompt")
				var next SendChatMessageResponse
				if queuedSuccessor {
					next = f.sendTipChat(t, session.ID, "next prompt")
				}
				r := f.request("POST", nil, "taskId", first.TaskID)
				if action != "" {
					r.URL.RawQuery = url.Values{"expected_status": {"queued"}, "chat_session_id": {session.ID}, "queue_action": {action}}.Encode()
				}
				testutil.Call(t, f.tipChatHandler(f.h.CancelTaskByUser), r).Want(200)
				if f.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1 AND message_kind='hidden_context'`, session.ID) != 1 {
					t.Fatal("cancellation deleted hidden context")
				}
				if f.Count(t, `SELECT count(*) FROM chat_draft_restore WHERE chat_session_id=$1 AND content LIKE '%cancel context%'`, session.ID) != 0 {
					t.Fatal("restored internal material to the composer")
				}
				if !queuedSuccessor {
					next = f.sendTipChat(t, session.ID, "next prompt")
				}
				input, err := f.h.Queries.ListChatInputMessages(context.Background(), parseUUID(next.TaskID))
				if err != nil || len(input) != 2 || input[0].MessageKind != protocol.ChatMessageKindHiddenContext || input[1].Content != "next prompt" {
					t.Fatalf("context not handed to next turn: %+v %v", input, err)
				}
			})
		}
	}
}

func TestLabrastroTipChatSendPreservesHiddenContextTitles(t *testing.T) {
	for _, kind := range []string{"tip", "mika"} {
		t.Run(kind, func(t *testing.T) {
			f := newTipChatFixture(t)
			const generatedTitle = "Generated by the title model"
			stub := stubLLMCompletion(t, http.StatusOK, generatedTitle)
			f.h.LLM = llm.New(llm.Config{APIKey: "test-key", BaseURL: stub.URL})
			var sessionID, originalTitle string
			if kind == "tip" {
				session := f.openTipChat(t, f.tip(t, "title protection"), 201)
				sessionID, originalTitle = session.ID, session.Title
			} else {
				originalTitle = "Meet Mika"
				sessionID = f.ChatSession(t, f.agent, testutil.Cols{"title": originalTitle})
				session, err := f.h.Queries.GetChatSession(context.Background(), parseUUID(sessionID))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.h.TaskService.OpenMikaOnboardingChat(context.Background(), session, "Hidden Mika context", "Welcome to your workspace"); err != nil {
					t.Fatal(err)
				}
			}
			control := f.ChatSession(t, f.agent, testutil.Cols{"explicitly_created_at": testutil.Raw("now()")})
			updated := make(chan protocol.ChatSessionUpdatedPayload, 4)
			f.h.Bus.Subscribe(protocol.EventChatSessionUpdated, func(e events.Event) {
				if p, ok := e.Payload.(protocol.ChatSessionUpdatedPayload); ok {
					select {
					case updated <- p:
					default:
					}
				}
			})
			f.sendTipChat(t, sessionID, "Help me understand this")
			f.sendTipChat(t, control, "A normal conversation that should get a title")
			// Observe a successful asynchronous title write through the same send
			// path before checking the protected title; no fixed settling sleep.
			deadline := time.NewTimer(5 * time.Second)
			defer deadline.Stop()
			controlUpdated := false
			for !controlUpdated {
				select {
				case p := <-updated:
					controlUpdated = p.ChatSessionID == control && p.Title == generatedTitle
				case <-deadline.C:
					t.Fatal("ordinary first send did not complete LLM title generation")
				}
			}
			if got := chatSessionTitleFromDB(t, parseUUID(control)); got != generatedTitle {
				t.Fatalf("ordinary title = %q, want %q", got, generatedTitle)
			}
			if got := chatSessionTitleFromDB(t, parseUUID(sessionID)); got != originalTitle {
				t.Fatalf("%s title changed after first send: got %q, want %q", kind, got, originalTitle)
			}
		})
	}
}

func TestLabrastroTipChatMaterialIsBoundedAndScoped(t *testing.T) {
	for _, tc := range []struct {
		name, source, taskStatus string
		anchored                 bool
	}{
		{"description/running", "描", "running", false},
		{"comment/running", "锚", "running", true},
		{"description/completed", "描", "completed", false},
		{"comment/completed", "锚", "completed", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTipChatFixture(t)
			f.Exec(t, `UPDATE issue SET description=$2 WHERE id=$1`, f.issue, strings.Repeat("描", 500)+"🚫description tail")
			f.Exec(t, `UPDATE comment SET content=$2 WHERE id=$1`, f.comment, strings.Repeat("锚", 500)+"🚫comment tail")
			f.Exec(t, `UPDATE agent_task_queue SET status=$2 WHERE id=$1`, f.task, tc.taskStatus)
			f.tip(t, "UNRELATED_TIP")
			f.Exec(t, `INSERT INTO labrastro_known_topic(workspace_id,user_id,topic) VALUES ($1,$2,'PRIVATE_KNOWN_TOPIC')`, f.WorkspaceID, testUserID)
			anchor := any(nil)
			if tc.anchored {
				anchor = f.comment
			}
			tip := f.tip(t, "invalid tip", testutil.Cols{"anchor_comment_id": anchor, "status": "overturned", "overturned_reason": "new evidence", "overturned_by_comment_id": f.comment})
			session := f.openTipChat(t, tip, 201)
			var material string
			f.QueryRow(t, `SELECT content FROM chat_message WHERE chat_session_id=$1`, session.ID).Scan(&material)
			_, packet, ok := strings.Cut(material, "\nTip material (quoted data):\n")
			if !ok {
				t.Fatal("opening is missing its quoted source packet")
			}
			var source struct {
				AnchorExcerpt string `json:"anchor_excerpt"`
				TaskStatus    string `json:"source_task_status_at_open"`
				TaskRunning   *bool  `json:"source_task_running_at_open"`
			}
			if err := json.Unmarshal([]byte(packet), &source); err != nil {
				t.Fatal(err)
			}
			if source.AnchorExcerpt != strings.Repeat(tc.source, 500) {
				t.Fatalf("wrong source or excerpt boundary: %q", source.AnchorExcerpt)
			}
			if source.TaskStatus != tc.taskStatus || source.TaskRunning == nil || *source.TaskRunning != (tc.taskStatus == "running") {
				t.Fatalf("wrong source run snapshot: %+v", source)
			}
			for _, want := range []string{f.task, f.comment, "new evidence", "Do not proactively edit code", "cannot interject"} {
				if !strings.Contains(material, want) {
					t.Fatalf("missing material %q", want)
				}
			}
			for _, absent := range []string{"🚫", "UNRELATED_TIP", "PRIVATE_KNOWN_TOPIC"} {
				if strings.Contains(material, absent) {
					t.Fatalf("out-of-scope material %q", absent)
				}
			}
		})
	}
}

func TestLabrastroTipChatDeletedAnchorRemainsOpenable(t *testing.T) {
	f := newTipChatFixture(t)
	tip := f.tip(t, "old advice", testutil.Cols{"status": "source_changed"})
	f.Exec(t, `UPDATE comment SET deleted_at=now() WHERE id=$1`, f.comment)
	session := f.openTipChat(t, tip, 201)
	if session.TipSource == nil || session.TipSource.Tip.Status != "source_changed" {
		t.Fatal("deleted anchor lost the invalid tip's source status")
	}
	var material string
	f.QueryRow(t, `SELECT content FROM chat_message WHERE chat_session_id=$1`, session.ID).Scan(&material)
	if !strings.Contains(material, `"anchor_excerpt": "[The source comment was deleted or is unavailable.]"`) {
		t.Fatal("deleted anchor must use the unavailable-source placeholder")
	}
	if strings.Contains(material, "Human context") {
		t.Fatal("opening exposed the deleted comment's content")
	}
}

func TestLabrastroTipChatPaginationSkipsHiddenRowsBeforeLimit(t *testing.T) {
	f := newTipChatFixture(t)
	session := f.openTipChat(t, f.tip(t, "pagination"), 201)
	for _, value := range []struct{ kind, content string }{
		{"message", "one"}, {"hidden_context", "hidden two"}, {"message", "two"}, {"onboarding_kickoff", "hidden three"}, {"message", "three"},
	} {
		f.Insert(t, "chat_message", testutil.Cols{"chat_session_id": session.ID, "role": "user", "message_kind": value.kind, "content": value.content})
	}
	var cursor *ChatMessagesCursorResponse
	for _, want := range []string{"three", "two", "one"} {
		r := f.request("GET", nil, "sessionId", session.ID)
		params := url.Values{"limit": {"1"}}
		if cursor != nil {
			params.Set("before_created_at", cursor.CreatedAt)
			params.Set("before_id", cursor.ID)
		}
		r.URL.RawQuery = params.Encode()
		var page ChatMessagesPageResponse
		testutil.Call(t, f.tipChatHandler(f.h.ListChatMessagesPage), r).Want(200).JSON(&page)
		if len(page.Messages) != 1 || page.Messages[0].Content != want || page.HasMore != (want != "one") {
			t.Fatalf("page for %s: %+v", want, page)
		}
		cursor = page.NextCursor
	}
}
