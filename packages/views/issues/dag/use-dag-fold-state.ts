import { useCallback, useMemo } from "react";
import type { IssueGraph } from "@multica/core/api";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import {
  computeDagProjection,
  defaultDagCollapsedIds,
  DAG_INDEPENDENT_GROUP,
} from "./dag-projection";

export function useDagFoldState(graph: IssueGraph | undefined) {
  const store = useViewStoreApi();
  const expandedIds = useViewStore((s) => s.dagExpandedIds);
  const independentExpanded = useViewStore((s) => s.dagIndependentExpanded);
  const showCompleted = useViewStore((s) => s.dagShowCompleted);
  const lineIds = useMemo(
    () => (graph ? defaultDagCollapsedIds(graph) : []),
    [graph],
  );
  const collapsedIds = useMemo(
    () => lineIds.filter((id) => !expandedIds.includes(id)),
    [lineIds, expandedIds],
  );
  const projection = useMemo(
    () =>
      graph
        ? computeDagProjection(graph, collapsedIds, independentExpanded, showCompleted)
        : null,
    [graph, collapsedIds, independentExpanded, showCompleted],
  );
  // Batch expand/collapse act on visible lines only: a line the completed
  // filter hides keeps its fold state untouched until it reappears.
  const visibleLineIds = useMemo(
    () => projection?.groups.filter((g) => !g.independent).map((g) => g.id) ?? [],
    [projection],
  );
  const visibleCollapsedIds = useMemo(
    () => visibleLineIds.filter((id) => !expandedIds.includes(id)),
    [visibleLineIds, expandedIds],
  );
  const hiddenLineIds = useMemo(
    () => lineIds.filter((id) => !visibleLineIds.includes(id)),
    [lineIds, visibleLineIds],
  );
  const onToggleCollapsed = useCallback(
    (id: string) => {
      const state = store.getState();
      if (id === DAG_INDEPENDENT_GROUP)
        state.setDagIndependentExpanded(!state.dagIndependentExpanded);
      else state.toggleDagExpanded(id);
    },
    [store],
  );
  return {
    expandedIds,
    lineIds,
    visibleLineIds,
    visibleCollapsedIds,
    hiddenLineIds,
    collapsedIds,
    projection,
    onToggleCollapsed,
  };
}
