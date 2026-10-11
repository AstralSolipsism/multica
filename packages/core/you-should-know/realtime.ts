"use client";

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { WSClient } from "../api/ws-client";
import { getCurrentWsId } from "../platform/workspace-storage";
import { youShouldKnowKeys } from "./queries";
import type { IssueTip, IssueTipList, IssueTipMyState } from "../api/labrastro-ysk-schemas";
import type {
  IssueTipChangedPayload,
  IssueTipStateChangedPayload,
} from "../types";

/** Debounce window for task-lifecycle invalidations of the active list. */
const ACTIVE_REFRESH_DEBOUNCE_MS = 750;

/** Patch `my_state` on one tip across every cached YSK list. */
function applyTipStateToCaches(
  qc: QueryClient,
  wsId: string,
  tipId: string,
  myState: IssueTipMyState | null,
) {
  for (const [key] of qc.getQueriesData<IssueTipList>({
    queryKey: youShouldKnowKeys.all(wsId),
  })) {
    qc.setQueryData<IssueTipList>(key, (old) =>
      old
        ? {
            ...old,
            tips: old.tips.map((tip): IssueTip =>
              tip.id === tipId ? { ...tip, my_state: myState } : tip,
            ),
          }
        : old,
    );
  }
}

/**
 * Keeps the You Should Know caches in sync with WS events (OL-187 §13 H).
 *
 * - `issue_tip:created` / `issue_tip:updated`: invalidate the issue's tip
 *   lists and the active list; without `issue_id`, invalidate all YSK queries.
 * - `issue_tip_state:changed`: patch `my_state` in place when the payload
 *   carries `tip_id` + `state` (this is what makes a tip vanish in every
 *   other tab of the same user); otherwise invalidate.
 * - task lifecycle events: debounced active-list refresh — whenever an agent
 *   starts or stops working, the active tip set changes.
 * - reconnect: invalidate everything (events may have been missed).
 */
export function useYouShouldKnowRealtimeSync(ws: WSClient | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!ws) return;

    const onTipChanged = (payload: unknown) => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      const { issue_id: issueId } = payload as IssueTipChangedPayload;
      if (!issueId) {
        qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
        return;
      }
      // The issue sub-keys live under the workspace prefix, so one broad
      // invalidate covers both the issue lists and the active list.
      qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
    };

    const onTipStateChanged = (payload: unknown) => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      const { tip_id: tipId, state, feedback } =
        payload as IssueTipStateChangedPayload;
      if (tipId && state) {
        applyTipStateToCaches(qc, wsId, tipId, { state, feedback: feedback ?? null });
      } else {
        qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
      }
    };

    let activeTimer: ReturnType<typeof setTimeout> | null = null;
    const onTaskLifecycle = () => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = setTimeout(() => {
        activeTimer = null;
        qc.invalidateQueries({ queryKey: youShouldKnowKeys.active(wsId) });
      }, ACTIVE_REFRESH_DEBOUNCE_MS);
    };

    const unsubTipCreated = ws.on("issue_tip:created", onTipChanged);
    const unsubTipUpdated = ws.on("issue_tip:updated", onTipChanged);
    const unsubTipState = ws.on("issue_tip_state:changed", onTipStateChanged);
    const unsubTaskRunning = ws.on("task:running", onTaskLifecycle);
    const unsubTaskCompleted = ws.on("task:completed", onTaskLifecycle);
    const unsubTaskFailed = ws.on("task:failed", onTaskLifecycle);
    const unsubTaskCancelled = ws.on("task:cancelled", onTaskLifecycle);
    const unsubReconnect = ws.onReconnect(() => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
    });

    return () => {
      unsubTipCreated();
      unsubTipUpdated();
      unsubTipState();
      unsubTaskRunning();
      unsubTaskCompleted();
      unsubTaskFailed();
      unsubTaskCancelled();
      unsubReconnect();
      if (activeTimer) clearTimeout(activeTimer);
    };
  }, [ws, qc]);
}
