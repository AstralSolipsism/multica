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
        ? computeDagProjection(graph, collapsedIds, independentExpanded)
        : null,
    [graph, collapsedIds, independentExpanded],
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
  return { expandedIds, lineIds, collapsedIds, projection, onToggleCollapsed };
}
