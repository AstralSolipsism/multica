"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { youShouldKnowKeys } from "./queries";
import type { IssueTipList, SetTipStateRequest } from "../api/labrastro-ysk-schemas";

interface SetTipStateVariables {
  tipId: string;
  request: SetTipStateRequest;
}

interface SetTipStateContext {
  /** [queryKey, cached list] pairs captured before the optimistic patch. */
  snapshots: [readonly unknown[], IssueTipList][];
}

/**
 * Optimistically writes this user's state onto the tip in every cached YSK
 * list (active + per-issue). On failure rolls back only rows that still match
 * the optimistic value; on settle invalidates, but only when no other
 * mutation of this hook is still queued (same contract as
 * useUpdateNotificationPreferences).
 */
export function useSetTipState() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();

  return useMutation<void, Error, SetTipStateVariables, SetTipStateContext>({
    mutationKey: youShouldKnowKeys.all(wsId),
    scope: { id: `you-should-know-state:${wsId}` },
    mutationFn: ({ tipId, request }) => api.setTipState(tipId, request),
    onMutate: async ({ tipId, request }) => {
      // Cancel in-flight refetches so a stale response cannot overwrite the
      // optimistic patch.
      const snapshots = qc
        .getQueriesData<IssueTipList>({ queryKey: youShouldKnowKeys.all(wsId) })
        .map(([key, data]) => [key, data] as [readonly unknown[], IssueTipList]);
      await Promise.all(
        snapshots.map(([key]) => qc.cancelQueries({ queryKey: key })),
      );
      for (const [key] of snapshots) {
        qc.setQueryData<IssueTipList>(key, (old) =>
          old
            ? {
                ...old,
                tips: old.tips.map((tip) =>
                  tip.id === tipId
                    ? { ...tip, my_state: { state: request.state, feedback: request.feedback } }
                    : tip,
                ),
              }
            : old,
        );
      }
      return { snapshots };
    },
    onError: (_error, { tipId, request }, context) => {
      for (const [key, snapshot] of context?.snapshots ?? []) {
        qc.setQueryData<IssueTipList>(key, (old) => {
          if (!old) return snapshot ?? old;
          return {
            ...old,
            tips: old.tips.map((tip) => {
              // A later mutation that already changed this row wins.
              if (tip.id !== tipId || tip.my_state?.state !== request.state) {
                return tip;
              }
              const restored = snapshot?.tips.find((t) => t.id === tipId);
              return restored ?? tip;
            }),
          };
        });
      }
    },
    onSettled: (_data, _error, _variables, _context) => {
      // This mutation is still counted during onSettled; reconcile only after
      // every queued optimistic patch for this workspace finishes.
      if (qc.isMutating({ mutationKey: youShouldKnowKeys.all(wsId) }) > 1) return;
      qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
    },
  });
}
