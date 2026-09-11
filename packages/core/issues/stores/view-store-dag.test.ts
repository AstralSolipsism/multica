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
  it("defaults to LR direction, project grouping and an uninitialized fold", () => {
    const state = makeStore().getState();
    expect(state.dagDirection).toBe("LR");
    expect(state.dagGrouping).toBe("project");
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
      dagGrouping: "project",
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
    expect(merged.dagGrouping).toBe("project");
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
});
