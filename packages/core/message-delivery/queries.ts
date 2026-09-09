import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { autopilotKeys } from "../autopilots/queries";

/**
 * Query keys for the Labrastro message-delivery surface (automation result
 * push). Nested UNDER the autopilot namespace on purpose: deliveries and
 * routes are produced asynchronously by the send worker / compensator, and
 * the realtime layer already invalidates `autopilotKeys.all(wsId)` on
 * autopilot events — nesting means those events also refresh this module
 * without a second wiring point.
 *
 * The records-list key carries both the status filter and the page size so
 * filtered/paged views never share a cache entry.
 */
export const messageDeliveryKeys = {
  all: (wsId: string) => [...autopilotKeys.all(wsId), "message-delivery"] as const,
  autopilot: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.all(wsId), autopilotId] as const,
  routes: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "routes"] as const,
  approvedTargets: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "approved-targets"] as const,
  deliveries: (wsId: string, autopilotId: string, status?: string, limit?: number) =>
    [
      ...messageDeliveryKeys.autopilot(wsId, autopilotId),
      "deliveries",
      status ?? "all",
      limit ?? 0,
    ] as const,
  deliveriesAll: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "deliveries"] as const,
  delivery: (wsId: string, autopilotId: string, deliveryId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "deliveries", "detail", deliveryId] as const,
};

/**
 * messageRoutesOptions backs the "结果推送" configuration section. The
 * endpoint is gated by the SAME autopilot write gate server-side, so a
 * read-only caller gets a real 403 here — the view renders that as a
 * restricted state instead of pretending the section is empty. `retry:
 * false` because 403/404 are stable answers for this caller, not transient
 * failures.
 */
export function messageRoutesOptions(
  wsId: string,
  autopilotId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageDeliveryKeys.routes(wsId, autopilotId),
    queryFn: () => api.listMessageRoutes(autopilotId),
    select: (data) => data.routes,
    enabled: options?.enabled ?? true,
    retry: false,
  });
}

/**
 * Approved external targets (workspace owner/admin only — other roles get
 * 403 message_target_admin_required, so callers pass `enabled` from the
 * current member's role instead of burning a forbidden request).
 */
export function messageApprovedTargetsOptions(
  wsId: string,
  autopilotId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageDeliveryKeys.approvedTargets(wsId, autopilotId),
    queryFn: () => api.listMessageApprovedTargets(autopilotId),
    select: (data) => data.approved_targets,
    enabled: options?.enabled ?? true,
    retry: false,
  });
}

export const MESSAGE_DELIVERIES_PAGE_SIZE = 50;

/**
 * Delivery records page. `status` filters server-side; the projection is
 * slim (no content/target snapshots). Detail is fetched on demand via
 * messageDeliveryOptions when a row is opened.
 *
 * Refresh: autopilot websocket events invalidate the shared prefix, and the
 * list polls — fast while any row is in flight (queued/sending), slow
 * otherwise — because worker write-backs do not emit their own events.
 */
export function messageDeliveriesOptions(
  wsId: string,
  autopilotId: string,
  params?: { status?: string; limit?: number; offset?: number },
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageDeliveryKeys.deliveries(wsId, autopilotId, params?.status, params?.limit),
    queryFn: () => api.listMessageDeliveries(autopilotId, params),
    enabled: options?.enabled ?? true,
    retry: false,
    refetchInterval: (query) => {
      const rows = query.state.data?.deliveries ?? [];
      return rows.some((d) => d.status === "queued" || d.status === "sending")
        ? 5_000
        : 30_000;
    },
  });
}

/**
 * Full delivery detail: frozen content/target snapshots, source_ref locator
 * and the per-shard receipt ledger. Fetched on demand from the detail
 * dialog.
 */
export function messageDeliveryOptions(
  wsId: string,
  autopilotId: string,
  deliveryId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageDeliveryKeys.delivery(wsId, autopilotId, deliveryId),
    queryFn: () => api.getMessageDelivery(autopilotId, deliveryId),
    enabled: options?.enabled ?? true,
    retry: false,
  });
}
