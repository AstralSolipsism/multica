package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	messagedelivery "github.com/multica-ai/multica/server/internal/messagedelivery"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Labrastro message-delivery HTTP surface (OL-25): the "结果推送" route
// configuration and the delivery record / retry API. Every write — and
// every read of rule configuration — goes through the SAME authorization
// entry point as the rest of the autopilot surface
// (requireAutopilotWrite: the request's acting member, judged exactly as
// MUL-7108/#8107/#8099 judge it). This handler copies no authorization
// rules and owns no identity logic; it resolves the autopilot, passes the
// gate, and forwards to the module.

// messageRouteRequest is the create/update payload. expected_revision rides
// in the same body for updates.
type messageRouteRequest struct {
	InstallationID  string `json:"installation_id"`
	TargetType      string `json:"target_type"`
	TargetUserID    string `json:"target_user_id"`
	TargetChatID    string `json:"target_chat_id"`
	TargetMessageID string `json:"target_message_id"`
	TargetThreadID  string `json:"target_thread_id"`
	Conditions      string `json:"conditions"`
	ContentMode     string `json:"content_mode"`
	// Enabled is a pointer so create can default to true and update can
	// leave the flag untouched when omitted.
	Enabled *bool `json:"enabled"`
	// ExpectedRevision gates updates and enable/disable; create ignores it.
	ExpectedRevision *int32 `json:"expected_revision"`
}

func (r messageRouteRequest) toInput() messagedelivery.RouteInput {
	return messagedelivery.RouteInput{
		InstallationID:  r.InstallationID,
		TargetType:      r.TargetType,
		TargetUserID:    r.TargetUserID,
		TargetChatID:    r.TargetChatID,
		TargetMessageID: r.TargetMessageID,
		TargetThreadID:  r.TargetThreadID,
		Conditions:      r.Conditions,
		ContentMode:     r.ContentMode,
		Enabled:         r.Enabled,
	}
}

// requireMessageRouteAccessWithMember loads the source automation, enforces
// the autopilot write gate, and returns the acting member the gate judged
// (handlers stamp that member as creator/updater). The single seam is
// deliberate (review S3): every endpoint on this surface judges identity in
// exactly one place.
func (h *Handler) requireMessageRouteAccessWithMember(w http.ResponseWriter, r *http.Request) (db.Autopilot, db.Member, bool) {
	id := chi.URLParam(r, "id")
	workspaceID := h.resolveWorkspaceID(r)
	ap, ok := h.loadAutopilotInWorkspace(w, r, id, workspaceID)
	if !ok {
		return db.Autopilot{}, db.Member{}, false
	}
	member, ok := h.requireAutopilotWrite(w, r, ap, workspaceID)
	if !ok {
		return db.Autopilot{}, db.Member{}, false
	}
	return ap, member, true
}

// requireMessageRouteAccess is the read/list variant that ignores the
// acting member.
func (h *Handler) requireMessageRouteAccess(w http.ResponseWriter, r *http.Request) (db.Autopilot, bool) {
	ap, _, ok := h.requireMessageRouteAccessWithMember(w, r)
	return ap, ok
}

func (h *Handler) decodeMessageRouteRequest(w http.ResponseWriter, r *http.Request) (messageRouteRequest, bool) {
	var req messageRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return req, false
	}
	return req, true
}

