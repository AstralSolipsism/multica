// Labrastro fork API. Public methods are mounted by labrastro-api.ts.
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods, parseConfirmedWrite, parseRequiredResponse } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import {
  ListMessageRoutesResponseSchema,
  MessageRouteResponseSchema,
  ListMessageApprovedTargetsResponseSchema,
  ApproveMessageTargetResponseSchema,
  RevokeMessageTargetResponseSchema,
  ListMessageDeliveriesResponseSchema,
  MessageDeliveryResponseSchema,
  GetMessageDeliveryResponseSchema,
  emptyMessageDeliveryDetail,
  ListMessageSourceRoutesResponseSchema,
  MessageSourceRouteResponseSchema,
  ListMessageSourceApprovedTargetsResponseSchema,
  ApproveMessageSourceTargetResponseSchema,
  MessageEventCatalogSchema,
  ListMessageRouteDeliveriesResponseSchema,
  MessageSourceDeliveryResponseSchema,
  GetMessageRouteDeliveryResponseSchema,
  emptyMessageRouteDeliveryDetail,
  EMPTY_LIST_MESSAGE_DELIVERIES_RESPONSE,
  EMPTY_LIST_MESSAGE_ROUTE_DELIVERIES_RESPONSE,
  type GetMessageDeliveryResponse,
  type ListMessageDeliveriesResponse,
  type MessageDelivery,
  type RevokeMessageTargetResponse,
  type ListMessageApprovedTargetsResponse,
  type MessageApprovedTarget,
  type ListMessageRoutesResponse,
  type MessageRoute,
  type GetMessageRouteDeliveryResponse,
  type ListMessageRouteDeliveriesResponse,
  type MessageSourceDelivery,
  type MessageEventCatalog,
  type ListMessageSourceApprovedTargetsResponse,
  type MessageSourceApprovedTarget,
  type ListMessageSourceRoutesResponse,
  type MessageSourceRoute,
} from "./labrastro-message-delivery-schemas";
import type { ApproveMessageTargetRequest, ApproveMessageSourceTargetRequest, SaveMessageRouteRequest, SaveMessageSourceRouteRequest } from "../types";

