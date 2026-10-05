// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  mergeViewStatePersisted,
  viewStorePersistOptions,
  viewStoreSlice,
  type IssueViewState,
} from "./view-store";

function makeStore() {
  return createStore<IssueViewState>()(viewStoreSlice);
}

describe("dag view preferences", () => {
  it("defaults to LR direction, task-line grouping and no expanded lines", () => {
    const state = makeStore().getState();
    expect(state.dagDirection).toBe("LR");
    expect(state.dagGrouping).toBe("parent");
    expect(state.dagExpandedIds).toEqual([]);
  });
  it("changes direction", () => {
    const store = makeStore();
    store.getState().setDagDirection("TB");
    expect(store.getState().dagDirection).toBe("TB");
  });
  it("toggles expansions without needing the current graph", () => {
    const store = makeStore();
    store.getState().toggleDagExpanded("issue:one");
    expect(store.getState().dagExpandedIds).toEqual(["issue:one"]);
    store.getState().toggleDagExpanded("issue:two");
    store.getState().toggleDagExpanded("issue:one");
    expect(store.getState().dagExpandedIds).toEqual(["issue:two"]);
  });
  it("replaces expansions and restores the default with an empty list", () => {
    const store = makeStore();
    store.getState().setDagExpandedIds(["issue:one"]);
    expect(store.getState().dagExpandedIds).toEqual(["issue:one"]);
    store.getState().setDagExpandedIds([]);
    expect(store.getState().dagExpandedIds).toEqual([]);
  });
  it("persists expanded IDs and never writes the old collapsed list", () => {
    const snapshot = viewStorePersistOptions("test").partialize(makeStore().getState());
    expect(snapshot).toMatchObject({ dagDirection: "LR", dagGrouping: "parent", dagExpandedIds: [] });
    expect(snapshot).not.toHaveProperty("dagCollapsedIds");
  });
  it("accepts and deduplicates expansion lists but rejects malformed preferences", () => {
    const current = makeStore().getState();
    expect(mergeViewStatePersisted({ dagExpandedIds: ["issue:x", "issue:x"] }, current).dagExpandedIds).toEqual(["issue:x"]);
    for (const dagExpandedIds of [null, "oops", ["issue:x", 12]]) {
      expect(mergeViewStatePersisted({ dagExpandedIds }, current).dagExpandedIds).toEqual([]);
    }
  });
  it("resets legacy folds once while preserving other personal preferences", () => {
    const current = makeStore().getState();
    for (const dagCollapsedIds of [null, [], ["issue:x"]]) {
      const merged = mergeViewStatePersisted({ dagCollapsedIds, dagDirection: "TB", dagIndependentExpanded: true }, current);
      expect(merged.dagExpandedIds).toEqual([]);
      expect(merged).not.toHaveProperty("dagCollapsedIds");
      expect(merged.dagDirection).toBe("TB");
      expect(merged.dagIndependentExpanded).toBe(true);
    }
    const saved = viewStorePersistOptions("test").partialize({ ...current, dagExpandedIds: ["issue:y"] });
    expect(mergeViewStatePersisted(saved, current).dagExpandedIds).toEqual(["issue:y"]);
  });

  it("merge degrades unknown enum values to the defaults", () => {
    const current = makeStore().getState();
    const merged = mergeViewStatePersisted(
      { dagDirection: "sideways", dagGrouping: "wild" },
      current,
    );
    expect(merged.dagDirection).toBe("LR");
    expect(merged.dagGrouping).toBe("parent");
    expect(
      mergeViewStatePersisted({ dagDirection: "TB", dagGrouping: "none" }, current)
        .dagDirection,
    ).toBe("TB");
  });

  it("a server view definition can seed dag mode plus its display defaults", () => {
    const current = makeStore().getState();
    const merged = mergeViewStatePersisted(
      { viewMode: "dag", dagDirection: "TB", dagGrouping: "parent" },
      current,
    );
    expect(merged.viewMode).toBe("dag");
    expect(merged.dagDirection).toBe("TB");
    expect(merged.dagGrouping).toBe("parent");
  });
  it("persists independent expansion and viewport while keeping selection session-only", () => {
    const store = makeStore();
    store.getState().setDagIndependentExpanded(true);
    store.getState().setDagViewport({ x: 40, y: -80, zoom: 1.1 });
    store.getState().setDagSelectedNodeId("task-a");
    store.getState().setDagExpandedIds([]);
    const saved = viewStorePersistOptions("test").partialize(store.getState());
    expect(saved).toMatchObject({ dagIndependentExpanded: true, dagViewport: { x: 40, y: -80, zoom: 1.1 } });
    expect(saved).not.toHaveProperty("dagSelectedNodeId");
    expect(mergeViewStatePersisted(saved, makeStore().getState()).dagViewport).toEqual(saved.dagViewport);
  });
  it("uses safe defaults for old or malformed personal layout preferences", () => {
    const initial = makeStore().getState();
    expect(mergeViewStatePersisted({}, initial)).toMatchObject({ dagIndependentExpanded: false, dagViewport: null });
    for (const dagViewport of [{ x: NaN, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 0 }, { x: 0, y: 0, zoom: Infinity }]) {
      expect(mergeViewStatePersisted({ dagViewport }, initial).dagViewport).toBeNull();
    }
  });

  it("keeps a personal viewport when applying a partial shared-view definition", () => {
    const store = makeStore();
    store.getState().setDagViewport({ x: -240, y: -100, zoom: 1 });
    const merged = mergeViewStatePersisted({ viewMode: "dag", dagDirection: "TB" }, store.getState());
    expect(merged.dagViewport).toEqual({ x: -240, y: -100, zoom: 1 });
  });

});
