// Fork-owned realtime subscriptions for engineering WebSocket events. Use
// `useRealtimeSync` wires this in with one call; the invalidation rules live
// here so the upstream file keeps only a thin plug
// (see docs/engineering/upstream-sync-checklist.md).

import type { QueryClient } from "@tanstack/react-query";
import type { WSClient } from "../api/ws-client";
import { getCurrentWsId } from "../platform/workspace-storage";
import { engineeringProjectKeys } from "../projects/engineering-queries";
import type {
  ProjectBaselineAnnotationChangedPayload,
  ProjectBaselineChangedPayload,
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
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineering(wsId, project_id) });
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringHistoryAll(wsId, project_id) });
      // A new working revision changes server-side annotation location/
      // located projections; refresh them together with the engineering data.
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.baselineAnnotationsAll(wsId, project_id) });
    }
  });

  const unsubProjectBaselineAnnotationChanged = ws.on("project_baseline_annotation:changed", (p) => {
    const { project_id } = p as ProjectBaselineAnnotationChangedPayload;
    const wsId = getCurrentWsId();
    if (wsId && project_id) {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.baselineAnnotationsAll(wsId, project_id) });
    }
  });

  return () => {
    unsubProjectEngineeringUpdated();
    unsubProjectBaselineChanged();
    unsubProjectBaselineAnnotationChanged();
  };
}