const labrastroMessageDeliveryApi = {
  // Labrastro message delivery (OL-25 backend / OL-26 frontend) — the
  // automation result-push route configuration plus the delivery records and
  // retry surface. Contract: server/internal/messagedelivery/README.md.
  // These paths exist only on servers running OL-25+; older servers answer
  // 404, which callers present as an "unsupported server" state (never as
  // a successful save).
  async listMessageRoutes(this: ApiClient, autopilotId: string): Promise<ListMessageRoutesResponse> {
    const raw = await clientFetch<unknown>(this, `/api/autopilots/${autopilotId}/message-routes`);
    return parseRequiredResponse(raw, ListMessageRoutesResponseSchema, "GET /api/autopilots/:id/message-routes");
  },

  // Create returns 201 with {route}; the revision starts at 1. Enabled
  // defaults to true server-side when omitted — the editor always sends it
  // explicitly so the saved state matches what the user saw.
  async createMessageRoute(
    this: ApiClient,
    autopilotId: string,
    data: SaveMessageRouteRequest,
  ): Promise<MessageRoute> {
    const raw = await clientFetch<unknown>(this, `/api/autopilots/${autopilotId}/message-routes`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    const parsed = parseConfirmedWrite(raw, MessageRouteResponseSchema,
      "POST /api/autopilots/:id/message-routes",
      (value) => Boolean(value.route.id));
    return parsed.route;
  },

  // Update and enable/disable are revision-guarded: a stale
  // expected_revision is a 409 route_revision_conflict, never a silent
  // overwrite. Callers surface that conflict instead of retrying blindly.
  async updateMessageRoute(
    this: ApiClient,
    autopilotId: string,
    routeId: string,
    data: SaveMessageRouteRequest,
  ): Promise<MessageRoute> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-routes/${routeId}`,
      { method: "PUT", body: JSON.stringify(data) },
    );
    const parsed = parseConfirmedWrite(raw, MessageRouteResponseSchema,
      "PUT /api/autopilots/:id/message-routes/:routeId",
      (value) => Boolean(value.route.id));
    return parsed.route;
  },

  async setMessageRouteEnabled(
    this: ApiClient,
    autopilotId: string,
    routeId: string,
    enabled: boolean,
    expectedRevision: number,
  ): Promise<MessageRoute> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-routes/${routeId}/enable`,
      {
        method: "POST",
        body: JSON.stringify({ enabled, expected_revision: expectedRevision }),
      },
    );
    const parsed = parseConfirmedWrite(raw, MessageRouteResponseSchema,
      "POST /api/autopilots/:id/message-routes/:routeId/enable",
      (value) => Boolean(value.route.id));
    return parsed.route;
  },

  async deleteMessageRoute(this: ApiClient, autopilotId: string, routeId: string): Promise<void> {
    await clientFetch(this, `/api/autopilots/${autopilotId}/message-routes/${routeId}`, {
      method: "DELETE",
    });
  },

  // Test-send runs the REAL send path synchronously with a synthetic
  // message; the server refuses with 409 route_disabled on a disabled rule.
  async testMessageRoute(this: ApiClient, autopilotId: string, routeId: string): Promise<MessageDelivery> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-routes/${routeId}/test-send`,
      { method: "POST" },
    );
    const parsed = parseConfirmedWrite(raw, MessageDeliveryResponseSchema,
      "POST /api/autopilots/:id/message-routes/:routeId/test-send",
      (value) => Boolean(value.delivery.id));
    return parsed.delivery;
  },

  // Approved targets are a workspace owner/admin consent surface; the server
  // answers 403 message_target_admin_required for plain collaborators.
  async listMessageApprovedTargets(
    this: ApiClient,
    autopilotId: string,
  ): Promise<ListMessageApprovedTargetsResponse> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-approved-targets`,
    );
    return parseRequiredResponse(raw, ListMessageApprovedTargetsResponseSchema, "GET /api/autopilots/:id/message-approved-targets");
  },

  async approveMessageTarget(
    this: ApiClient,
    autopilotId: string,
    data: ApproveMessageTargetRequest,
  ): Promise<MessageApprovedTarget> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-approved-targets`,
      { method: "POST", body: JSON.stringify(data) },
    );
    const parsed = parseConfirmedWrite(raw, ApproveMessageTargetResponseSchema,
      "POST /api/autopilots/:id/message-approved-targets",
      (value) => Boolean(value.approved_target.id));
    return parsed.approved_target;
  },

  // Revoke cancels the route's queued sends in the same transaction; the
  // response reports how many were cancelled. Platform-accepted sends are
  // not recallable.
  async revokeMessageTarget(
    this: ApiClient,
    autopilotId: string,
    targetId: string,
  ): Promise<RevokeMessageTargetResponse> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-approved-targets/${targetId}`,
      { method: "DELETE" },
    );
    return parseConfirmedWrite(
      raw,
      RevokeMessageTargetResponseSchema,
      "DELETE /api/autopilots/:id/message-approved-targets/:targetId",
      (value) => value.revoked === true,
    );
  },

  // Delivery records page. The list projection carries no content/target
  // snapshots — use getMessageDelivery for those.
  async listMessageDeliveries(
    this: ApiClient,
    autopilotId: string,
    params?: { runId?: string; status?: string; limit?: number; offset?: number },
  ): Promise<ListMessageDeliveriesResponse> {
    const search = new URLSearchParams();
    if (params?.runId !== undefined) search.set("run_id", params.runId);
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", params.limit.toString());
    if (params?.offset) search.set("offset", params.offset.toString());
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-deliveries?${search}`,
    );
    return parseWithFallback(
      raw,
      ListMessageDeliveriesResponseSchema,
      EMPTY_LIST_MESSAGE_DELIVERIES_RESPONSE,
      { endpoint: "GET /api/autopilots/:id/message-deliveries" },
    );
  },

  async getMessageDelivery(
    this: ApiClient,
    autopilotId: string,
    deliveryId: string,
  ): Promise<GetMessageDeliveryResponse> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-deliveries/${deliveryId}`,
    );
    return parseWithFallback(
      raw,
      GetMessageDeliveryResponseSchema,
      emptyMessageDeliveryDetail(autopilotId, deliveryId),
      { endpoint: "GET /api/autopilots/:id/message-deliveries/:deliveryId" },
    );
  },

  // Retry is allowed from failed (cause fixed) and uncertain (operator
  // verified in Feishu first); the replay reuses the fixed per-shard send
  // UUIDs and skips shards that already carry an external message id.
  async retryMessageDelivery(
    this: ApiClient,
    autopilotId: string,
    deliveryId: string,
  ): Promise<MessageDelivery> {
    const raw = await clientFetch<unknown>(this,
      `/api/autopilots/${autopilotId}/message-deliveries/${deliveryId}/retry`,
      { method: "POST" },
    );
    const parsed = parseConfirmedWrite(raw, MessageDeliveryResponseSchema,
      "POST /api/autopilots/:id/message-deliveries/:deliveryId/retry",
      (value) => Boolean(value.delivery.id));
    return parsed.delivery;
  },

  // -----------------------------------------------------------------------
  // Labrastro message delivery — OL-27 source surface: personal inbox
  // forwarding to the acting member and team (activity/comment) subscriptions.
  // Contract: server/internal/messagedelivery/README.md "OL-27 HTTP API";
  // refusals: 403 route_not_self / message_no_originator / message_forbidden
  // / message_target_admin_required. Servers without OL-27 answer 404, which
  // callers present as an "unsupported server" state.
  // -----------------------------------------------------------------------

  // The config-UI catalog: which source kinds exist, which events each may
  // forward, and which preference group each personal event is muted under.
  async getMessageEventCatalog(this: ApiClient): Promise<MessageEventCatalog> {
    const raw = await clientFetch<unknown>(this, "/api/message-event-catalog");
    return parseRequiredResponse(raw, MessageEventCatalogSchema, "GET /api/message-event-catalog");
  },

  // Lists the acting member's own inbox rules; an unfiltered list also
  // includes team rules for owners/admins. Explicitly requesting a team
  // source_kind without that role is a 403 message_target_admin_required.
  async listMessageSourceRoutes(
    this: ApiClient,
    sourceKind?: string,
  ): Promise<ListMessageSourceRoutesResponse> {
    const search = new URLSearchParams();
    if (sourceKind) search.set("source_kind", sourceKind);
    const raw = await clientFetch<unknown>(this, `/api/message-routes?${search}`);
    return parseRequiredResponse(raw, ListMessageSourceRoutesResponseSchema, "GET /api/message-routes");
  },

  // Create returns 201 with {route}, revision 1. For source_kind=inbox the
  // server pins the recipient to the acting member — a caller-supplied
  // target_user_id is ignored, never honored.
  async createMessageSourceRoute(
    this: ApiClient,
    data: SaveMessageSourceRouteRequest,
  ): Promise<MessageSourceRoute> {
    const raw = await clientFetch<unknown>(this, "/api/message-routes", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const parsed = parseConfirmedWrite(raw, MessageSourceRouteResponseSchema,
      "POST /api/message-routes",
      (value) => Boolean(value.route.id));
    return parsed.route;
  },

  // Revision-guarded: a stale expected_revision is a 409
  // route_revision_conflict, never a silent overwrite.
  async updateMessageSourceRoute(
    this: ApiClient,
    routeId: string,
    data: SaveMessageSourceRouteRequest,
  ): Promise<MessageSourceRoute> {
    const raw = await clientFetch<unknown>(this, `/api/message-routes/${routeId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    const parsed = parseConfirmedWrite(raw, MessageSourceRouteResponseSchema,
      "PUT /api/message-routes/:routeId",
      (value) => Boolean(value.route.id));
    return parsed.route;
  },

  // Disabling cancels queued sends; enabling re-verifies the target and
  // resets the eligibility boundary (the disabled window is not backfilled).
  async setMessageSourceRouteEnabled(
    this: ApiClient,
    routeId: string,
    enabled: boolean,
    expectedRevision: number,
  ): Promise<MessageSourceRoute> {
    const raw = await clientFetch<unknown>(this, `/api/message-routes/${routeId}/enable`, {
      method: "POST",
      body: JSON.stringify({ enabled, expected_revision: expectedRevision }),
    });
    const parsed = parseConfirmedWrite(raw, MessageSourceRouteResponseSchema,
      "POST /api/message-routes/:routeId/enable",
      (value) => Boolean(value.route.id));
    return parsed.route;
  },

  async deleteMessageSourceRoute(this: ApiClient, routeId: string): Promise<void> {
    await clientFetch(this, `/api/message-routes/${routeId}`, { method: "DELETE" });
  },

  // Test-send runs the REAL send path synchronously; a disabled rule is
  // refused with 409 route_disabled.
  async testMessageSourceRoute(this: ApiClient, routeId: string): Promise<MessageSourceDelivery> {
    const raw = await clientFetch<unknown>(this, `/api/message-routes/${routeId}/test-send`, {
      method: "POST",
    });
    const parsed = parseConfirmedWrite(raw, MessageSourceDeliveryResponseSchema,
      "POST /api/message-routes/:routeId/test-send",
      (value) => Boolean(value.delivery.id));
    return parsed.delivery;
  },

  // Records page for one source route. No run filter exists on this surface
  // (source records are not runs); statuses/pagination mirror the automation
  // records API.
  async listMessageRouteDeliveries(
    this: ApiClient,
    routeId: string,
    params?: { status?: string; limit?: number; offset?: number },
  ): Promise<ListMessageRouteDeliveriesResponse> {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", params.limit.toString());
    if (params?.offset) search.set("offset", params.offset.toString());
    const raw = await clientFetch<unknown>(this,
      `/api/message-routes/${routeId}/message-deliveries?${search}`,
    );
    return parseWithFallback(
      raw,
      ListMessageRouteDeliveriesResponseSchema,
      EMPTY_LIST_MESSAGE_ROUTE_DELIVERIES_RESPONSE,
      { endpoint: "GET /api/message-routes/:routeId/message-deliveries" },
    );
  },

  async getMessageRouteDelivery(
    this: ApiClient,
    routeId: string,
    deliveryId: string,
  ): Promise<GetMessageRouteDeliveryResponse> {
    const raw = await clientFetch<unknown>(this,
      `/api/message-routes/${routeId}/message-deliveries/${deliveryId}`,
    );
    return parseWithFallback(
      raw,
      GetMessageRouteDeliveryResponseSchema,
      emptyMessageRouteDeliveryDetail(deliveryId),
      { endpoint: "GET /api/message-routes/:routeId/message-deliveries/:deliveryId" },
    );
  },

  async retryMessageRouteDelivery(
    this: ApiClient,
    routeId: string,
    deliveryId: string,
  ): Promise<MessageSourceDelivery> {
    const raw = await clientFetch<unknown>(this,
      `/api/message-routes/${routeId}/message-deliveries/${deliveryId}/retry`,
      { method: "POST" },
    );
    const parsed = parseConfirmedWrite(raw, MessageSourceDeliveryResponseSchema,
      "POST /api/message-routes/:routeId/message-deliveries/:deliveryId/retry",
      (value) => Boolean(value.delivery.id));
    return parsed.delivery;
  },

  // Team outbound-target approvals are a workspace owner/admin consent
  // surface, scoped to the exact (source_kind, project range, bot, target);
  // the server answers 403 message_target_admin_required for plain members.
  async listMessageSourceApprovedTargets(this: ApiClient): Promise<ListMessageSourceApprovedTargetsResponse> {
    const raw = await clientFetch<unknown>(this, "/api/message-approved-targets");
    return parseRequiredResponse(raw, ListMessageSourceApprovedTargetsResponseSchema, "GET /api/message-approved-targets");
  },

  async approveMessageSourceTarget(
    this: ApiClient,
    data: ApproveMessageSourceTargetRequest,
  ): Promise<MessageSourceApprovedTarget> {
    const raw = await clientFetch<unknown>(this, "/api/message-approved-targets", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const parsed = parseConfirmedWrite(raw, ApproveMessageSourceTargetResponseSchema,
      "POST /api/message-approved-targets",
      (value) => Boolean(value.approved_target.id));
    return parsed.approved_target;
  },

  // Revoke soft-revokes the grant and cancels the scope's not-yet-started
  // sends in one transaction; the response reports the cancelled count.
  async revokeMessageSourceTarget(
    this: ApiClient,
    targetId: string,
  ): Promise<RevokeMessageTargetResponse> {
    const raw = await clientFetch<unknown>(this, `/api/message-approved-targets/${targetId}`, {
      method: "DELETE",
    });
    return parseConfirmedWrite(
      raw,
      RevokeMessageTargetResponseSchema,
      "DELETE /api/message-approved-targets/:targetId",
      (value) => value.revoked === true,
    );
  },
};

export type LabrastroMessageDeliveryApi = typeof labrastroMessageDeliveryApi;

export function installLabrastroMessageDeliveryApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroMessageDeliveryApi);
}
