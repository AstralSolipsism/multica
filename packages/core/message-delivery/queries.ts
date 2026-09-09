import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
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
 * The records-list key carries the status filter and the run linkage (R3)
 * so filtered/paged views never share a cache entry; page position inside a
 * scope is managed by the infinite query's pageParam (offset).
 */
export const messageDeliveryKeys = {
  all: (wsId: string) => [...autopilotKeys.all(wsId), "message-delivery"] as const,
  autopilot: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.all(wsId), autopilotId] as const,
  routes: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "routes"] as const,
  approvedTargets: (wsId: string, autopilotId: string) =>
    [...messageDeliveryKeys.autopilot(wsId, autopilotId), "approved-targets"] as const,
  deliveries: (wsId: string, autopilotId: string, status?: string, runId?: string) =>
    [
      ...messageDeliveryKeys.autopilot(wsId, autopilotId),
      "deliveries",
      status ?? "all",
      runId ?? "any",
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

/** Fixed legal page size for the records surface (server caps at 200). */
export const MESSAGE_DELIVERIES_PAGE_SIZE = 100;

function isInFlight(status: string): boolean {
  return status === "queued" || status === "sending";
}

/**
 * Delivery records, paginated by offset at a fixed legal page size (R4).
 * `scope.runId` filters to a single source run (R3) — the response's
 * `applied_run_id` echo tells the caller whether the server actually
 * applied it; views must treat a missing/mismatched echo as "unsupported
 * server", never as "no deliveries".
 *
 * Refresh: autopilot websocket events invalidate the shared prefix, and the
 * first page polls — fast while any row is in flight, slow otherwise —
 * because worker write-backs do not emit their own events.
 */
export function messageDeliveriesInfiniteOptions(
  wsId: string,
  autopilotId: string,
  scope?: { status?: string; runId?: string },
  options?: { enabled?: boolean },
) {
  return infiniteQueryOptions({
    queryKey: messageDeliveryKeys.deliveries(wsId, autopilotId, scope?.status, scope?.runId),
    queryFn: ({ pageParam }) =>
      api.listMessageDeliveries(autopilotId, {
        status: scope?.status,
        runId: scope?.runId,
        limit: MESSAGE_DELIVERIES_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.deliveries.length < MESSAGE_DELIVERIES_PAGE_SIZE
        ? undefined
        : last.offset + MESSAGE_DELIVERIES_PAGE_SIZE,
    enabled: options?.enabled ?? true,
    retry: false,
    refetchInterval: (query) => {
      const first = query.state.data?.pages[0];
      return first?.deliveries.some((d) => isInFlight(d.status)) ? 5_000 : 30_000;
    },
  });
}

/**
 * Single-page records read (compatibility surface used by the detail-refresh
 * regression and by callers that only need the first page). Paged views use
 * messageDeliveriesInfiniteOptions instead.
 */
export function messageDeliveriesOptions(
  wsId: string,
  autopilotId: string,
  params?: { status?: string; runId?: string; limit?: number; offset?: number },
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: [
      ...messageDeliveryKeys.deliveries(wsId, autopilotId, params?.status, params?.runId),
      "page",
      params?.limit ?? 0,
      params?.offset ?? 0,
    ] as const,
    queryFn: () => api.listMessageDeliveries(autopilotId, params),
    enabled: options?.enabled ?? true,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.deliveries.some((d) => isInFlight(d.status)) ? 5_000 : 30_000,
  });
}

/**
 * Full delivery detail: frozen content/target snapshots, source_ref locator
 * and the per-shard receipt ledger.
 *
 * Refresh (R1): an opened detail polls fast while the delivery is in flight;
 * `staleTime: 0` + refetch-on-mount mean reopening never replays a stale
 * terminal state, and a list row that observed a newer `updated_at`
 * invalidates this cache from the view layer.
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
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data && isInFlight(query.state.data.delivery.status) ? 5_000 : false,
  });
}
