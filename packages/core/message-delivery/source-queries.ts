import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Query keys for the OL-27 personal/team notification-source surface
 * (/api/message-routes, /api/message-approved-targets, the event catalog).
 * Rooted per-workspace, separate from the automation-scoped
 * messageDeliveryKeys: these routes are not produced by autopilots and no
 * websocket event covers them, so the records queries poll (same pattern as
 * the automation records surface).
 *
 * The records-list key carries the route id and status filter so filtered or
 * per-route views never share a cache entry; page position inside a scope is
 * managed by the infinite query's pageParam (offset).
 */
export const messageSourceKeys = {
  all: (wsId: string) => ["message-sources", wsId] as const,
  catalog: (wsId: string) => [...messageSourceKeys.all(wsId), "catalog"] as const,
  routes: (wsId: string, sourceKind?: string) =>
    [...messageSourceKeys.all(wsId), "routes", sourceKind ?? "all"] as const,
  routesAll: (wsId: string) => [...messageSourceKeys.all(wsId), "routes"] as const,
  approvedTargets: (wsId: string) =>
    [...messageSourceKeys.all(wsId), "approved-targets"] as const,
  deliveries: (wsId: string, routeId: string, status?: string) =>
    [...messageSourceKeys.all(wsId), "deliveries", routeId, status ?? "all"] as const,
  deliveriesAll: (wsId: string) =>
    [...messageSourceKeys.all(wsId), "deliveries"] as const,
  delivery: (wsId: string, routeId: string, deliveryId: string) =>
    [
      ...messageSourceKeys.all(wsId),
      "deliveries",
      routeId,
      "detail",
      deliveryId,
    ] as const,
};

/**
 * The event/filter catalog behind both config surfaces. Member-gated; a
 * server without OL-27 answers 404, which the views render as an explicit
 * unsupported state (never as an empty catalog). `retry: false` because
 * 403/404 are stable answers for this caller, not transient failures.
 */
export function messageEventCatalogOptions(
  wsId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageSourceKeys.catalog(wsId),
    queryFn: () => api.getMessageEventCatalog(),
    enabled: options?.enabled ?? true,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Routes for one scope (`inbox` = the acting member's own rules; `activity` /
 * `comment` = team rules, owner/admin only server-side). Omit `sourceKind`
 * for the unfiltered list (own inbox rules plus, for owners/admins, team
 * rules). Callers gate team reads on the current member's role instead of
 * burning a forbidden request.
 */
export function messageSourceRoutesOptions(
  wsId: string,
  sourceKind?: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageSourceKeys.routes(wsId, sourceKind),
    queryFn: () => api.listMessageSourceRoutes(sourceKind),
    select: (data) => data.routes,
    enabled: options?.enabled ?? true,
    retry: false,
    // No websocket event covers source routes: another client disabling a
    // rule must surface on reopen, on window focus, and while the settings
    // page stays open — never show a stale "enabled".
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
}

/**
 * Team outbound-target approvals (workspace owner/admin only — other roles
 * get 403 message_target_admin_required, so callers pass `enabled` from the
 * current member's role instead of burning a forbidden request). Same refresh
 * contract as the routes list: a revocation by another client must surface on
 * reopen/focus/poll instead of lingering as a stale "approved".
 */
export function messageSourceApprovedTargetsOptions(
  wsId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageSourceKeys.approvedTargets(wsId),
    queryFn: () => api.listMessageSourceApprovedTargets(),
    select: (data) => data.approved_targets,
    enabled: options?.enabled ?? true,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
}

/** Fixed legal page size for the records surface (server caps at 200). */
export const MESSAGE_ROUTE_DELIVERIES_PAGE_SIZE = 100;

function isInFlight(status: string): boolean {
  return status === "queued" || status === "sending";
}

/**
 * Delivery records for one source route, paginated by offset at a fixed
 * legal page size. There is deliberately NO run filter on this surface:
 * source records are located by `source_ref_id`, and borrowing the
 * automation run query would misread non-run rows.
 *
 * Refresh: no websocket event covers worker write-backs, so the first page
 * polls — fast while any row is in flight, slow otherwise.
 */
export function messageRouteDeliveriesInfiniteOptions(
  wsId: string,
  routeId: string,
  scope?: { status?: string },
  options?: { enabled?: boolean },
) {
  return infiniteQueryOptions({
    queryKey: messageSourceKeys.deliveries(wsId, routeId, scope?.status),
    queryFn: ({ pageParam }) =>
      api.listMessageRouteDeliveries(routeId, {
        status: scope?.status,
        limit: MESSAGE_ROUTE_DELIVERIES_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.deliveries.length < MESSAGE_ROUTE_DELIVERIES_PAGE_SIZE
        ? undefined
        : last.offset + MESSAGE_ROUTE_DELIVERIES_PAGE_SIZE,
    enabled: options?.enabled ?? true,
    retry: false,
    refetchInterval: (query) => {
      const first = query.state.data?.pages[0];
      return first?.deliveries.some((d) => isInFlight(d.status)) ? 5_000 : 30_000;
    },
  });
}

/**
 * Full source-delivery detail: frozen content/target snapshots, the
 * source-record locator and the per-shard receipt ledger. Polls fast while
 * the delivery is in flight; `staleTime: 0` + refetch-on-mount mean reopening
 * never replays a stale terminal state.
 */
export function messageRouteDeliveryOptions(
  wsId: string,
  routeId: string,
  deliveryId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: messageSourceKeys.delivery(wsId, routeId, deliveryId),
    queryFn: () => api.getMessageRouteDelivery(routeId, deliveryId),
    enabled: options?.enabled ?? true,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data && isInFlight(query.state.data.delivery.status) ? 5_000 : false,
  });
}
