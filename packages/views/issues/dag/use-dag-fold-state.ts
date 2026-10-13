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
} from "@multica/core/issues/dag";

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
  // filter hides keeps its fold state untouched until it reappears. The
  // projection reports the hidden lines itself — folded-away nested sub-lines
  // are absent from its groups but are still visible lines.
  const hiddenLineIds = useMemo(
    () => projection?.hiddenLineIds ?? [],
    [projection],
  );
  const visibleLineIds = useMemo(() => {
    const hidden = new Set(hiddenLineIds);
    return lineIds.filter((id) => !hidden.has(id));
  }, [lineIds, hiddenLineIds]);
  const visibleCollapsedIds = useMemo(
    () => visibleLineIds.filter((id) => !expandedIds.includes(id)),
    [visibleLineIds, expandedIds],
  );
  // Disabled only when a click could not change anything: every expansion
  // belongs to a completed-hidden line (collapse-all preserves those). Inert
  // expansions stay reachable — collapse-all is their only escape hatch.
  const collapseAllDisabled = useMemo(() => {
    const hidden = new Set(hiddenLineIds);
    return expandedIds.every((id) => hidden.has(id));
  }, [expandedIds, hiddenLineIds]);
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
    collapseAllDisabled,
    hiddenLineIds,
    collapsedIds,
    projection,
    onToggleCollapsed,
  };
}