// writeMessageDeliveryError maps module errors to stable codes. The codes
// are API contract (see server/internal/messagedelivery/README.md); the
// sentences are not.
func writeMessageDeliveryError(w http.ResponseWriter, err error) {
	var invalidRoute *messagedelivery.InvalidRouteError
	var invalidInst *messagedelivery.InstallationInvalidError
	var unbound *messagedelivery.MemberNotBoundError
	var notMember *messagedelivery.TargetNotMemberError
	var notApproved *messagedelivery.TargetNotApprovedError
	var unverifiable *messagedelivery.TargetUnverifiableError
	var unreachable *messagedelivery.TargetUnreachableError
	var mismatch *messagedelivery.TargetAnchorMismatchError

	switch {
	case errors.As(err, &invalidRoute):
		writeErrorCode(w, http.StatusBadRequest, "route_invalid", err.Error())
	case errors.As(err, &invalidInst):
		writeErrorCode(w, http.StatusBadRequest, "route_installation_invalid", err.Error())
	case errors.As(err, &unbound):
		writeErrorCode(w, http.StatusBadRequest, "route_member_not_bound",
			"the target member has no binding on this installation")
	case errors.As(err, &notMember):
		writeErrorCode(w, http.StatusBadRequest, "route_target_not_member",
			"the target user is not a member of this workspace")
	case errors.As(err, &notApproved):
		writeErrorCode(w, http.StatusBadRequest, "route_target_not_approved",
			"this target has no active approval by a workspace admin; nothing was saved")
	case errors.As(err, &unverifiable):
		writeErrorCode(w, http.StatusBadRequest, "route_target_unverifiable",
			"the target could not be verified against the channel; nothing was saved")
	case errors.As(err, &unreachable):
		writeErrorCode(w, http.StatusBadRequest, "route_target_unreachable",
			"the bot cannot reach this target; nothing was saved")
	case errors.As(err, &mismatch):
		writeErrorCode(w, http.StatusBadRequest, "route_topic_anchor_mismatch",
			"the topic anchor belongs to a different chat; nothing was saved")
	case errors.Is(err, messagedelivery.ErrRouteNotFound):
		writeErrorCode(w, http.StatusNotFound, "route_not_found", "message route not found")
	case errors.Is(err, messagedelivery.ErrRouteRevisionConflict):
		writeErrorCode(w, http.StatusConflict, "route_revision_conflict",
			"the route was changed by someone else; reload and reapply")
	case errors.Is(err, messagedelivery.ErrRouteAlreadyExists):
		writeErrorCode(w, http.StatusConflict, "route_already_exists",
			"a route for this source and target already exists")
	case errors.Is(err, messagedelivery.ErrDeliveryNotFound):
		writeErrorCode(w, http.StatusNotFound, "delivery_not_found", "delivery not found")
	case errors.Is(err, messagedelivery.ErrDeliveryNotRetryable):
		writeErrorCode(w, http.StatusConflict, "delivery_not_retryable",
			"only failed or uncertain deliveries can be retried")
	default:
		writeError(w, http.StatusInternalServerError, "failed to process message delivery request")
	}
}

// ListMessageRoutes: GET /api/autopilots/{id}/message-routes
func (h *Handler) ListMessageRoutes(w http.ResponseWriter, r *http.Request) {
	ap, ok := h.requireMessageRouteAccess(w, r)
	if !ok {
		return
	}
	routes, err := h.MessageDelivery.ListRoutes(r.Context(), ap.WorkspaceID, ap.ID)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	if routes == nil {
		routes = []db.LabrastroMessageRoute{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"routes": routes})
}

// CreateMessageRoute: POST /api/autopilots/{id}/message-routes
func (h *Handler) CreateMessageRoute(w http.ResponseWriter, r *http.Request) {
	ap, member, ok := h.requireMessageRouteAccessWithMember(w, r)
	if !ok {
		return
	}
	req, ok := h.decodeMessageRouteRequest(w, r)
	if !ok {
		return
	}
	route, err := h.MessageDelivery.CreateRoute(r.Context(), ap, member, req.toInput())
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"route": route})
}

// loadMessageRoute fetches the route row named by the URL, scoped to the
// gated autopilot. A route from another autopilot (or workspace) is 404 —
// never a leak of another automation's configuration.
func (h *Handler) loadMessageRoute(w http.ResponseWriter, r *http.Request, ap db.Autopilot) (db.LabrastroMessageRoute, bool) {
	routeID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "routeId"), "route id")
	if !ok {
		return db.LabrastroMessageRoute{}, false
	}
	route, err := h.Queries.GetLabrastroMessageRoute(r.Context(), db.GetLabrastroMessageRouteParams{
		ID: routeID, WorkspaceID: ap.WorkspaceID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeErrorCode(w, http.StatusNotFound, "route_not_found", "message route not found")
		return db.LabrastroMessageRoute{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load message route")
		return db.LabrastroMessageRoute{}, false
	}
	if route.AutopilotID != ap.ID {
		writeErrorCode(w, http.StatusNotFound, "route_not_found", "message route not found")
		return db.LabrastroMessageRoute{}, false
	}
	return route, true
}

// UpdateMessageRoute: PUT /api/autopilots/{id}/message-routes/{routeId}
// A stale expected_revision is a 409, never a silent overwrite.
func (h *Handler) UpdateMessageRoute(w http.ResponseWriter, r *http.Request) {
	ap, member, ok := h.requireMessageRouteAccessWithMember(w, r)
	if !ok {
		return
	}
	req, ok := h.decodeMessageRouteRequest(w, r)
	if !ok {
		return
	}
	if req.ExpectedRevision == nil {
		writeErrorCode(w, http.StatusBadRequest, "route_invalid", "expected_revision is required")
		return
	}
	route, ok := h.loadMessageRoute(w, r, ap)
	if !ok {
		return
	}
	updated, err := h.MessageDelivery.UpdateRoute(r.Context(), route, member, *req.ExpectedRevision, req.toInput())
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"route": updated})
}

