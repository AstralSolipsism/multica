package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// This is the canonical derivation matrix. HTTP tests below cover persistence,
// request validation, authorization and the absence of side effects.
func TestWebhookDeliveryFilterContext(t *testing.T) {
	tests := []struct {
		name, body, headers, event, reason string
		actions                            []string
	}{
		{name: "github headers and all candidates", headers: `{"x-github-event":"workflow_run"}`,
			body:  `{"action":"completed","state":" queued ","conclusion":"success","status":"waiting"}`,
			event: "workflow_run", actions: []string{"completed", "queued", "success", "waiting"}},
		{name: "gitlab headers", headers: `{"x-gitlab-event":"Merge Request Hook"}`,
			body: `{"state":"opened"}`, event: "Merge Request Hook", actions: []string{"opened"}},
		{name: "bitbucket prefix", body: `{"event":"bitbucket.pullrequest.created","eventPayload":{}}`,
			event: "pullrequest", actions: []string{"created"}},
		{name: "gitea prefix", body: `{"event":"gitea.issues.closed","eventPayload":null}`,
			event: "issues", actions: []string{"closed"}},
		{name: "unqualified without actions", body: `{"event":"custom","eventPayload":{}}`, event: "custom"},
		{name: "unknown prefix and multi-part suffix", body: `{"event":"stripe.charge.succeeded","eventPayload":{}}`,
			event: "stripe", actions: []string{"charge.succeeded"}},
		{name: "known prefix and multi-part suffix", body: `{"event":"github.check_suite.completed.success","eventPayload":{}}`,
			event: "check_suite", actions: []string{"completed.success"}},
		{name: "envelope payload only and dedupe", body: `{"event":"github.workflow_run.completed","action":"outside","eventPayload":{"action":" completed ","status":"completed","state":null,"conclusion":false,"workflow_run":{"conclusion":"nested"}}}`,
			event: "workflow_run", actions: []string{"completed"}},
		{name: "no arbitrary or non-string fields", body: `{"event":"custom","eventPayload":{"action":12,"status":["success"],"state":" ","conclusion":{},"nested":{"action":"opened"},"type":"ignored"}}`, event: "custom"},
		{name: "array payload", body: `[{"action":"nested"}]`, event: "webhook", actions: []string{"received"}},
		{name: "scalar envelope payload", body: `{"event":"custom","eventPayload":"opened"}`, event: "custom"},
		{name: "null envelope payload", body: `{"event":"custom","eventPayload":null}`, event: "custom"},
		{name: "case preserved", body: `{"event":"Custom.Done","eventPayload":{"action":"done"}}`, event: "Custom", actions: []string{"Done", "done"}},
		{name: "missing raw body", reason: "raw_body_missing"},
		{name: "invalid json", body: `{broken`, reason: "raw_body_invalid"},
		{name: "invalid scalar raw body", body: `42`, reason: "raw_body_invalid"},
		{name: "invalid null raw body", body: `null`, reason: "raw_body_invalid"},
		{name: "empty event name", body: `{"event":"github","eventPayload":{}}`, reason: "event_empty"},
		{name: "whitespace event name", body: `{"event":" ","eventPayload":{}}`, reason: "event_empty"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			delivery := db.WebhookDelivery{
				// Match the worker's normalization, not potentially stale metadata.
				Event: "stale.metadata", RawBody: []byte(tt.body), SelectedHeaders: []byte(tt.headers),
			}
			got := webhookDeliveryFilterContext(delivery, nil)
			if got.Matches != nil || got.UnavailableReason != tt.reason {
				t.Fatalf("context = %+v, want no preview and reason %q", got, tt.reason)
			}
			if tt.reason != "" {
				if got.Suggestion != nil {
					t.Fatalf("unavailable context must not suggest a filter: %+v", got)
				}
			} else {
				if got.Suggestion == nil || got.Suggestion.Event != tt.event || !slices.Equal(got.Suggestion.Actions, tt.actions) {
					t.Fatalf("suggestion = %+v, want event %q / actions %v", got.Suggestion, tt.event, tt.actions)
				}
				filters, err := json.Marshal([]WebhookEventFilter{*got.Suggestion})
				if err != nil {
					t.Fatal(err)
				}
				preview := webhookDeliveryFilterContext(delivery, filters)
				if preview.Matches == nil || !*preview.Matches {
					t.Fatalf("suggestion must match its delivery: %+v", preview)
				}
				if len(tt.actions) == 0 {
					got.Suggestion.Actions = []string{"opened"}
					filters, err = json.Marshal([]WebhookEventFilter{*got.Suggestion})
					if err != nil {
						t.Fatal(err)
					}
					preview = webhookDeliveryFilterContext(delivery, filters)
					if preview.Matches == nil || *preview.Matches {
						t.Fatal("a delivery without candidates cannot match a restrictive action list")
					}
				}
			}
			preview := webhookDeliveryFilterContext(delivery, []byte(`[]`))
			if tt.reason == "raw_body_missing" || tt.reason == "raw_body_invalid" {
				if preview.Matches != nil {
					t.Fatal("missing/invalid raw body must return unknown, even for an unrestricted draft")
				}
			} else if preview.Matches == nil || !*preview.Matches {
				t.Fatal("an unrestricted draft must match every normalizable delivery")
			}
		})
	}
}

