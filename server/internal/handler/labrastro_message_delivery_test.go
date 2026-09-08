package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	messagedelivery "github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The message-delivery HTTP surface shares the autopilot's authorization
// gate, so the cross-identity matrix lives in autopilot_acting_member_test.go
// (create-message-route / enable-message-route entries). This file covers the
// configuration contract itself: validation, revision concurrency, records,
// retry semantics and the synchronous test send.

// mdSender is the swappable sender the wired service uses; tests replace fn.
type mdSender struct {
	mu    sync.Mutex
	calls []messagedelivery.SendRequest
	fn    func(req messagedelivery.SendRequest) (messagedelivery.SendResult, error)
}

func (s *mdSender) Send(ctx context.Context, req messagedelivery.SendRequest) (messagedelivery.SendResult, error) {
	s.mu.Lock()
	s.calls = append(s.calls, req)
	fn := s.fn
	s.mu.Unlock()
	if fn == nil {
		return messagedelivery.SendResult{ExternalMessageID: "om_md_test"}, nil
	}
	return fn(req)
}

// mdVerifier is the HTTP suite's target verifier; tests flip unreachable to
// exercise the save-time refusal contract (review R1).
type mdVerifier struct {
	unreachable bool
	mismatch    bool
}

func (v *mdVerifier) VerifyGroupTarget(ctx context.Context, req messagedelivery.VerifyTargetRequest) error {
	if v.unreachable {
		return fmt.Errorf("%w: bot not in chat", messagedelivery.ErrTargetUnreachable)
	}
	return nil
}

func (v *mdVerifier) VerifyTopicTarget(ctx context.Context, req messagedelivery.VerifyTargetRequest) (string, error) {
	if v.mismatch {
		return "", fmt.Errorf("%w: anchor lives elsewhere", messagedelivery.ErrTargetAnchorMismatch)
	}
	return req.ChatID, nil
}

// httpVerifier is the single verifier instance the wired service holds;
// tests mutate it (with cleanup) to exercise refusal paths.
var httpVerifier = &mdVerifier{}

var (
	mdOnce     sync.Once
	mdSvc      *messagedelivery.Service
	mdFxFamily string
)

// requireDeliveryService wires the module onto the shared test handler once.
func requireDeliveryService(t *testing.T) *messagedelivery.Service {
	t.Helper()
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	mdOnce.Do(func() {
		mdSvc = messagedelivery.New(db.New(testPool))
		mdSvc.Tx = testPool
		mdSvc.Sender = &mdSender{}
		mdSvc.Verifier = httpVerifier
		testHandler.MessageDelivery = mdSvc
		mdFxFamily = fmt.Sprintf("%d", time.Now().UnixNano())
	})
	return mdSvc
}

// mdFixture is one autopilot + active feishu installation pair for these
// tests, with route/delivery rows the module writes swept at test end.
type mdFixture struct {
	autopilotID string
	installID   string
}