// SetMessageRouteEnabled: POST /api/autopilots/{id}/message-routes/{routeId}/enable
// Body: {"enabled": bool, "expected_revision": int}. Disabling stops new
// enqueues and cancels queued sends; enabling restarts the eligibility
// boundary (no backfill of the disabled window).
func (h *Handler) SetMessageRouteEnabled(w http.ResponseWriter, r *http.Request) {
	ap, member, ok := h.requireMessageRouteAccessWithMember(w, r)
	if !ok {
		return
	}
	req, ok := h.decodeMessageRouteRequest(w, r)
	if !ok {
		return
	}
	if req.Enabled == nil || req.ExpectedRevision == nil {
		writeErrorCode(w, http.StatusBadRequest, "route_invalid", "enabled and expected_revision are required")
		return
	}
	route, ok := h.loadMessageRoute(w, r, ap)
	if !ok {
		return
	}
	updated, err := h.MessageDelivery.SetRouteEnabled(r.Context(), route, member, *req.Enabled, *req.ExpectedRevision)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"route": updated})
}

// DeleteMessageRoute: DELETE /api/autopilots/{id}/message-routes/{routeId}
func (h *Handler) DeleteMessageRoute(w http.ResponseWriter, r *http.Request) {
	ap, ok := h.requireMessageRouteAccess(w, r)
	if !ok {
		return
	}
	route, ok := h.loadMessageRoute(w, r, ap)
	if !ok {
		return
	}
	if err := h.MessageDelivery.DeleteRoute(r.Context(), route); err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// TestMessageRoute: POST /api/autopilots/{id}/message-routes/{routeId}/test-send
// Runs the REAL send path once with a synthetic message and returns the
// recorded outcome. This is the reachability check behind
// "保存前校验机器人可达性" — it either dialed or it explains why not.
func (h *Handler) TestMessageRoute(w http.ResponseWriter, r *http.Request) {
	ap, member, ok := h.requireMessageRouteAccessWithMember(w, r)
	if !ok {
		return
	}
	route, ok := h.loadMessageRoute(w, r, ap)
	if !ok {
		return
	}
	if !route.Enabled {
		writeErrorCode(w, http.StatusConflict, "route_disabled", "enable the route before sending a test message")
		return
	}
	delivery, err := h.MessageDelivery.TestSend(r.Context(), route, member)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivery": delivery})
}

// ListMessageDeliveries: GET /api/autopilots/{id}/message-deliveries
// Query: status, limit (<=200, default 50), offset.
func (h *Handler) ListMessageDeliveries(w http.ResponseWriter, r *http.Request) {
	ap, ok := h.requireMessageRouteAccess(w, r)
	if !ok {
		return
	}
	var status *string
	if v := r.URL.Query().Get("status"); v != "" {
		status = &v
	}
	limit, offset := messageDeliveryPaging(r)
	rows, err := h.MessageDelivery.ListDeliveries(r.Context(), ap.WorkspaceID, ap.ID, status, limit, offset)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	if rows == nil {
		rows = []db.ListLabrastroMessageDeliveriesByAutopilotRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deliveries": rows,
		"limit":      limit,
		"offset":     offset,
	})
}

// GetMessageDelivery: GET /api/autopilots/{id}/message-deliveries/{deliveryId}
// Includes the frozen snapshots (what the message said, where it went) and
// the per-shard receipt ledger.
func (h *Handler) GetMessageDelivery(w http.ResponseWriter, r *http.Request) {
	ap, ok := h.requireMessageRouteAccess(w, r)
	if !ok {
		return
	}
	deliveryID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "deliveryId"), "delivery id")
	if !ok {
		return
	}
	d, receipts, err := h.MessageDelivery.GetDelivery(r.Context(), ap.WorkspaceID, ap.ID, deliveryID)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	if receipts == nil {
		receipts = []db.LabrastroMessageReceipt{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"delivery":         d,
		"content_snapshot": json.RawMessage(d.ContentSnapshot),
		"target_snapshot":  json.RawMessage(d.TargetSnapshot),
		"source_ref":       nullableJSONRaw(d.SourceRef),
		"receipts":         receipts,
	})
}

// RetryMessageDelivery: POST /api/autopilots/{id}/message-deliveries/{deliveryId}/retry
// Allowed from failed (cause fixed) and uncertain (operator checked); the
// replay reuses the fixed per-shard send UUIDs and skips shards that
// already carry an external message id.
func (h *Handler) RetryMessageDelivery(w http.ResponseWriter, r *http.Request) {
	ap, ok := h.requireMessageRouteAccess(w, r)
	if !ok {
		return
	}
	deliveryID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "deliveryId"), "delivery id")
	if !ok {
		return
	}
	d, err := h.MessageDelivery.RetryDelivery(r.Context(), ap.WorkspaceID, ap.ID, deliveryID)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivery": d})
}

