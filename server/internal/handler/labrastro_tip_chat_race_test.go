package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestLabrastroTipChatOpenLosesToMemberRevocation(t *testing.T) {
	f := newTipChatFixture(t)
	user := f.User(t, "departing agent owner", uuid.NewString()+"@example.test")
	f.Member(t, f.WorkspaceID, user, "member")
	// The member owns the agent, but its runtime belongs to the workspace
	// owner. Revocation therefore cannot rely on runtime-based agent archival
	// or the owner invocation shortcut to reject this request.
	f.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, user)
	tip := f.tip(t, "revocation must win")
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := f.h.Queries.WithTx(tx)
	if err := q.LockSubscriberWrites(ctx, db.LockSubscriberWritesParams{WorkspaceID: parseUUID(f.WorkspaceID), UserID: parseUUID(user)}); err != nil {
		t.Fatal(err)
	}
	if err := q.LabrastroYSKDeleteMember(ctx, db.LabrastroYSKDeleteMemberParams{WorkspaceID: parseUUID(f.WorkspaceID), UserID: parseUUID(user)}); err != nil {
		t.Fatal(err)
	}
	r := f.request("POST", nil, "tipId", tip)
	r.Header.Set("X-User-ID", user)
	yskAssertBlockedRequest(t, tx, f.h.LabrastroOpenTipChat, r, func() {
		if _, err := tx.Exec(ctx, `DELETE FROM member WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, user); err != nil {
			t.Fatal(err)
		}
	}, http.StatusNotFound)
	if f.Count(t, `SELECT count(*) FROM labrastro_tip_chat WHERE workspace_id=$1`, f.WorkspaceID) != 0 ||
		f.Count(t, `SELECT count(*) FROM chat_session WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("revoked member created a side chat or source mapping")
	}
}

func TestLabrastroTipChatOpenDetectsConcurrentProjectChange(t *testing.T) {
	f := newTipChatFixture(t)
	original := f.Project(t, "Original project")
	replacement := f.Project(t, "Replacement project")
	f.Exec(t, `UPDATE issue SET project_id=$2 WHERE id=$1`, f.issue, original)
	tip := f.tip(t, "project changed while opening")
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := f.h.Queries.WithTx(tx)
	if _, err := q.LockIssueForDelete(ctx, db.LockIssueForDeleteParams{WorkspaceID: parseUUID(f.WorkspaceID), ID: parseUUID(f.issue)}); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler := func(w http.ResponseWriter, r *http.Request) {
		f.h.LabrastroOpenTipChat(response, r)
		w.WriteHeader(response.Code)
	}
	yskAssertBlockedRequest(t, tx, handler, f.request("POST", nil, "tipId", tip), func() {
		if _, err := tx.Exec(ctx, `UPDATE issue SET project_id=$2 WHERE id=$1`, f.issue, replacement); err != nil {
			t.Fatal(err)
		}
	}, http.StatusConflict)
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "tip_source_changed" {
		t.Fatalf("project-change reason = %q", body.Code)
	}
	if f.Count(t, `SELECT count(*) FROM labrastro_tip_chat WHERE workspace_id=$1`, f.WorkspaceID) != 0 ||
		f.Count(t, `SELECT count(*) FROM chat_session WHERE workspace_id=$1`, f.WorkspaceID) != 0 {
		t.Fatal("conflicted open left a side chat or source mapping")
	}
	if session := f.openTipChat(t, tip, 201); session.ProjectID == nil || *session.ProjectID != replacement {
		t.Fatal("retry did not use the issue's new project")
	}
}
