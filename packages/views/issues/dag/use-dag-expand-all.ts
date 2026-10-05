import { useCallback, useEffect, useRef, useState } from "react";
import { useViewStoreApi } from "@multica/core/issues/stores/view-store-context";
import type { DagLayoutState } from "./use-dag-layout";
import type { CanvasSnapshot } from "./dag-canvas-snapshot";

const CANCEL_AFTER_MS = 5000;
export function useDagExpandAll(
  layout: DagLayoutState<CanvasSnapshot>,
  key: string,
  lineIds: string[],
) {
  const store = useViewStoreApi();
  const backup = useRef<{ ids: string[]; previousKey: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!layout.pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [layout.pending]);
  useEffect(() => {
    if (
      backup.current &&
      key !== backup.current.previousKey &&
      layout.snapshot?.key === key
    )
      backup.current = null;
  }, [key, layout.snapshot?.key]);
  const expandAll = useCallback(() => {
    const state = store.getState();
    backup.current = { ids: state.dagExpandedIds, previousKey: key };
    state.setDagExpandedIds([
      ...new Set([...state.dagExpandedIds, ...lineIds]),
    ]);
  }, [store, key, lineIds]);
  const collapseAll = useCallback(() => {
    backup.current = null;
    store.getState().setDagExpandedIds([]);
  }, [store]);
  const cancelPendingLayout = useCallback(() => {
    layout.cancel();
    if (backup.current) {
      store.getState().setDagExpandedIds(backup.current.ids);
      backup.current = null;
    }
  }, [layout, store]);
  const layoutPendingLong =
    layout.pending &&
    layout.pendingSince !== null &&
    now - layout.pendingSince > CANCEL_AFTER_MS;
  return { expandAll, collapseAll, cancelPendingLayout, layoutPendingLong };
}