func webhookFilterFixture(t *testing.T, workspaceID string) (autopilotID, triggerID string) {
	t.Helper()
	agentID := dbfx.Agent(t, "Webhook filter "+uuidToString(dbid.NewV7()), "", testutil.Cols{"workspace_id": workspaceID})
	autopilotID = dbfx.Insert(t, "autopilot", testutil.Cols{
		"workspace_id": workspaceID, "title": "Webhook filter fixture", "assignee_id": agentID,
		"created_by_type": "member", "created_by_id": testUserID, "status": "paused",
	})
	triggerID = dbfx.Insert(t, "autopilot_trigger", testutil.Cols{
		"autopilot_id": autopilotID, "kind": "webhook", "webhook_token": "filter-test-" + autopilotID,
		"event_filters": `[{"event":"existing"}]`, "created_by_type": "member", "created_by_id": testUserID,
	})
	return
}

func webhookFilterRequest(autopilotID, deliveryID, query string) *http.Request {
	req := newRequest("GET", "/api/autopilots/"+autopilotID+"/deliveries/"+deliveryID+query, nil)
	return withURLParams(req, "id", autopilotID, "deliveryId", deliveryID)
}

func TestGetDelivery_FilterPreviewStoredIngress(t *testing.T) {
	apID, triggerID := webhookFilterFixture(t, testWorkspaceID)
	request := testutil.JSONRequest("POST", "/api/webhooks/autopilots/filter-test-"+apID,
		`{"action":"completed","conclusion":"success","nested":{"action":"failure"}}`)
	request = testutil.WithURLParams(request, "token", "filter-test-"+apID)
	request.Header.Set("X-GitHub-Event", "workflow_run")
	receipt := testutil.Call(t, testHandler.HandleAutopilotWebhook, request).Want(http.StatusOK).Map()
	deliveryID := receipt["delivery_id"].(string)
	dbfx.Cleanup(t, `DELETE FROM webhook_delivery WHERE id = $1`, deliveryID)

	// Snapshot the persisted records and counts: previews may not save filters,
	// change delivery status, replay, or create an autopilot/agent run.
	snapshot := func() string {
		var value string
		dbfx.QueryRow(t, `SELECT jsonb_build_array(to_jsonb(d), to_jsonb(tr), to_jsonb(ap),
			(SELECT count(*) FROM webhook_delivery WHERE autopilot_id = ap.id),
			(SELECT count(*) FROM autopilot_run WHERE autopilot_id = ap.id),
			(SELECT count(*) FROM agent_task_queue WHERE agent_id = ap.assignee_id))::text
			FROM webhook_delivery d JOIN autopilot_trigger tr ON tr.id = d.trigger_id
			JOIN autopilot ap ON ap.id = d.autopilot_id WHERE d.id = $1`, deliveryID).Scan(&value)
		return value
	}
	before := snapshot()
	var detail WebhookDeliveryResponse
	testutil.Call(t, testHandler.GetAutopilotDelivery, webhookFilterRequest(apID, deliveryID, "")).Want(http.StatusOK).JSON(&detail)
	if detail.TriggerID != triggerID || detail.Event != "github.workflow_run.completed" || detail.FilterContext == nil {
		t.Fatalf("stored ingress detail = %+v", detail)
	}
	contextJSON, err := json.Marshal(detail.FilterContext)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, contextJSON, `{"suggestion":{"event":"workflow_run","actions":["completed","success"]},"matches":null}`)

	for _, tt := range []struct {
		filters string
		want    bool
	}{
		{`[]`, true},
		{`[{"event":"workflow_run"}]`, true},
		{`[{"event":"workflow_run","actions":[]}]`, true},
		{`[{"event":"workflow_run","actions":["requested"]},{"event":"workflow_run","actions":["success"]}]`, true},
		{`[{"event":"workflow_run","actions":["requested","completed"]}]`, true},
		{`[{"event":"workflow_run","actions":["failure"]}]`, false},
		{`[{"event":"github.workflow_run","actions":["completed"]}]`, false},
		{`[{"event":"workflow_run","actions":[" completed "]}]`, false},
	} {
		t.Run(tt.filters, func(t *testing.T) {
			var got WebhookDeliveryResponse
			testutil.Call(t, testHandler.GetAutopilotDelivery, webhookFilterRequest(apID, deliveryID,
				"?event_filters="+url.QueryEscape(tt.filters))).Want(http.StatusOK).JSON(&got)
			if got.FilterContext == nil || got.FilterContext.Matches == nil || *got.FilterContext.Matches != tt.want {
				t.Fatalf("preview = %+v, want matches %t", got.FilterContext, tt.want)
			}
		})
	}
	list := testutil.Call(t, testHandler.ListAutopilotDeliveries,
		withURLParam(newRequest("GET", "/api/autopilots/"+apID+"/deliveries", nil), "id", apID)).Want(http.StatusOK).Map()
	for _, row := range list["deliveries"].([]any) {
		if _, exists := row.(map[string]any)["filter_context"]; exists {
			t.Fatal("list must omit filter_context")
		}
	}
	if after := snapshot(); after != before {
		t.Fatal("delivery reads/previews changed persisted state")
	}
}

