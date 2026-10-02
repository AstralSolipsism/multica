package handler

// Labrastro personal/team notification-source HTTP surface (OL-27). The
// OL-25 automation surface lives in labrastro_message_delivery.go under
// /api/autopilots/{id}/... and is untouched; this surface expresses the
// source scopes separately:
//
//	/api/message-routes          personal (inbox) + team (activity/comment) rules
//	/api/message-approved-targets  team outbound-target approvals (workspace consent)
//	/api/message-event-catalog   the event/filter catalog a config UI renders
//
// Identity: every endpoint resolves the ACTING member through the same
// seam the autopilot surface uses (requireAutopilotActingMember) — a member
// acts for themselves, an agent for its run's originator, and a request
// with no resolvable human is refused. Scope rules on top of identity:
//
//   - an inbox route's recipient is ALWAYS the resolved acting member; the
//     caller's target_user_id is never consulted, so nobody — admins
//     included — can configure someone else's inbox;
//   - team routes and team target approvals require a workspace owner/admin;
//   - an ordinary member managing their own notifications never gains team
//     outbound permission.

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	messagedelivery "github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/notify"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// messageSourceRefusal names the notification surface's identity refusals
// (same resolution path as the autopilot surface, distinct codes).
var messageSourceRefusal = autopilotRefusal{
	noOriginatorCode: "message_no_originator",
	noOriginatorMsg:  "no human authorized this notification configuration: the calling run records no originator",
	forbiddenCode:    "message_forbidden",
	forbiddenMsg:     "no resolvable workspace member for this notification request",
}

// requireMessageSourceMember resolves the acting member whose identity this
// request spends. It performs NO scope judgment — the handlers layer the
// self-ownership and admin rules on top.
func (h *Handler) requireMessageSourceMember(w http.ResponseWriter, r *http.Request, workspaceID string) (db.Member, bool) {
	return h.requireAutopilotActingMember(w, r, workspaceID, messageSourceRefusal)
}

// requireMessageSourceAdmin additionally requires workspace owner/admin —
// the gate for team configuration and outbound-target consent.
func (h *Handler) requireMessageSourceAdmin(w http.ResponseWriter, r *http.Request, workspaceID string) (db.Member, bool) {
	member, ok := h.requireMessageSourceMember(w, r, workspaceID)
	if !ok {
		return db.Member{}, false
	}
	if member.Role != "owner" && member.Role != "admin" {
		writeErrorCode(w, http.StatusForbidden, "message_target_admin_required",
			"team notification configuration requires a workspace owner or admin")
		return db.Member{}, false
	}
	return member, true
}

// messageSourceRequest is the create/update payload for a personal/team
// route. expected_revision rides in the same body for updates.
type messageSourceRequest struct {
	SourceKind       string   `json:"source_kind"`
	InstallationID   string   `json:"installation_id"`
	TargetType       string   `json:"target_type"`
	TargetUserID     string   `json:"target_user_id"`
	TargetChatID     string   `json:"target_chat_id"`
	TargetMessageID  string   `json:"target_message_id"`
	TargetThreadID   string   `json:"target_thread_id"`
	ProjectID        string   `json:"project_id"`
	EventTypes       []string `json:"event_types"`
	Enabled          *bool    `json:"enabled"`
	ExpectedRevision *int32   `json:"expected_revision"`
}

func (r messageSourceRequest) toInput() messagedelivery.SourceRouteInput {
	return messagedelivery.SourceRouteInput{
		Scope:           r.SourceKind,
		InstallationID:  r.InstallationID,
		TargetType:      r.TargetType,
		TargetUserID:    r.TargetUserID,
		TargetChatID:    r.TargetChatID,
		TargetMessageID: r.TargetMessageID,
		TargetThreadID:  r.TargetThreadID,
		ProjectID:       r.ProjectID,
		EventTypes:      r.EventTypes,
		Enabled:         r.Enabled,
	}
}

