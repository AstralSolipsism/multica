"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WSClient } from "../api/ws-client";
import { issueKeys } from "../issues/queries";
import { getCurrentWsId } from "../platform/workspace-storage";

const WORKSPACE_USAGE_THROTTLE_MS = 30_000;
const TERMINAL_TASK_EVENTS = ["task:completed", "task:failed", "task:cancelled"] as const;

export function useWorkspaceUsageRealtimeSync(ws: WSClient | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!ws) return;

    let lastInvalidatedAt = Number.NEGATIVE_INFINITY;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingWsId: string | null = null;

    const invalidate = (wsId: string) => {
      lastInvalidatedAt = Date.now();
      void qc.invalidateQueries({ queryKey: issueKeys.workspaceUsage(wsId) });
    };

    const onTerminalTask = () => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      pendingWsId = wsId;
      const remaining = WORKSPACE_USAGE_THROTTLE_MS - (Date.now() - lastInvalidatedAt);
      if (!trailingTimer && remaining <= 0) {
        pendingWsId = null;
        invalidate(wsId);
        return;
      }
      if (trailingTimer) return;
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        const targetWsId = pendingWsId;
        pendingWsId = null;
        if (targetWsId) invalidate(targetWsId);
      }, Math.max(0, remaining));
    };

    const unsubscribes = TERMINAL_TASK_EVENTS.map((event) => ws.on(event, onTerminalTask));
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      if (trailingTimer) clearTimeout(trailingTimer);
    };
  }, [ws, qc]);
}
