package handler

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Installed clients that predate v2 cannot echo condition or max_fires.
// Editing the instruction must not broaden a predicate or reset its cap.
func TestWakeupLegacyUpdatePreservesV2Fields(t *testing.T) {
	for _, predicate := range []bool{false, true} {
		name := "event"
		if predicate {
			name = "condition"
		}
		t.Run(name, func(t *testing.T) {
			issue := dbfx.Issue(t, "legacy wakeup update")
			t.Cleanup(func() { cleanupChildDoneIssue(issue) })
			agent := handlerTestAgentID(t)
			body := map[string]any{"agent_id": agent, "kind": "event", "mode": "continuous", "instruction": "before", "max_fires": 5}
			if predicate {
				body["condition"] = map[string]any{"type": "issue_field", "field": "status", "value": "in_review"}
			} else {
				body["event_types"] = []string{"comment.created"}
			}
			var before db.IssueWakeup
			testutil.Call(t, testHandler.CreateIssueWakeup, withURLParam(newRequest(http.MethodPost, "/", body), "id", issue)).Want(http.StatusCreated).JSON(&before)
			delete(body, "condition")
			delete(body, "max_fires")
			body["event_types"] = before.EventTypes
			body["instruction"] = "after"
			var after db.IssueWakeup
			req := withURLParams(newRequest(http.MethodPut, "/", body), "id", issue, "wakeupID", uuidToString(before.ID))
			testutil.Call(t, testHandler.CreateIssueWakeup, req).Want(http.StatusOK).JSON(&after)
			if !bytes.Equal(after.Condition, before.Condition) || after.MaxFires != before.MaxFires {
				t.Fatalf("legacy update changed condition %s -> %s or cap %+v -> %+v", before.Condition, after.Condition, before.MaxFires, after.MaxFires)
			}
			if after.Instruction != "after" || after.Revision != before.Revision+1 {
				t.Fatal("instruction update was not applied")
			}
			// Modern clients can deliberately replace the predicate and reset
			// the cap to the continuous-event default.
			body["condition"] = nil
			body["event_types"] = []string{"comment.created"}
			body["max_fires"] = 0
			req = withURLParams(newRequest(http.MethodPut, "/", body), "id", issue, "wakeupID", uuidToString(before.ID))
			testutil.Call(t, testHandler.CreateIssueWakeup, req).Want(http.StatusOK).JSON(&after)
			if string(after.Condition) != "null" || !after.MaxFires.Valid || after.MaxFires.Int32 != 20 {
				t.Fatalf("explicit replacement ignored: condition=%s cap=%+v", after.Condition, after.MaxFires)
			}

			// An uncapped pre-v2 subscription stays uncapped when an old
			// client edits it; the new default is for new/replaced caps.
			dbfx.Exec(t, "UPDATE issue_wakeup SET max_fires=NULL WHERE id=$1", before.ID)
			delete(body, "max_fires")
			req = withURLParams(newRequest(http.MethodPut, "/", body), "id", issue, "wakeupID", uuidToString(before.ID))
			testutil.Call(t, testHandler.CreateIssueWakeup, req).Want(http.StatusOK).JSON(&after)
			if after.MaxFires.Valid {
				t.Fatalf("legacy uncapped rule was capped: %+v", after.MaxFires)
			}
			// Presence tracking must not weaken strict boundary validation.
			body["preserve_max_fires"] = true
			req = withURLParams(newRequest(http.MethodPut, "/", body), "id", issue, "wakeupID", uuidToString(before.ID))
			testutil.Call(t, testHandler.CreateIssueWakeup, req).Want(http.StatusBadRequest)
		})
	}
}