func (h *Handler) decodeMessageSourceRequest(w http.ResponseWriter, r *http.Request) (messageSourceRequest, bool) {
	var req messageSourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return req, false
	}
	return req, true
}

// loadMessageSourceRoute fetches the route row named by the URL, scoped to
// the workspace and to the non-run scopes this surface owns. A run route
// (or a route from another workspace) is 404 — the automation surface keeps
// its own paths.
func (h *Handler) loadMessageSourceRoute(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID) (db.LabrastroMessageRoute, bool) {
	routeID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "routeId"), "route id")
	if !ok {
		return db.LabrastroMessageRoute{}, false
	}
	route, err := h.Queries.GetLabrastroMessageRoute(r.Context(), db.GetLabrastroMessageRouteParams{
		ID: routeID, WorkspaceID: workspaceID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeErrorCode(w, http.StatusNotFound, "route_not_found", "message route not found")
		return db.LabrastroMessageRoute{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load message route")
		return db.LabrastroMessageRoute{}, false
	}
	if !messagedelivery.IsSourceRouteScope(route.SourceKind) {
		writeErrorCode(w, http.StatusNotFound, "route_not_found", "message route not found")
		return db.LabrastroMessageRoute{}, false
	}
	return route, true
}

// ListMessageSourceRoutes: GET /api/message-routes?source_kind=
func (h *Handler) ListMessageSourceRoutes(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireMessageSourceMember(w, r, util.UUIDToString(workspaceID))
	if !ok {
		return
	}
	var scope *string
	if v := r.URL.Query().Get("source_kind"); v != "" {
		scope = &v
		if (v == messagedelivery.RouteSourceActivity || v == messagedelivery.RouteSourceComment) && member.Role != "owner" && member.Role != "admin" {
			writeErrorCode(w, http.StatusForbidden, "message_target_admin_required", "team notification configuration requires a workspace owner or admin")
			return
		}
	}
	routes, err := h.MessageDelivery.ListSourceRoutes(r.Context(), member, scope)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"routes": routes})
}

// CreateMessageSourceRoute: POST /api/message-routes
func (h *Handler) CreateMessageSourceRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	req, ok := h.decodeMessageSourceRequest(w, r)
	if !ok {
		return
	}
	in := req.toInput()
	switch in.Scope {
	case messagedelivery.RouteSourceInbox:
		member, ok := h.requireMessageSourceMember(w, r, util.UUIDToString(workspaceID))
		if !ok {
			return
		}
		// The recipient IS the resolved acting member. The caller's
		// target_user_id is never consulted.
		in.TargetUserID = util.UUIDToString(member.UserID)
		in.TargetType = messagedelivery.TargetMember
		route, err := h.MessageDelivery.CreateSourceRoute(r.Context(), member, in)
		if err != nil {
			writeMessageDeliveryError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"route": route})
	case messagedelivery.RouteSourceActivity, messagedelivery.RouteSourceComment:
		member, ok := h.requireMessageSourceAdmin(w, r, util.UUIDToString(workspaceID))
		if !ok {
			return
		}
		route, err := h.MessageDelivery.CreateSourceRoute(r.Context(), member, in)
		if err != nil {
			writeMessageDeliveryError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"route": route})
	default:
		writeErrorCode(w, http.StatusBadRequest, "route_invalid", "source_kind must be inbox, activity or comment")
	}
}

