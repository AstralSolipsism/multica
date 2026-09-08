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