func newMDFixture(t *testing.T, label string, mode string) mdFixture {
	t.Helper()
	requireDeliveryService(t)
	agentID := createWebhookTestAgent(t, "MD agent "+label)
	autopilotID := createWebhookTestAutopilot(t, agentID, "active", mode)
	installID := dbfx.Insert(t, "channel_installation", testutil.Cols{
		"workspace_id":      testWorkspaceID,
		"agent_id":          agentID,
		"channel_type":      "feishu",
		"config":            testutil.Raw(fmt.Sprintf(`'{"app_id":"cli_md_h_%s_%s"}'::jsonb`, mdFxFamily, label)),
		"status":            "active",
		"installer_user_id": testUserID,
	})
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM labrastro_message_receipt WHERE delivery_id IN
			(SELECT id FROM labrastro_message_delivery WHERE autopilot_id = $1::uuid)`, autopilotID)
		testPool.Exec(ctx, `DELETE FROM labrastro_message_delivery WHERE autopilot_id = $1::uuid`, autopilotID)
		testPool.Exec(ctx, `DELETE FROM labrastro_message_route WHERE autopilot_id = $1::uuid`, autopilotID)
	})
	return mdFixture{autopilotID: autopilotID, installID: installID}
}

func (f mdFixture) bindMember(t *testing.T, userID, openID string) {
	t.Helper()
	dbfx.Insert(t, "channel_user_binding", testutil.Cols{
		"workspace_id":    testWorkspaceID,
		"multica_user_id": userID,
		"installation_id": f.installID,
		"channel_type":    "feishu",
		"channel_user_id": openID,
	})
}

func (f mdFixture) createMemberRoute(t *testing.T, userID string, enabled bool) messageRouteResponse {
	t.Helper()
	req := newRequest("POST", "/api/autopilots/"+f.autopilotID+"/message-routes", map[string]any{
		"installation_id": f.installID,
		"target_type":     "member",
		"target_user_id":  userID,
		"conditions":      "success",
		"content_mode":    "with_output",
		"enabled":         enabled,
	})
	req = withURLParams(req, "id", f.autopilotID)
	resp := testutil.Call(t, testHandler.CreateMessageRoute, req).Want(http.StatusCreated)
	var out messageRouteResponse
	resp.JSON(&out)
	return out
}

type messageRouteResponse struct {
	Route struct {
		ID        string `json:"id"`
		Revision  int32  `json:"revision"`
		TargetKey string `json:"target_key"`
		Enabled   bool   `json:"enabled"`
		CreatedBy string `json:"created_by"`
	} `json:"route"`
}

func TestMessageRoutes_CreateValidatesTargetState(t *testing.T) {
	fx := newMDFixture(t, "validate", "run_only")

	// Member target with no binding on THIS installation: 400, and the
	// code names the member-binding gap rather than a generic failure.
	stranger := plainMember(t, "md-unbound")
	req := newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id": fx.installID,
		"target_type":     "member",
		"target_user_id":  stranger,
		"conditions":      "success",
		"content_mode":    "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	testutil.Call(t, testHandler.CreateMessageRoute, req).Want(http.StatusBadRequest)

	// A user who is not a member of the workspace at all: distinct code.
	nonMember := dbfx.Insert(t, "user", testutil.Cols{
		"name":  "md non member",
		"email": fmt.Sprintf("md-nonmember-%s@multica.ai", mdFxFamily),
	})
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE id = $1`, nonMember)
	req = newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id": fx.installID,
		"target_type":     "member",
		"target_user_id":  nonMember,
		"conditions":      "success",
		"content_mode":    "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	code := testutil.Call(t, testHandler.CreateMessageRoute, req).Want(http.StatusBadRequest)
	if code.Body == nil || !strings.Contains(code.Body.String(), "route_target_not_member") {
		t.Fatalf("expected route_target_not_member, got %s", code.Body.String())
	}

	// A revoked installation is refused at save time.
	testPool.Exec(context.Background(),
		`UPDATE channel_installation SET status = 'revoked' WHERE id = $1`, fx.installID)
	req = newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_anywhere",
		"conditions":      "success",
		"content_mode":    "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	testutil.Call(t, testHandler.CreateMessageRoute, req).Want(http.StatusBadRequest)
}

func TestMessageRoutes_RevisionGuardsAndLifecycle(t *testing.T) {
	fx := newMDFixture(t, "revision", "run_only")
	fx.bindMember(t, testUserID, "ou_md_revision")

	created := fx.createMemberRoute(t, testUserID, true)
	if created.Route.Revision != 1 {
		t.Fatalf("initial revision = %d", created.Route.Revision)
	}
	if created.Route.CreatedBy != testUserID {
		t.Fatalf("created_by = %q, want the acting member", created.Route.CreatedBy)
	}

	// Stale revision: 409, never a silent overwrite.
	req := newRequest("PUT", "/api/autopilots/"+fx.autopilotID+"/message-routes/"+created.Route.ID, map[string]any{
		"installation_id":   fx.installID,
		"target_type":       "member",
		"target_user_id":    testUserID,
		"conditions":        "all",
		"content_mode":      "summary",
		"expected_revision": 99,
	})
	req = withURLParams(req, "id", fx.autopilotID, "routeId", created.Route.ID)
	testutil.Call(t, testHandler.UpdateMessageRoute, req).Want(http.StatusConflict)

	// Current revision: 200 with the bumped revision.
	req = newRequest("PUT", "/api/autopilots/"+fx.autopilotID+"/message-routes/"+created.Route.ID, map[string]any{
		"installation_id":   fx.installID,
		"target_type":       "member",
		"target_user_id":    testUserID,
		"conditions":        "all",
		"content_mode":      "summary",
		"expected_revision": created.Route.Revision,
	})
	req = withURLParams(req, "id", fx.autopilotID, "routeId", created.Route.ID)
	updated := testutil.Call(t, testHandler.UpdateMessageRoute, req).Want(http.StatusOK)
	var out messageRouteResponse
	updated.JSON(&out)
	if out.Route.Revision != created.Route.Revision+1 {
		t.Fatalf("revision after update = %d, want %d", out.Route.Revision, created.Route.Revision+1)
	}

	// Delete: 204 and the route disappears.
	req = newRequest("DELETE", "/api/autopilots/"+fx.autopilotID+"/message-routes/"+created.Route.ID, nil)
	req = withURLParams(req, "id", fx.autopilotID, "routeId", created.Route.ID)
	testutil.Call(t, testHandler.DeleteMessageRoute, req).Want(http.StatusNoContent)

	listReq := newRequest("GET", "/api/autopilots/"+fx.autopilotID+"/message-routes", nil)
	listReq = withURLParams(listReq, "id", fx.autopilotID)
	var list struct {
		Routes []json.RawMessage `json:"routes"`
	}
	testutil.Call(t, testHandler.ListMessageRoutes, listReq).Want(http.StatusOK).JSON(&list)
	if len(list.Routes) != 0 {
		t.Fatalf("routes after delete = %d, want 0", len(list.Routes))
	}
}