// UpdateMessageSourceRoute: PUT /api/message-routes/{routeId}
// A stale expected_revision is a 409. The scope never changes through an
// edit; the inbox recipient is re-pinned to the acting member.
func (h *Handler) UpdateMessageSourceRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	req, ok := h.decodeMessageSourceRequest(w, r)
	if !ok {
		return
	}
	if req.ExpectedRevision == nil {
		writeErrorCode(w, http.StatusBadRequest, "route_invalid", "expected_revision is required")
		return
	}
	route, ok := h.loadMessageSourceRoute(w, r, workspaceID)
	if !ok {
		return
	}
	in := req.toInput()
	in.Scope = route.SourceKind
	var member db.Member
	if route.SourceKind == messagedelivery.RouteSourceInbox {
		member, ok = h.requireMessageSourceMember(w, r, util.UUIDToString(workspaceID))
		if !ok {
			return
		}
		if route.TargetUserID != member.UserID {
			writeErrorCode(w, http.StatusForbidden, "route_not_self",
				"a personal notification route can only be managed by its own recipient")
			return
		}
		in.TargetUserID = util.UUIDToString(member.UserID)
	} else {
		member, ok = h.requireMessageSourceAdmin(w, r, util.UUIDToString(workspaceID))
		if !ok {
			return
		}
	}
	updated, err := h.MessageDelivery.UpdateSourceRoute(r.Context(), route, member, *req.ExpectedRevision, in)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"route": updated})
}

// SetMessageSourceRouteEnabled: POST /api/message-routes/{routeId}/enable
// Body: {"enabled": bool, "expected_revision": int}. Disabling cancels
// queued sends; enabling re-verifies the target and resets the eligibility
// boundary (the disabled window is never backfilled).
func (h *Handler) SetMessageSourceRouteEnabled(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	req, ok := h.decodeMessageSourceRequest(w, r)
	if !ok {
		return
	}
	if req.Enabled == nil || req.ExpectedRevision == nil {
		writeErrorCode(w, http.StatusBadRequest, "route_invalid", "enabled and expected_revision are required")
		return
	}
	route, ok := h.loadMessageSourceRoute(w, r, workspaceID)
	if !ok {
		return
	}
	member, ok := h.requireMessageSourceMemberForRoute(w, r, util.UUIDToString(workspaceID), route)
	if !ok {
		return
	}
	updated, err := h.MessageDelivery.SetSourceRouteEnabled(r.Context(), route, member, *req.Enabled, *req.ExpectedRevision)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"route": updated})
}

// DeleteMessageSourceRoute: DELETE /api/message-routes/{routeId}
func (h *Handler) DeleteMessageSourceRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	route, ok := h.loadMessageSourceRoute(w, r, workspaceID)
	if !ok {
		return
	}
	if _, ok := h.requireMessageSourceMemberForRoute(w, r, util.UUIDToString(workspaceID), route); !ok {
		return
	}
	if err := h.MessageDelivery.DeleteRoute(r.Context(), route); err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// TestMessageSourceRoute: POST /api/message-routes/{routeId}/test-send
// Runs the REAL send path once with a synthetic message — the same
// reachability check the automation surface offers.
func (h *Handler) TestMessageSourceRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	route, ok := h.loadMessageSourceRoute(w, r, workspaceID)
	if !ok {
		return
	}
	member, ok := h.requireMessageSourceMemberForRoute(w, r, util.UUIDToString(workspaceID), route)
	if !ok {
		return
	}
	if !route.Enabled {
		writeErrorCode(w, http.StatusConflict, "route_disabled", "enable the route before sending a test message")
		return
	}
	delivery, err := h.MessageDelivery.TestSourceSend(r.Context(), route, member)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivery": delivery})
}

// requireMessageSourceMemberForRoute judges the acting member against the
// route's scope: a personal route is managed by its own recipient only; a
// team route by a workspace owner/admin.
func (h *Handler) requireMessageSourceMemberForRoute(w http.ResponseWriter, r *http.Request, workspaceID string, route db.LabrastroMessageRoute) (db.Member, bool) {
	member, ok := h.requireMessageSourceMember(w, r, workspaceID)
	if !ok {
		return db.Member{}, false
	}
	if route.SourceKind == messagedelivery.RouteSourceInbox {
		if route.TargetUserID != member.UserID {
			writeErrorCode(w, http.StatusForbidden, "route_not_self",
				"a personal notification route can only be managed by its own recipient")
			return db.Member{}, false
		}
		return member, true
	}
	if member.Role != "owner" && member.Role != "admin" {
		writeErrorCode(w, http.StatusForbidden, "message_target_admin_required",
			"team notification configuration requires a workspace owner or admin")
		return db.Member{}, false
	}
	return member, true
}