func TestGetDelivery_FilterPreviewValidationAndUnavailable(t *testing.T) {
	apID, triggerID := webhookFilterFixture(t, testWorkspaceID)
	deliveryID := dbfx.Insert(t, "webhook_delivery", testutil.Cols{
		"workspace_id": testWorkspaceID, "autopilot_id": apID, "trigger_id": triggerID, "provider": "generic",
	})
	for _, filters := range []string{"", "null", `{}`, `[`, `[null]`, `[{"event":" "}]`,
		`[{"event":"custom","actions":[""]}]`, `[{"event":"custom","actions":"opened"}]`, `[] {}`} {
		t.Run(filters, func(t *testing.T) {
			response := testutil.Call(t, testHandler.GetAutopilotDelivery, webhookFilterRequest(apID, deliveryID,
				"?event_filters="+url.QueryEscape(filters))).Want(http.StatusBadRequest).Map()
			if response["error"] == nil || response["raw_body"] != nil || response["filter_context"] != nil {
				t.Fatalf("invalid draft response = %v", response)
			}
		})
	}
	testutil.Call(t, testHandler.GetAutopilotDelivery, webhookFilterRequest(apID, deliveryID,
		"?event_filters=%5B%5D&event_filters=%5B%5D")).Want(http.StatusBadRequest)
	for _, tt := range []struct{ body, reason string }{{"", "raw_body_missing"}, {"{broken", "raw_body_invalid"}} {
		dbfx.Exec(t, `UPDATE webhook_delivery SET raw_body = $1 WHERE id = $2`, []byte(tt.body), deliveryID)
		var got WebhookDeliveryResponse
		testutil.Call(t, testHandler.GetAutopilotDelivery, webhookFilterRequest(apID, deliveryID,
			"?event_filters=%5B%5D")).Want(http.StatusOK).JSON(&got)
		if got.FilterContext == nil || got.FilterContext.UnavailableReason != tt.reason || got.FilterContext.Suggestion != nil || got.FilterContext.Matches != nil {
			t.Fatalf("unavailable preview = %+v, want %q", got.FilterContext, tt.reason)
		}
	}
}

