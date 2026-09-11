import type { QueryClient } from "@tanstack/react-query";
import { issueKeys } from "./queries";

/** Refresh graph snapshots after a committed change, including first loads.
 * TanStack invalidation deduplicates an in-flight request with no cached data;
 * that older snapshot would then clear isInvalidated under staleTime: Infinity.
 * Cancel graph reads first, retaining any cached snapshot, then invalidate.
 * The workspace scope also covers reconnect/catalog/identifier changes without
 * changing cancellation behavior for ordinary issue lists and details. */
export function invalidateIssueQueries(
  qc: QueryClient,
  wsId: string,
  scope: "workspace" | "graph" = "workspace",
): Promise<void> {
  const graphFilters = { queryKey: issueKeys.graphAll(wsId) };
  const queryKey = scope === "graph" ? graphFilters.queryKey : issueKeys.all(wsId);
  const pendingGraphs = qc.getQueryCache().findAll(graphFilters)
    .some((query) => query.state.fetchStatus !== "idle");
  if (!pendingGraphs) return qc.invalidateQueries({ queryKey });

  // Settle cancellation before refetching so cancellation cannot revert the
  // replacement. Inactive queries stay stale and fetch only on the next mount.
  return qc.cancelQueries(graphFilters).then(() => qc.invalidateQueries({ queryKey }));
}

/** Refresh dependency projections after a committed change — the same
 *  first-load race the graph helper exists for: a projection's very first
 *  GET in flight when the invalidation lands would otherwise complete and
 *  become permanently "fresh" under staleTime: Infinity, painting an
 *  upstream as done after it reopened (OL-44 re-review). Cancel the stale
 *  in-flight read, then invalidate so the next read sees the current
 *  prerequisite state. */
export function invalidateDependencyQueries(
  qc: QueryClient,
  wsId: string,
): Promise<void> {
  const filters = { queryKey: issueKeys.dependenciesAll(wsId) };
  const pending = qc
    .getQueryCache()
    .findAll(filters)
    .some((query) => query.state.fetchStatus !== "idle");
  if (!pending) return qc.invalidateQueries(filters);
  return qc.cancelQueries(filters).then(() => qc.invalidateQueries(filters));
}
