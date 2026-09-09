package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type mdRecordPage struct {
	Deliveries   []db.ListLabrastroMessageDeliveriesByAutopilotRow `json:"deliveries"`
	AppliedRunID json.RawMessage                                   `json:"applied_run_id"`
	Limit        int32                                             `json:"limit"`
	Offset       int32                                             `json:"offset"`
}

func mdReadPage(t *testing.T, autopilotID, query string) mdRecordPage {
	t.Helper()
	req := withURLParams(newRequest("GET", "/api/autopilots/"+autopilotID+"/message-deliveries"+query, nil), "id", autopilotID)
	var page mdRecordPage
	testutil.Call(t, testHandler.ListMessageDeliveries, req).Want(http.StatusOK).JSON(&page)
	return page
}

// Seed the persisted decision, not the sender: listing must also work when
// the worker is offline, and no read may cause an external send.
func mdRecord(t *testing.T, fx mdFixture, workspaceID string, runID any, target, status, kind string, createdAt time.Time) string {
	t.Helper()
	return dbfx.Insert(t, "labrastro_message_delivery", testutil.Cols{
		"id":               testutil.Raw("gen_random_uuid()"),
		"workspace_id":     workspaceID,
		"autopilot_id":     fx.autopilotID,
		"installation_id":  fx.installID,
		"run_id":           runID,
		"dedup_key":        testutil.Raw("gen_random_uuid()::text"),
		"target_key":       target,
		"source_kind":      kind,
		"status":           status,
		"content_snapshot": testutil.Raw(`'{"text":"frozen report"}'::jsonb`),
		"target_snapshot":  testutil.Raw("'{}'::jsonb"),
		"created_at":       createdAt,
	})
}

func TestMessageDeliveries_RunFilterBeyondFirstPage(t *testing.T) {
	fx := newMDFixture(t, "run-filter", "run_only")
	baseTime := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	runs := make([]string, 30)
	for i := range runs {
		runs[i] = dbfx.Insert(t, "autopilot_run", testutil.Cols{
			"autopilot_id": fx.autopilotID, "source": "schedule", "status": "completed",
		})
		kind := "run_only"
		if i%2 == 1 {
			kind = "create_issue"
		}
		for j, status := range []string{"sent", "failed"} {
			mdRecord(t, fx, testWorkspaceID, runs[i], fmt.Sprintf("group:target-%d", j), status, kind, baseTime.Add(time.Duration(i)*time.Minute))
		}
	}
	// A diagnostic has no run and must remain visible only without the filter.
	diagnosticID := mdRecord(t, fx, testWorkspaceID, nil, "group:diagnostic", "sent", "test_send", baseTime.Add(time.Hour))
	first := mdReadPage(t, fx.autopilotID, "")
	if len(first.Deliveries) != 50 || string(first.AppliedRunID) != "null" || util.UUIDToString(first.Deliveries[0].ID) != diagnosticID {
		t.Fatalf("unfiltered page: rows=%d applied=%s", len(first.Deliveries), first.AppliedRunID)
	}
	for _, row := range first.Deliveries {
		if util.UUIDToString(row.RunID) == runs[0] {
			t.Fatal("fixture must place the oldest run outside the global first page")
		}
	}
	for _, runID := range runs {
		page := mdReadPage(t, fx.autopilotID, "?run_id="+runID)
		if len(page.Deliveries) != 2 || string(page.AppliedRunID) != `"`+runID+`"` {
			t.Fatalf("run %s: rows=%d applied=%s", runID, len(page.Deliveries), page.AppliedRunID)
		}
		for _, row := range page.Deliveries {
			if util.UUIDToString(row.RunID) != runID {
				t.Fatalf("run %s includes another source: %+v", runID, row)
			}
		}
	}
	filtered := mdReadPage(t, fx.autopilotID, "?run_id="+runs[0]+"&status=failed")
	if len(filtered.Deliveries) != 1 || filtered.Deliveries[0].Status != "failed" || util.UUIDToString(filtered.Deliveries[0].RunID) != runs[0] {
		t.Fatalf("run and status must intersect: %+v", filtered)
	}
	unknown := mdReadPage(t, fx.autopilotID, "?run_id=00000000-0000-0000-0000-000000000000")
	if len(unknown.Deliveries) != 0 || string(unknown.AppliedRunID) != `"00000000-0000-0000-0000-000000000000"` {
		t.Fatalf("empty supported filter must still be echoed: %+v", unknown)
	}
}