// The full happy path through the API: rule → terminal run → decision row →
// delivery records list/detail; a queued record refuses retry.
func TestMessageDeliveries_RecordsAndRetryGuard(t *testing.T) {
	fx := newMDFixture(t, "records", "run_only")
	fx.bindMember(t, testUserID, "ou_md_records")
	created := fx.createMemberRoute(t, testUserID, true)

	// A terminal run with no event: the compensator decides.
	runID := dbfx.Insert(t, "autopilot_run", testutil.Cols{
		"autopilot_id": fx.autopilotID,
		"source":       "schedule",
		"status":       "completed",
		"result":       testutil.Raw(`'{"output":"final report","session_id":"sess_keep_private"}'::jsonb`),
		"completed_at": testutil.Raw("now()"),
	})
	if _, err := mdSvc.EnqueueRunDeliveries(context.Background(), mustUUIDFrom(t, runID)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	listReq := newRequest("GET", "/api/autopilots/"+fx.autopilotID+"/message-deliveries", nil)
	listReq = withURLParams(listReq, "id", fx.autopilotID)
	var list struct {
		Deliveries []struct {
			ID         string `json:"id"`
			Status     string `json:"status"`
			RunID      string `json:"run_id"`
			SourceKind string `json:"source_kind"`
			// The records projection must not carry the snapshots.
			ContentSnapshot json.RawMessage `json:"content_snapshot"`
			TargetSnapshot  json.RawMessage `json:"target_snapshot"`
		} `json:"deliveries"`
	}
	testutil.Call(t, testHandler.ListMessageDeliveries, listReq).Want(http.StatusOK).JSON(&list)
	if len(list.Deliveries) != 1 {
		t.Fatalf("deliveries = %d, want 1", len(list.Deliveries))
	}
	d := list.Deliveries[0]
	if d.Status != "queued" || d.RunID != runID || d.SourceKind != "run_only" {
		t.Fatalf("delivery = %+v", d)
	}
	if len(d.ContentSnapshot) != 0 || len(d.TargetSnapshot) != 0 {
		t.Fatal("records projection must exclude the snapshots")
	}

	// Detail includes snapshots + receipts.
	detailReq := newRequest("GET", "/api/autopilots/"+fx.autopilotID+"/message-deliveries/"+d.ID, nil)
	detailReq = withURLParams(detailReq, "id", fx.autopilotID, "deliveryId", d.ID)
	var detail struct {
		ContentSnapshot struct {
			Text string `json:"text"`
		} `json:"content_snapshot"`
		Receipts []json.RawMessage `json:"receipts"`
	}
	testutil.Call(t, testHandler.GetMessageDelivery, detailReq).Want(http.StatusOK).JSON(&detail)
	if detail.ContentSnapshot.Text == "" {
		t.Fatal("detail must include the frozen content snapshot")
	}
	if len(detail.Receipts) != 0 {
		t.Fatalf("receipts before send = %d, want 0", len(detail.Receipts))
	}

	// A queued record is not retryable.
	retryReq := newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-deliveries/"+d.ID+"/retry", nil)
	retryReq = withURLParams(retryReq, "id", fx.autopilotID, "deliveryId", d.ID)
	resp := testutil.Call(t, testHandler.RetryMessageDelivery, retryReq)
	if resp.Code != http.StatusConflict {
		t.Fatalf("retry queued: got %d body=%s, want 409", resp.Code, resp.Body.String())
	}
	_ = created
}

// The synchronous test send exercises the REAL path end to end and records
// the outcome; with no sender wired it fails with sender_unavailable rather
// than pretending.
func TestMessageRoutes_TestSend(t *testing.T) {
	fx := newMDFixture(t, "testsend", "run_only")
	fx.bindMember(t, testUserID, "ou_md_testsend")
	route := fx.createMemberRoute(t, testUserID, true)

	// Topic target save contract: chat + message anchor required.
	req := newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id":   fx.installID,
		"target_type":       "topic",
		"target_chat_id":    "oc_topic",
		"target_message_id": "",
		"conditions":        "success",
		"content_mode":      "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	testutil.Call(t, testHandler.CreateMessageRoute, req).Want(http.StatusBadRequest)

	// Successful test send records a sent delivery.
	sender := &mdSender{}
	mdSvc.Sender = sender
	t.Cleanup(func() { mdSvc.Sender = &mdSender{} })
	sendReq := newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes/"+route.Route.ID+"/test-send", nil)
	sendReq = withURLParams(sendReq, "id", fx.autopilotID, "routeId", route.Route.ID)
	var out struct {
		Delivery struct {
			Status     string `json:"status"`
			SourceKind string `json:"source_kind"`
		} `json:"delivery"`
	}
	testutil.Call(t, testHandler.TestMessageRoute, sendReq).Want(http.StatusOK).JSON(&out)
	if out.Delivery.Status != "sent" || out.Delivery.SourceKind != "test_send" {
		t.Fatalf("test send = %+v, want sent/test_send", out.Delivery)
	}
	if len(sender.calls) != 1 {
		t.Fatalf("sender calls = %d, want 1", len(sender.calls))
	}
	if sender.calls[0].Target.OpenID != "ou_md_testsend" {
		t.Fatalf("test send dialed %q, want the live binding", sender.calls[0].Target.OpenID)
	}
}

// mustUUIDFrom parses a trusted fixture id.
func mustUUIDFrom(t *testing.T, s string) pgtype.UUID {
	t.Helper()
	u, err := util.ParseUUID(s)
	if err != nil {
		t.Fatalf("bad uuid %q: %v", s, err)
	}
	return u
}

// R1 through the API: group/topic saves are refused when the platform
// cannot prove the target, with codes that name the gap.
func TestMessageRoutes_TargetVerification(t *testing.T) {
	fx := newMDFixture(t, "verify-api", "run_only")

	// Unreachable group: 400 route_target_unreachable, nothing saved.
	httpVerifier.unreachable = true
	t.Cleanup(func() { httpVerifier.unreachable = false })
	req := newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_blocked",
		"conditions":      "success",
		"content_mode":    "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	resp := testutil.Call(t, testHandler.CreateMessageRoute, req)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "route_target_unreachable") {
		t.Fatalf("unreachable group: got %d %s", resp.Code, resp.Body.String())
	}
	httpVerifier.unreachable = false

	// Reachable but UNAPPROVED: 400 route_target_not_approved — a plain
	// automation writer cannot grant itself a new outbound target.
	req = newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_unapproved",
		"conditions":      "success",
		"content_mode":    "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	resp = testutil.Call(t, testHandler.CreateMessageRoute, req)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "route_target_not_approved") {
		t.Fatalf("unapproved group: got %d %s", resp.Code, resp.Body.String())
	}

	// Mismatched topic anchor: 400 route_topic_anchor_mismatch.
	httpVerifier.mismatch = true
	t.Cleanup(func() { httpVerifier.mismatch = false })
	req = newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id":   fx.installID,
		"target_type":       "topic",
		"target_chat_id":    "oc_declared",
		"target_message_id": "om_1",
		"conditions":        "success",
		"content_mode":      "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	resp = testutil.Call(t, testHandler.CreateMessageRoute, req)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "route_topic_anchor_mismatch") {
		t.Fatalf("mismatched topic: got %d %s", resp.Code, resp.Body.String())
	}
	httpVerifier.mismatch = false

	// Admin approves the verified target, then the save succeeds.
	req = newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-approved-targets", map[string]any{
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_reachable",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	testutil.Call(t, testHandler.ApproveMessageTarget, req).Want(http.StatusCreated)

	req = newRequest("POST", "/api/autopilots/"+fx.autopilotID+"/message-routes", map[string]any{
		"installation_id": fx.installID,
		"target_type":     "group",
		"target_chat_id":  "oc_reachable",
		"conditions":      "success",
		"content_mode":    "summary",
	})
	req = withURLParams(req, "id", fx.autopilotID)
	testutil.Call(t, testHandler.CreateMessageRoute, req).Want(http.StatusCreated)
}
