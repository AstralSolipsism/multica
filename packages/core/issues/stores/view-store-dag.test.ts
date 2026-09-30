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
  it("defaults to LR direction, task-line grouping and an uninitialized fold", () => {
    const state = makeStore().getState();
    expect(state.dagDirection).toBe("LR");
    expect(state.dagGrouping).toBe("parent");
    expect(state.dagCollapsedIds).toBeNull();
  });

  it("toggles direction and grouping", () => {
    const store = makeStore();
    store.getState().setDagDirection("TB");
    store.getState().setDagGrouping("parent");
    expect(store.getState().dagDirection).toBe("TB");
    expect(store.getState().dagGrouping).toBe("parent");
  });

  it("first fold initializes from the default collapse, then toggles", () => {
    const store = makeStore();
    store.getState().toggleDagCollapsed("project:p1", ["project:p1", "issue:f1"]);
    expect(store.getState().dagCollapsedIds).toEqual(["issue:f1"]);
    store.getState().toggleDagCollapsed("project:p2", ["project:p1", "issue:f1"]);
    expect(store.getState().dagCollapsedIds).toEqual(["issue:f1", "project:p2"]);
  });

  it("setDagCollapsedIds replaces the fold wholesale, including re-arming the default", () => {
    const store = makeStore();
    store.getState().setDagCollapsedIds(["project:p1"]);
    expect(store.getState().dagCollapsedIds).toEqual(["project:p1"]);
    store.getState().setDagCollapsedIds(null);
    expect(store.getState().dagCollapsedIds).toBeNull();
  });

  it("partialize persists the dag preferences", () => {
    const partialize = viewStorePersistOptions("test").partialize;
    const snapshot = partialize(makeStore().getState());
    expect(snapshot).toMatchObject({
      dagDirection: "LR",
      dagGrouping: "parent",
      dagCollapsedIds: null,
    });
  });

  it("merge keeps null, accepts arrays and rejects garbage", () => {
    const current = makeStore().getState();
    expect(
      mergeViewStatePersisted({ dagCollapsedIds: null }, current).dagCollapsedIds,
    ).toBeNull();
    expect(
      mergeViewStatePersisted({ dagCollapsedIds: ["issue:x"] }, current)
        .dagCollapsedIds,
    ).toEqual(["issue:x"]);
    expect(
      mergeViewStatePersisted({ dagCollapsedIds: "oops" }, current).dagCollapsedIds,
    ).toBeNull();
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
    store.getState().setDagCollapsedIds([]);
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