// ---- records ----

// ListMessageRouteDeliveries: GET /api/message-routes/{routeId}/message-deliveries
func (h *Handler) ListMessageRouteDeliveries(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	route, ok := h.loadMessageSourceRoute(w, r, workspaceID)
	if !ok {
		return
	}
	if _, ok := h.requireMessageSourceMemberForRoute(w, r, util.UUIDToString(workspaceID), route); !ok {
		return
	}
	var status *string
	if v := r.URL.Query().Get("status"); v != "" {
		status = &v
	}
	limit, offset := messageDeliveryPaging(r)
	rows, err := h.MessageDelivery.ListRouteDeliveries(r.Context(), workspaceID, route.ID, status, limit, offset)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	if rows == nil {
		rows = []db.ListLabrastroMessageDeliveriesByRouteRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deliveries": rows,
		"limit":      limit,
		"offset":     offset,
	})
}

// GetMessageRouteDelivery: GET /api/message-routes/{routeId}/message-deliveries/{deliveryId}
// Includes the frozen snapshots and the per-shard receipt ledger.
func (h *Handler) GetMessageRouteDelivery(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	route, ok := h.loadMessageSourceRoute(w, r, workspaceID)
	if !ok {
		return
	}
	if _, ok := h.requireMessageSourceMemberForRoute(w, r, util.UUIDToString(workspaceID), route); !ok {
		return
	}
	deliveryID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "deliveryId"), "delivery id")
	if !ok {
		return
	}
	d, receipts, err := h.MessageDelivery.GetSourceDelivery(r.Context(), workspaceID, route.ID, deliveryID)
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

// RetryMessageRouteDelivery: POST /api/message-routes/{routeId}/message-deliveries/{deliveryId}/retry
func (h *Handler) RetryMessageRouteDelivery(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	route, ok := h.loadMessageSourceRoute(w, r, workspaceID)
	if !ok {
		return
	}
	if _, ok := h.requireMessageSourceMemberForRoute(w, r, util.UUIDToString(workspaceID), route); !ok {
		return
	}
	deliveryID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "deliveryId"), "delivery id")
	if !ok {
		return
	}
	d, err := h.MessageDelivery.RetryRouteDelivery(r.Context(), workspaceID, route.ID, deliveryID)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivery": d})
}

// ---- team target approvals (workspace consent) ----

// messageSourceApprovedTargetRequest is the approval payload; the target
// resolves through the SAME validation a team route save performs.
type messageSourceApprovedTargetRequest struct {
	ProjectID       string `json:"project_id"`
	SourceKind      string `json:"source_kind"`
	InstallationID  string `json:"installation_id"`
	TargetType      string `json:"target_type"`
	TargetChatID    string `json:"target_chat_id"`
	TargetMessageID string `json:"target_message_id"`
}

// ApproveMessageSourceTarget: POST /api/message-approved-targets
// Grants the (source scope, bot, target) triple an active approval.
func (h *Handler) ApproveMessageSourceTarget(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireMessageSourceAdmin(w, r, util.UUIDToString(workspaceID))
	if !ok {
		return
	}
	var req messageSourceApprovedTargetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !messagedelivery.IsSourceRouteScope(req.SourceKind) || req.SourceKind == messagedelivery.RouteSourceInbox {
		writeErrorCode(w, http.StatusBadRequest, "route_invalid",
			"source_kind must be activity or comment; personal targets use the member binding")
		return
	}
	target, err := h.MessageDelivery.ResolveSourceTargetForApproval(r.Context(), workspaceID, req.SourceKind, messagedelivery.SourceRouteInput{
		Scope:           req.SourceKind,
		ProjectID:       req.ProjectID,
		InstallationID:  req.InstallationID,
		TargetType:      req.TargetType,
		TargetChatID:    req.TargetChatID,
		TargetMessageID: req.TargetMessageID,
	})
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	if target.Type() == messagedelivery.TargetMember {
		writeErrorCode(w, http.StatusBadRequest, "route_invalid",
			"personal targets deliver to the recipient's own binding; no group approval is needed")
		return
	}
	row, err := h.MessageDelivery.ApproveSourceTarget(r.Context(), workspaceID, req.SourceKind, member, target)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"approved_target": row})
}