func TestMessageDeliveries_RunFilterPaginationAndTies(t *testing.T) {
	fx := newMDFixture(t, "run-pages", "run_only")
	runID := dbfx.Insert(t, "autopilot_run", testutil.Cols{
		"autopilot_id": fx.autopilotID, "source": "schedule", "status": "completed",
	})
	createdAt := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	ids := make([]string, 251)
	for i := range ids {
		ids[i] = mdRecord(t, fx, testWorkspaceID, runID, fmt.Sprintf("group:page-%d", i), "sent", "run_only", createdAt)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ids)))
	// Run-scoped and global pagination use the same deterministic ordering.
	for _, scope := range []string{"", "run_id=" + runID + "&"} {
		for offset := 0; offset < len(ids); offset += 100 {
			page := mdReadPage(t, fx.autopilotID, fmt.Sprintf("?%slimit=100&offset=%d", scope, offset))
			want := min(100, len(ids)-offset)
			if len(page.Deliveries) != want || page.Limit != 100 || page.Offset != int32(offset) {
				t.Fatalf("offset %d: rows=%d limit=%d offset=%d", offset, len(page.Deliveries), page.Limit, page.Offset)
			}
			for i, row := range page.Deliveries {
				if util.UUIDToString(row.ID) != ids[offset+i] {
					t.Fatalf("unstable ordering at record %d: got %s want %s", offset+i+1, util.UUIDToString(row.ID), ids[offset+i])
				}
			}
		}
	}
	last := mdReadPage(t, fx.autopilotID, "?run_id="+runID+"&limit=100&offset=300")
	if len(last.Deliveries) != 0 || string(last.AppliedRunID) != `"`+runID+`"` {
		t.Fatalf("end of run pages: %+v", last)
	}
	legacyLimit := mdReadPage(t, fx.autopilotID, "?run_id="+runID+"&limit=250")
	if legacyLimit.Limit != 50 || len(legacyLimit.Deliveries) != 50 {
		t.Fatal("run filter must preserve the existing oversized-limit fallback")
	}
}

func TestMessageDeliveries_RunFilterValidationAndScope(t *testing.T) {
	fx := newMDFixture(t, "run-scope", "run_only")
	other := newMDFixture(t, "other-run-scope", "run_only")
	runID := dbfx.Insert(t, "autopilot_run", testutil.Cols{
		"autopilot_id": other.autopilotID, "source": "schedule", "status": "completed",
	})
	mdRecord(t, other, testWorkspaceID, runID, "group:other", "sent", "run_only", time.Now())
	// Even a mismatched persisted workspace/autopilot pair cannot bypass
	// the list's workspace predicate. This schema deliberately has no FKs.
	otherWS := dbfx.Workspace(t, "Other delivery workspace", fmt.Sprintf("md-scope-%d", time.Now().UnixNano()))
	mdRecord(t, fx, otherWS, runID, "group:foreign", "sent", "run_only", time.Now())
	page := mdReadPage(t, fx.autopilotID, "?run_id="+runID)
	if len(page.Deliveries) != 0 || string(page.AppliedRunID) != `"`+runID+`"` {
		t.Fatalf("filter escaped its workspace/automation: %+v", page)
	}
	for _, value := range []string{"", "not-a-uuid", "null"} {
		req := withURLParams(newRequest("GET", "/api/autopilots/"+fx.autopilotID+"/message-deliveries?run_id="+value, nil), "id", fx.autopilotID)
		resp := testutil.Call(t, testHandler.ListMessageDeliveries, req).Want(http.StatusBadRequest)
		if !strings.Contains(resp.Body.String(), "invalid run_id") {
			t.Fatalf("invalid run filter: %s", resp.Body.String())
		}
	}
	reader := plainMember(t, "delivery-run-reader")
	req := withURLParams(newRequestAs(reader, "GET", "/api/autopilots/"+fx.autopilotID+"/message-deliveries?run_id="+runID, nil), "id", fx.autopilotID)
	testutil.Call(t, testHandler.ListMessageDeliveries, req).Want(http.StatusForbidden)
	req = withURLParams(newRequest("GET", "/api/autopilots/"+fx.autopilotID+"/message-deliveries?run_id="+runID, nil), "id", fx.autopilotID)
	req.Header.Set("X-Workspace-ID", otherWS)
	testutil.Call(t, testHandler.ListMessageDeliveries, req).Want(http.StatusNotFound)
}
