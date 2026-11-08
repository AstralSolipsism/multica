import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { autopilotKeys } from "../autopilots/queries";
import type { ListMessageDeliveriesResponse } from "../types";

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
 * loaded pages poll — fast while the first page has an in-flight row, slow otherwise —
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
    refetchInterval: (query) => deliveriesRefetchInterval(query.state.data?.pages),
  });
}

function deliveriesRefetchInterval(
  pages: readonly ListMessageDeliveriesResponse[] | undefined,
): number {
  return pages?.[0]?.deliveries.some((d) => isInFlight(d.status)) ? 5_000 : 30_000;
}

/** How long a finished run's deliveries keep polling: the compensator creates
 *  missed deliveries within about a minute of completion. */
export const RUN_DELIVERIES_SETTLE_MS = 10 * 60_000;

const FINISHED_RUN_STATUSES = new Set(["completed", "failed", "skipped"]);

/**
 * Poll for one run's deliveries in a Run History row. Automatic retries put a
 * delivery back to `queued`, so once the run has finished, nothing is in
 * flight and the settle window has passed, only a manual retry can change the
 * rows — and that invalidates the query for whoever pressed it. Twenty idle
 * rows would otherwise each re-read every 30s for as long as the page is open.
 * Only the latest read succeeding proves the rows settled: a failed first
 * read, or a failed refetch over cached rows, keeps the 30s recovery.
 */
export function runDeliveriesRefetchInterval(
  run: { status: string; completed_at: string | null },
  state: {
    status: "pending" | "error" | "success";
    data?: { pages: readonly ListMessageDeliveriesResponse[] };
  },
  now: number,
): number | false {
  const interval = deliveriesRefetchInterval(state.data?.pages);
  if (interval !== 30_000 || state.status !== "success" || !FINISHED_RUN_STATUSES.has(run.status)) {
    return interval;
  }
  const completedAt = run.completed_at ? Date.parse(run.completed_at) : Number.NaN;
  if (!Number.isFinite(completedAt)) return interval;
  return now - completedAt < RUN_DELIVERIES_SETTLE_MS ? interval : false;
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