// ListMessageSourceApprovedTargets: GET /api/message-approved-targets
func (h *Handler) ListMessageSourceApprovedTargets(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	if _, ok := h.requireMessageSourceAdmin(w, r, util.UUIDToString(workspaceID)); !ok {
		return
	}
	rows, err := h.MessageDelivery.ListSourceApprovedTargets(r.Context(), workspaceID)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"approved_targets": rows})
}

// RevokeMessageSourceTarget: DELETE /api/message-approved-targets/{targetId}
// Soft-revokes the approval and cancels the scope's not-yet-started sends
// against the frozen target, in one transaction.
func (h *Handler) RevokeMessageSourceTarget(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	if _, ok := h.requireMessageSourceAdmin(w, r, util.UUIDToString(workspaceID)); !ok {
		return
	}
	targetID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "targetId"), "approved target id")
	if !ok {
		return
	}
	rows, err := h.MessageDelivery.ListSourceApprovedTargets(r.Context(), workspaceID)
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
	cancelled, err := h.MessageDelivery.RevokeSourceTarget(r.Context(), workspaceID, found.SourceKind, *found)
	if err != nil {
		writeMessageDeliveryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true, "cancelled_deliveries": cancelled})
}

// ---- event catalog ----

// messageEventCatalogResponse is the config-UI contract: which source kinds
// exist, which events each may forward, and which preference group each
// personal event is muted under.
type messageEventCatalogResponse struct {
	Personal messageEventCatalogPersonal `json:"personal"`
	Team     []messageEventCatalogTeam   `json:"team"`
}

type messageEventCatalogPersonal struct {
	SourceKind string             `json:"source_kind"`
	TargetType string             `json:"target_type"`
	EventTypes []notify.InboxType `json:"event_types"`
}

type messageEventCatalogTeam struct {
	SourceKind string                         `json:"source_kind"`
	Events     []messageEventCatalogTeamEvent `json:"events"`
}

type messageEventCatalogTeamEvent struct {
	Event string `json:"event"`
	Label string `json:"label"`
}

// GetMessageEventCatalog: GET /api/message-event-catalog
func (h *Handler) GetMessageEventCatalog(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	if _, ok := h.requireMessageSourceMember(w, r, util.UUIDToString(workspaceID)); !ok {
		return
	}
	catalog := messageEventCatalogResponse{
		Personal: messageEventCatalogPersonal{
			SourceKind: messagedelivery.RouteSourceInbox,
			TargetType: messagedelivery.TargetMember,
			EventTypes: notify.InboxTypes(),
		},
		Team: []messageEventCatalogTeam{
			{
				SourceKind: messagedelivery.RouteSourceActivity,
				Events: []messageEventCatalogTeamEvent{
					{Event: notify.ActivityActionStatusChanged, Label: "Issue status changed"},
					{Event: notify.ActivityActionAssigneeChanged, Label: "Issue assignee changed"},
				},
			},
			{
				SourceKind: messagedelivery.RouteSourceComment,
				Events: []messageEventCatalogTeamEvent{
					{Event: notify.CommentTypeDeliverable, Label: "New comment"},
				},
			},
		},
	}
	writeJSON(w, http.StatusOK, catalog)
}
