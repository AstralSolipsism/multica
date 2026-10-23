package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// OL-1092: an external conversation task executes as its frozen grantor. A
// grantor holding the owner/admin role must not, through that role, edit
// another member's comment — the edit clears source_task_id and the derived
// run escapes the conversation root. First-party admins keep the ability;
// external tasks keep editing their own comments.
func TestConversationEditOthersCommentRejected(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	task := f.task(t)
	token := f.token(t, task)

	// The fixture's grantor (testUserID) owns the workspace, so without the
	// guard the external edit below would pass the admin branch.
	member := dbfx.User(t, "OL-1092 member", "ol1092-member@multica.ai")
	dbfx.Member(t, testWorkspaceID, member, "member")
	target := dbfx.Agent(t, "OL-1092 target", f.runtime)
	mention := fmt.Sprintf("[@Target](mention://agent/%s) please run this", target)
	commentID := dbfx.Comment(t, f.issue, "original member content", testutil.Cols{"author_type": "member", "author_id": member})
	// A queued run this comment already triggered must survive the rejected
	// edit: the guard returns before any cancellation side effect.
	triggered := dbfx.Task(t, target, testutil.Cols{"issue_id": f.issue, "trigger_comment_id": commentID, "runtime_id": f.runtime, "originator_source": "direct_human", "originator_user_id": member, "accountable_user_id": member})

	put := func(token, id, content string) *testutil.Response {
		req := httptest.NewRequest(http.MethodPut, "/api/comments/"+id, strings.NewReader(fmt.Sprintf(`{"content":%q}`, content)))
		req.Header.Set("Authorization", "Bearer "+token)
		router := chi.NewRouter()
		router.Use(middleware.Auth(f.h.Queries, nil, nil, nil))
		router.Put("/api/comments/{commentId}", f.h.UpdateComment)
		return testutil.Call(t, router.ServeHTTP, req)
	}

	put(token, commentID, mention).Want(http.StatusForbidden)
	var content string
	dbfx.QueryRow(t, `SELECT content FROM comment WHERE id=$1`, commentID).Scan(&content)
	if content != "original member content" {
		t.Fatalf("rejected edit mutated content: %q", content)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id=$1 AND id!=$2`, target, triggered); n != 0 {
		t.Fatalf("rejected edit enqueued %d tasks for mentioned agent", n)
	}
	var status string
	dbfx.QueryRow(t, `SELECT status FROM agent_task_queue WHERE id=$1`, triggered).Scan(&status)
	if status != "queued" {
		t.Fatalf("rejected edit cancelled the run this comment had triggered: %q", status)
	}

	// The same human, on first-party member credentials, still may edit.
	firstParty := newRequest(http.MethodPut, "/api/comments/"+commentID, map[string]any{"content": "admin edit"})
	firstParty = withURLParam(firstParty, "commentId", commentID)
	testutil.Call(t, f.h.UpdateComment, firstParty).Want(http.StatusOK)

	// The external task may still edit its own comment.
	own := dbfx.Comment(t, f.issue, "agent original", testutil.Cols{"author_type": "agent", "author_id": f.agent})
	put(token, own, "agent edited own comment").Want(http.StatusOK)
}