func TestGetDelivery_FilterPreviewAccess(t *testing.T) {
	apID, triggerID := webhookFilterFixture(t, testWorkspaceID)
	otherAP, otherTrigger := webhookFilterFixture(t, testWorkspaceID)
	scheduleTrigger := dbfx.Insert(t, "autopilot_trigger", testutil.Cols{"autopilot_id": apID, "kind": "schedule"})
	otherWorkspace := dbfx.Workspace(t, "Filter other workspace", "filter-other-workspace")
	foreignAP, foreignTrigger := webhookFilterFixture(t, otherWorkspace)
	deliveryID := dbfx.Insert(t, "webhook_delivery", testutil.Cols{
		"workspace_id": testWorkspaceID, "autopilot_id": apID, "trigger_id": triggerID, "provider": "generic",
		"raw_body": []byte(`{"event":"private-event","eventPayload":{}}`),
	})
	memberID := dbfx.User(t, "Filter reader", "filter-reader@multica.test")
	dbfx.Member(t, testWorkspaceID, memberID, "member")
	outsiderID := dbfx.User(t, "Filter outsider", "filter-outsider@multica.test")
	h := middleware.RequireWorkspaceMember(testHandler.Queries)(http.HandlerFunc(testHandler.GetAutopilotDelivery))
	for _, tt := range []struct {
		name, actor, workspace, autopilot, delivery string
		status                                      int
	}{
		{"ordinary reader", memberID, testWorkspaceID, apID, deliveryID, http.StatusOK},
		{"unauthenticated", "", testWorkspaceID, apID, deliveryID, http.StatusUnauthorized},
		{"non-member", outsiderID, testWorkspaceID, apID, deliveryID, http.StatusNotFound},
		{"other autopilot", testUserID, testWorkspaceID, otherAP, deliveryID, http.StatusNotFound},
		{"other workspace autopilot", testUserID, testWorkspaceID, foreignAP, deliveryID, http.StatusNotFound},
		{"invalid delivery id", testUserID, testWorkspaceID, apID, "bad-id", http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := webhookFilterRequest(tt.autopilot, tt.delivery, "?event_filters=%5B%5D")
			req.Header.Set("X-User-ID", tt.actor)
			req.Header.Set("X-Workspace-ID", tt.workspace)
			response := testutil.Call(t, h.ServeHTTP, req).Want(tt.status).Map()
			if tt.status != http.StatusOK && (response["filter_context"] != nil || response["raw_body"] != nil || response["event"] != nil) {
				t.Fatalf("denial leaked delivery content: %v", response)
			}
		})
	}
	for _, foreign := range []string{otherTrigger, foreignTrigger, scheduleTrigger} {
		dbfx.Exec(t, `UPDATE webhook_delivery SET trigger_id = $1 WHERE id = $2`, foreign, deliveryID)
		testutil.Call(t, h.ServeHTTP, webhookFilterRequest(apID, deliveryID, "?event_filters=%5B%5D")).Want(http.StatusNotFound)
	}
	// The workspace query also rejects a delivery row from a different workspace.
	dbfx.Exec(t, `UPDATE webhook_delivery SET trigger_id = $1, workspace_id = $2 WHERE id = $3`, triggerID, otherWorkspace, deliveryID)
	testutil.Call(t, h.ServeHTTP, webhookFilterRequest(apID, deliveryID, "?event_filters=%5B%5D")).Want(http.StatusNotFound)
}
