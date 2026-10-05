import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueGraph } from "@multica/core/api";
import { useViewStoreApi } from "@multica/core/issues/stores/view-store-context";
import { repsToRevealIssues, type DagProjection } from "./dag-projection";
import type { DagLayoutState } from "./use-dag-layout";
import type { CanvasSnapshot } from "./dag-canvas-snapshot";
import type { DagCanvasProps } from "./dag-canvas";

type FocusTarget = { issueIds: string[]; groupId?: string };
export function useDagRevealRequests(
  graph: IssueGraph | undefined,
  projection: DagProjection | null,
  collapsedIds: string[],
  layout: DagLayoutState<CanvasSnapshot>,
  key: string,
) {
  const store = useViewStoreApi();
  const [focusRequest, setFocusRequest] =
    useState<DagCanvasProps["focusRequest"]>(null);
  const pending = useRef<FocusTarget | null>(null);
  const focus = useCallback(
    (target: FocusTarget) =>
      setFocusRequest((current) => ({
        ...target,
        nonce: (current?.nonce ?? 0) + 1,
      })),
    [],
  );
  useEffect(() => {
    if (
      !pending.current ||
      layout.pending ||
      layout.error ||
      layout.snapshot?.key !== key
    )
      return;
    focus(pending.current);
    pending.current = null;
  }, [layout.pending, layout.error, layout.snapshot?.key, key, focus]);
  const expand = useCallback(
    (ids: string[]) => {
      const state = store.getState();
      state.setDagExpandedIds([...new Set([...state.dagExpandedIds, ...ids])]);
    },
    [store],
  );
  const onFocusGroup = useCallback(
    (id: string) => {
      const group = projection?.groups.find((g) => g.id === id);
      if (!group) return;
      const target = { issueIds: [], groupId: id };
      if (!group.collapsed) {
        pending.current = null;
        focus(target);
        return;
      }
      pending.current = target;
      if (group.independent) store.getState().setDagIndependentExpanded(true);
      else expand([id]);
    },
    [projection, store, focus, expand],
  );
  const onRevealIssues = useCallback(
    (issueIds: string[]) => {
      if (!graph) return;
      const reps = repsToRevealIssues(graph, collapsedIds, issueIds);
      const target = { issueIds };
      if (!reps.length) {
        pending.current = null;
        focus(target);
        return;
      }
      pending.current = target;
      expand(reps);
    },
    [graph, collapsedIds, focus, expand],
  );
  return { focusRequest, onFocusGroup, onRevealIssues };
}