func messageDeliveryPaging(r *http.Request) (int32, int32) {
	limit := int32(50)
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 200 {
		limit = int32(v)
	}
	offset := int32(0)
	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v > 0 {
		offset = int32(v)
	}
	return limit, offset
}

func nullableJSONRaw(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return json.RawMessage(raw)
}

// ---- approved-target administration (repair contract §2, review R1) ----

// messageApprovedTargetRequest is the approval payload; the target resolves
// through the SAME validation a route save performs (installation active,
// verifier, anchor→chat), so an approval always names a real, verified chat.
type messageApprovedTargetRequest struct {
	InstallationID  string `json:"installation_id"`
	TargetType      string `json:"target_type"`
	TargetChatID    string `json:"target_chat_id"`
	TargetMessageID string `json:"target_message_id"`
}

// requireMessageTargetAdmin gates the approval surface to workspace
// owners/admins. Approving an outbound target is a workspace consent act
// (OL-23: "群聊使用工作区批准的目标"), categorically above automation write
// permission — a collaborator can never approve their own target.
func (h *Handler) requireMessageTargetAdmin(w http.ResponseWriter, r *http.Request) (db.Autopilot, bool) {
	id := chi.URLParam(r, "id")
	workspaceID := h.resolveWorkspaceID(r)
	ap, ok := h.loadAutopilotInWorkspace(w, r, id, workspaceID)
	if !ok {
		return db.Autopilot{}, false
	}
	if _, ok := h.requireAutopilotWrite(w, r, ap, workspaceID); !ok {
		return db.Autopilot{}, false
	}
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return db.Autopilot{}, false
	}
	return ap, true
}

// ApproveMessageTarget: POST /api/autopilots/{id}/message-approved-targets
// Grants the (automation, bot, target) triple an active approval. The
// resolved target key is stored, so the approval covers the VERIFIED chat.
func (h *Handler) ApproveMessageTarget(w http.ResponseWriter, r *http.Request) {
	ap, member, ok := h.requireMessageRouteAccessWithMember(w, r)
	if !ok {
		return
	}
	if _, ok := h.requireMessageTargetAdmin(w, r); !ok {
		return
	}
	var req messageApprovedTargetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	target, err := h.MessageDelivery.ResolveTargetForApproval(r.Context(), ap.WorkspaceID, ap.ID, messagedelivery.RouteInput{
		InstallationID:  req.InstallationID,
		TargetType:      req.TargetType,
		TargetChatID:    req.TargetChatID,
		TargetMessageID: req.TargetMessageID,
		Conditions:      messagedelivery.ConditionSuccess,
		ContentMode:     messagedelivery.ContentSummary,
	})
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	if target.Type() == messagedelivery.TargetMember {
		writeErrorCode(w, http.StatusBadRequest, "route_invalid",
			"member targets are authorized by their own binding and need no approval")
		return
	}
	row, err := h.MessageDelivery.ApproveTarget(r.Context(), ap, member, target)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"approved_target": row})
}

// ListMessageApprovedTargets: GET /api/autopilots/{id}/message-approved-targets
func (h *Handler) ListMessageApprovedTargets(w http.ResponseWriter, r *http.Request) {
	ap, ok := h.requireMessageTargetAdmin(w, r)
	if !ok {
		return
	}
	rows, err := h.MessageDelivery.ListApprovedTargets(r.Context(), ap)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	if rows == nil {
		rows = []db.LabrastroMessageApprovedTarget{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"approved_targets": rows})
}

// RevokeMessageTarget: DELETE /api/autopilots/{id}/message-approved-targets/{targetId}
// Soft-revokes the approval (audit history kept) and cancels the route's
// not-yet-started sends against the frozen target.
func (h *Handler) RevokeMessageTarget(w http.ResponseWriter, r *http.Request) {
	ap, ok := h.requireMessageTargetAdmin(w, r)
	if !ok {
		return
	}
	targetID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "targetId"), "approved target id")
	if !ok {
		return
	}
	// The row must belong to this automation and workspace.
	rows, err := h.MessageDelivery.ListApprovedTargets(r.Context(), ap)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	var found *db.LabrastroMessageApprovedTarget
	for i := range rows {
		if rows[i].ID == targetID {
			found = &rows[i]
			break
		}
	}
	if found == nil {
		writeErrorCode(w, http.StatusNotFound, "route_not_found", "approved target not found")
		return
	}
	cancelled, err := h.MessageDelivery.RevokeTarget(r.Context(), ap, found.TargetKey)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true, "cancelled_deliveries": cancelled})
}
