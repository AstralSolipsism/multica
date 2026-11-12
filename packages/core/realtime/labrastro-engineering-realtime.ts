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
    const { project_id } = p as ProjectBaselineCommentChangedPayload;
    const wsId = getCurrentWsId();
    if (wsId && project_id) {
      // Comments land in a follow-up release; keep the invalidation wired so
      // the event name rename stays a single-line change there.
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.wikiRoot(wsId, project_id) });
    }
  });

  return () => {
    unsubProjectEngineeringUpdated();
    unsubProjectBaselineChanged();
    unsubProjectBaselineCommentChanged();
  };
}
