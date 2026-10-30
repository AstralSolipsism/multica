package handler

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestGroupedInboxKeepsLatestRowAndCommentAnchor(t *testing.T) {
	ws := dbfx.Workspace(t, "Grouped inbox", "grouped-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	issue := dbfx.Issue(t, "Noisy issue", testutil.Cols{"workspace_id": ws, "status": "in_review", "priority": "high"})
	base := time.Now().UTC().Truncate(time.Microsecond)
	dbfx.Exec(t, `
		INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, issue_id, type, severity, title, body, read, created_at, details)
		SELECT $1, 'member', $2, $3, 'status_changed', 'info', 'row-' || i, 'body-' || i, i = 0,
		       $4::timestamptz - i * interval '1 microsecond',
		       CASE WHEN i IN (1, 189) THEN jsonb_build_object('comment_id', 'comment-' || i) ELSE '{}'::jsonb END
		FROM generate_series(0, 189) i`, ws, testUserID, issue, base)
	dbfx.Cleanup(t, `DELETE FROM inbox_item WHERE workspace_id = $1`, ws)
	// Neither archived rows nor another recipient may supply an anchor.
	for _, cols := range []testutil.Cols{
		{"archived": true}, {"recipient_id": uuid.NewString()}, {"recipient_type": "agent"},
	} {
		row := testutil.Cols{"workspace_id": ws, "recipient_id": testUserID, "recipient_type": "member",
			"issue_id": issue, "type": "new_comment", "severity": "info", "title": "excluded",
			"created_at": base.Add(time.Hour), "details": `{"comment_id":"excluded"}`}
		for k, v := range cols {
			row[k] = v
		}
		dbfx.Insert(t, "inbox_item", row)
	}
	get := func(path string) []InboxItemResponse {
		t.Helper()
		var rows []InboxItemResponse
		testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInbox), inboxRequest(http.MethodGet, path, ws)).Want(http.StatusOK).JSON(&rows)
		return rows
	}
	legacy := get("/api/inbox")
	grouped := get("/api/inbox?view=grouped")
	if len(legacy) != 190 || len(grouped) != 2 {
		t.Fatalf("raw=%d grouped=%d; want 190 -> 2", len(legacy), len(grouped))
	}
	if grouped[0].CreatedAt == grouped[1].CreatedAt {
		t.Fatal("lost sub-second ordering in the wire format")
	}
	if !reflect.DeepEqual(grouped, legacy[:2]) {
		t.Fatalf("grouped rows differ from latest notification and latest anchor: %+v", grouped)
	}
	if !grouped[0].Read || grouped[0].Title != "row-0" || *grouped[0].IssueStatus != "in_review" || *grouped[0].IssuePriority != "high" {
		t.Fatalf("lost latest row's state or issue projections: %+v", grouped[0])
	}
	var details map[string]string
	if err := json.Unmarshal(grouped[1].Details, &details); err != nil || details["comment_id"] != "comment-1" {
		t.Fatalf("wrong comment anchor: %s (%v)", grouped[1].Details, err)
	}
	if !reflect.DeepEqual(get("/api/inbox?view=unknown"), legacy) {
		t.Fatal("unknown views must retain the default raw contract")
	}
}

func TestGroupedInboxIsUnboundedAndMatchesUnreadSummary(t *testing.T) {
	ws := dbfx.Workspace(t, "Complete grouped inbox", "complete-inbox-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	base := time.Now().UTC().Truncate(time.Microsecond)
	// Issue-less rows each form a group; going past 200 catches an archive LIMIT.
	dbfx.Exec(t, `
		INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, type, severity, title, created_at)
		SELECT $1, 'member', $2, 'mentioned', 'info', 'standalone-' || i, $3
		FROM generate_series(1, 205) i`, ws, testUserID, base)
	dbfx.Cleanup(t, `DELETE FROM inbox_item WHERE workspace_id = $1`, ws)
	issue := dbfx.Issue(t, "Timestamp tie", testutil.Cols{"workspace_id": ws})
	for _, row := range []struct {
		id   string
		read bool
	}{
		{"00000000-0000-0000-0000-000000000001", false},
		{"ffffffff-ffff-ffff-ffff-ffffffffffff", true},
	} {
		dbfx.Insert(t, "inbox_item", testutil.Cols{
			"id": row.id, "workspace_id": ws, "recipient_type": "member", "recipient_id": testUserID,
			"issue_id": issue, "type": "mentioned", "severity": "info", "title": "tie",
			"created_at": base, "read": row.read, "details": `{"comment_id":"same-row-anchor"}`,
		})
	}
	var grouped []InboxItemResponse
	testutil.Call(t, inboxWorkspaceHandler(testHandler.ListInbox), inboxRequest(http.MethodGet, "/api/inbox?view=grouped", ws)).Want(http.StatusOK).JSON(&grouped)
	if len(grouped) != 206 || grouped[0].ID != "ffffffff-ffff-ffff-ffff-ffffffffffff" || !grouped[0].Read {
		t.Fatalf("missing groups or unstable newest row: len=%d first=%+v", len(grouped), grouped[0])
	}
	var summary []InboxWorkspaceUnreadResponse
	testutil.Call(t, testHandler.UnreadInboxSummary, inboxRequest(http.MethodGet, "/api/inbox/unread-summary", ws)).Want(http.StatusOK).JSON(&summary)
	for _, entry := range summary {
		if entry.WorkspaceID == ws && entry.Count == 205 {
			return
		}
	}
	t.Fatalf("summary does not match all 205 visible unread groups: %+v", summary)
}
