// Fork-owned realtime subscriptions for engineering WebSocket events. Use
// `useRealtimeSync` wires this in with one call; the invalidation rules live
// here so the upstream file keeps only a thin plug
// (see docs/engineering/upstream-sync-checklist.md).

import type { QueryClient } from "@tanstack/react-query";
import type { WSClient } from "../api/ws-client";
import { getCurrentWsId } from "../platform/workspace-storage";
import { engineeringProjectKeys } from "../projects/engineering-queries";
import type {
  ProjectBaselineChangedPayload,
  ProjectBaselineCommentChangedPayload,
  ProjectEngineeringUpdatedPayload,
} from "../types/events";

/** Subscribes engineering cache invalidation; returns the unsubscribe fn. */
export function subscribeLabrastroEngineeringEvents(
  ws: WSClient,
  qc: QueryClient,
): () => void {
  const unsubProjectEngineeringUpdated = ws.on("project_engineering:updated", (p) => {
    const { project_id } = p as ProjectEngineeringUpdatedPayload;
    const wsId = getCurrentWsId();
    if (wsId && project_id) {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineering(wsId, project_id) });
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringConfig(wsId, project_id) });
    }
  });

  const unsubProjectBaselineChanged = ws.on("project_baseline:changed", (p) => {
    const { project_id } = p as ProjectBaselineChangedPayload;
    const wsId = getCurrentWsId();
    if (wsId && project_id) {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.wikiRoot(wsId, project_id) });
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineering(wsId, project_id) });
    }
  });

  const unsubProjectBaselineCommentChanged = ws.on("project_baseline_comment:changed", (p) => {
    const { project_id, page_id, thread_id } = p as ProjectBaselineCommentChangedPayload;
    const wsId = getCurrentWsId();
    if (wsId && project_id) {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.wikiThreads(wsId, project_id, page_id) });
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.wikiThread(wsId, project_id, thread_id) });
      // Only page reads carrying the affected footer need refreshing. Tree and
      // task context never acquire a dependency on comment contents or counts.
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.wikiRoot(wsId, project_id), predicate: (query) => {
        const data = query.state.data;
        return query.queryKey[4] === "page" && typeof data === "object" && data !== null &&
          "page" in data && typeof data.page === "object" && data.page !== null && "id" in data.page && data.page.id === page_id;
      } });
    }
  });

  return () => {
    unsubProjectEngineeringUpdated();
    unsubProjectBaselineChanged();
    unsubProjectBaselineCommentChanged();
  };
}
