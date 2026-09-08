import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Query keys for the Labrastro message-delivery surface (automation result
 * push). Scoped per (wsId, autopilotId); the records list key includes the
 * status filter so filtered pages never share a cache entry.
 */
export const messageDeliveryKeys = {
  all: (wsId: string) => ["message-delivery", wsId] as const,
  autopilot: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.all(wsId), "autopilot", autopilotId] as const,
  routes: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "routes"] as const,
  approvedTargets: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "approved-targets"] as const,
  deliveries: (wsId: string, autopilotId: string, status?: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "deliveries", status ?? "all"] as const,
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

/**
 * Delivery records page. `status` filters server-side; the projection is
 * slim (no content/target snapshots). Detail is fetched on demand via
 * messageDeliveryOptions when a row is opened.
 */
export function messageDeliveriesOptions(
  wsId: string,
  autopilotId: string,
  params?: { status?: string; limit?: number; offset?: number },
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageDeliveryKeys.deliveries(wsId, autopilotId, params?.status),
    queryFn: () => api.listMessageDeliveries(autopilotId, params),
    enabled: options?.enabled ?? true,
    retry: false,
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
