// @vitest-environment node
import { describe, expect, it } from "vitest";
import { visibleViewMode, type ViewMode } from "../surface/view-mode";
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
  it("defaults to the overview level with both display switches off", () => {
    const state = makeStore().getState();
    expect(state.dagLineId).toBeNull();
    expect(state.dagOverviewPinned).toBe(false);
    expect(state.dagViewports).toEqual({});
    expect(state.dagGrouping).toBe("parent");
    expect(state.dagShowCompleted).toBe(false);
    expect(state.dagShowSatisfiedDependencies).toBe(false);
  });

  it("enters a line: clears the overview pin, selection and focus", () => {
    const store = makeStore();
    store.getState().exitDagLine();
    store.getState().setDagSelectedNodeId("task-a");
    store.getState().setDagFocus({ nodeId: "task-a", way: "upstream" });
    store.getState().enterDagLine("line-1");
    expect(store.getState().dagLineId).toBe("line-1");
    expect(store.getState().dagOverviewPinned).toBe(false);
    expect(store.getState().dagSelectedNodeId).toBeNull();
    expect(store.getState().dagFocus).toBeNull();
  });

  it("returns to the overview pinned, selecting the line just left", () => {
    const store = makeStore();
    store.getState().enterDagLine("line-1");
    store.getState().setDagFocus({ nodeId: "task-a", way: "downstream" });
    store.getState().exitDagLine("issue:line-1");
    expect(store.getState().dagLineId).toBeNull();
    expect(store.getState().dagOverviewPinned).toBe(true);
    expect(store.getState().dagSelectedNodeId).toBe("issue:line-1");
    expect(store.getState().dagFocus).toBeNull();
  });

  it("keeps the pin when the level is corrected without the user", () => {
    const store = makeStore();
    store.getState().exitDagLine();
    store.getState().setDagLineId("ghost-line");
    expect(store.getState().dagLineId).toBe("ghost-line");
    expect(store.getState().dagOverviewPinned).toBe(true);
    store.getState().setDagLineId(null);
    expect(store.getState().dagOverviewPinned).toBe(true);
  });

  it("persists level, pin and per-level viewports; selection stays session-only", () => {
    const store = makeStore();
    store.getState().enterDagLine("line-1");
    store.getState().setDagViewportFor("overview", { x: 40, y: -80, zoom: 1.1 });
    store.getState().setDagViewportFor("line:line-1", { x: 0, y: 0, zoom: 0.5 });
    store.getState().setDagSelectedNodeId("task-a");
    const saved = viewStorePersistOptions("test").partialize(store.getState());
    expect(saved).toMatchObject({
      dagLineId: "line-1",
      dagViewports: {
        overview: { x: 40, y: -80, zoom: 1.1 },
        "line:line-1": { x: 0, y: 0, zoom: 0.5 },
      },
    });
    expect(saved).not.toHaveProperty("dagSelectedNodeId");
    expect(saved).not.toHaveProperty("dagFocus");
    expect(saved).not.toHaveProperty("dagExpandedIds");
    expect(saved).not.toHaveProperty("dagIndependentExpanded");
    expect(saved).not.toHaveProperty("dagDirection");
    expect(saved).not.toHaveProperty("dagViewport");
    const merged = mergeViewStatePersisted(saved, makeStore().getState());
    expect(merged.dagLineId).toBe("line-1");
    expect(merged.dagViewports).toEqual(saved.dagViewports);
  });

  it("caps remembered viewports at 50 entries, never evicting the overview slot", () => {
    const store = makeStore();
    store.getState().setDagViewportFor("overview", { x: 1, y: 1, zoom: 1 });
    for (let i = 0; i < 55; i++)
      store.getState().setDagViewportFor(`line:l${i}`, { x: i, y: 0, zoom: 1 });
    const viewports = store.getState().dagViewports;
    expect(Object.keys(viewports)).toHaveLength(50);
    expect(viewports["overview"]).toEqual({ x: 1, y: 1, zoom: 1 });
    expect(viewports["line:l0"]).toBeUndefined();
    expect(viewports["line:l54"]).toEqual({ x: 54, y: 0, zoom: 1 });
    // Rewriting an existing key refreshes its recency instead of duplicating it.
    store.getState().setDagViewportFor("line:l54", { x: 999, y: 0, zoom: 1 });
    const next = store.getState().dagViewports;
    expect(Object.keys(next)).toHaveLength(50);
    expect(next["line:l54"]).toEqual({ x: 999, y: 0, zoom: 1 });
    expect(next["overview"]).toEqual({ x: 1, y: 1, zoom: 1 });
  });

  it("ignores legacy fold and direction keys carried by old preferences", () => {
    const current = makeStore().getState();
    const merged = mergeViewStatePersisted(
      {
        dagCollapsedIds: ["issue:x"],
        dagExpandedIds: ["issue:x"],
        dagIndependentExpanded: true,
        dagDirection: "TB",
        dagShowCompleted: true,
      },
      current,
    );
    expect(merged).not.toHaveProperty("dagCollapsedIds");
    expect(merged).not.toHaveProperty("dagExpandedIds");
    expect(merged).not.toHaveProperty("dagIndependentExpanded");
    expect(merged).not.toHaveProperty("dagDirection");
    expect(merged.dagShowCompleted).toBe(true);
    expect(merged.dagLineId).toBeNull();
  });

  it("migrates the legacy single viewport onto the overview slot", () => {
    const current = makeStore().getState();
    const merged = mergeViewStatePersisted(
      { dagViewport: { x: -240, y: -100, zoom: 1 } },
      current,
    );
    expect(merged.dagViewports).toEqual({ overview: { x: -240, y: -100, zoom: 1 } });
    expect(merged).not.toHaveProperty("dagViewport");
    // An explicit viewport map wins over the legacy value.
    const both = mergeViewStatePersisted(
      {
        dagViewport: { x: 1, y: 2, zoom: 1 },
        dagViewports: { "line:a": { x: 3, y: 4, zoom: 0.8 } },
      },
      current,
    );
    expect(both.dagViewports).toEqual({ "line:a": { x: 3, y: 4, zoom: 0.8 } });
  });

  it("drops malformed viewport entries and out-of-range zooms", () => {
    const current = makeStore().getState();
    const merged = mergeViewStatePersisted(
      {
        dagViewports: {
          overview: { x: 0, y: 0, zoom: 1 },
          bad: { x: NaN, y: 0, zoom: 1 },
          zoomed: { x: 0, y: 0, zoom: 99 },
          nope: "x",
        },
      },
      current,
    );
    expect(merged.dagViewports).toEqual({ overview: { x: 0, y: 0, zoom: 1 } });
    for (const dagViewports of [null, "oops", []]) {
      expect(
        mergeViewStatePersisted({ dagViewports }, current).dagViewports,
      ).toEqual({});
    }
  });

  it("validates the persisted line id and overview pin", () => {
    const current = makeStore().getState();
    expect(
      mergeViewStatePersisted({ dagLineId: "line-9", dagOverviewPinned: true }, current)
        .dagLineId,
    ).toBe("line-9");
    for (const dagLineId of [12, {}, []]) {
      expect(mergeViewStatePersisted({ dagLineId }, current).dagLineId).toBeNull();
    }
    expect(
      mergeViewStatePersisted({ dagOverviewPinned: "yes" }, current).dagOverviewPinned,
    ).toBe(false);
  });

  it("falls back safely when persisted view modes are no longer supported", () => {
    const current = makeStore().getState();
    for (const viewMode of ["unknown", "toString", null]) {
      expect(mergeViewStatePersisted({ viewMode }, current).viewMode).toBe("board");
      expect(visibleViewMode(viewMode as ViewMode, { allowDag: true, allowGantt: true })).toBe("list");
    }
    expect(visibleViewMode("dag", { allowDag: false, allowGantt: false })).toBe("list");
    expect(visibleViewMode("dag", { allowDag: true, allowGantt: false })).toBe("dag");
    expect(visibleViewMode("gantt", { allowDag: true, allowGantt: false })).toBe("list");
    expect(visibleViewMode("gantt", { allowDag: false, allowGantt: true })).toBe("gantt");
  });

  it("merge degrades unknown enum values to the defaults", () => {
    const current = makeStore().getState();
    expect(
      mergeViewStatePersisted({ dagGrouping: "wild" }, current).dagGrouping,
    ).toBe("parent");
    expect(
      mergeViewStatePersisted({ dagGrouping: "none" }, current).dagGrouping,
    ).toBe("none");
  });

  it("a server view definition seeds dag mode and its display defaults", () => {
    const current = makeStore().getState();
    const merged = mergeViewStatePersisted(
      {
        viewMode: "dag",
        dagGrouping: "parent",
        dagShowCompleted: true,
        dagShowSatisfiedDependencies: true,
        // Views saved before Stage 9 carry a direction; it is ignored.
        dagDirection: "TB",
      },
      current,
    );
    expect(merged.viewMode).toBe("dag");
    expect(merged.dagShowCompleted).toBe(true);
    expect(merged.dagShowSatisfiedDependencies).toBe(true);
    expect(merged).not.toHaveProperty("dagDirection");
  });

  it("toggles the satisfied-dependencies switch and persists it", () => {
    const store = makeStore();
    expect(store.getState().dagShowSatisfiedDependencies).toBe(false);
    store.getState().toggleDagShowSatisfiedDependencies();
    expect(store.getState().dagShowSatisfiedDependencies).toBe(true);
    const saved = viewStorePersistOptions("test").partialize(store.getState());
    expect(saved).toMatchObject({ dagShowSatisfiedDependencies: true });
    const current = makeStore().getState();
    for (const dagShowSatisfiedDependencies of ["yes", 1, null]) {
      expect(
        mergeViewStatePersisted({ dagShowSatisfiedDependencies }, current)
          .dagShowSatisfiedDependencies,
      ).toBe(false);
    }
  });

  it("defaults dagShowCompleted to hidden and degrades malformed values", () => {
    const store = makeStore();
    store.getState().toggleDagShowCompleted();
    const saved = viewStorePersistOptions("test").partialize(store.getState());
    expect(saved).toMatchObject({ dagShowCompleted: true });
    const current = makeStore().getState();
    for (const dagShowCompleted of ["yes", 1, null]) {
      expect(mergeViewStatePersisted({ dagShowCompleted }, current).dagShowCompleted).toBe(false);
    }
    // A saved view written before the field existed falls back to hidden.
    expect(mergeViewStatePersisted({ viewMode: "dag" }, current).dagShowCompleted).toBe(false);
  });

  it("clears the focus when another node is selected", () => {
    const store = makeStore();
    store.getState().setDagSelectedNodeId("a");
    store.getState().setDagFocus({ nodeId: "a", way: "downstream" });
    store.getState().setDagSelectedNodeId("b");
    expect(store.getState().dagFocus).toBeNull();
    expect(store.getState().dagSelectedNodeId).toBe("b");
  });
});

describe("focus level navigation", () => {
  it.each([null, "line-a"])("returns to %s with its pin, selection and viewport intact", (lineId) => {
    const store = makeStore();
    if (lineId) store.getState().enterDagLine(lineId);
    else store.getState().exitDagLine();
    const key = lineId ? `line:${lineId}` : "overview";
    const viewport = { x: -240, y: 18, zoom: 0.7 };
    store.getState().setDagViewportFor(key, viewport);
    store.getState().setDagSelectedNodeId("selected");
    store.getState().enterDagFocus("a");
    store.getState().setDagViewportFor("focus:a", { x: 9, y: 0, zoom: 1 });
    const saved = viewStorePersistOptions("test").partialize(store.getState());
    const restored = mergeViewStatePersisted(saved, makeStore().getState());
    expect(restored.dagFocusIssueId).toBe("a");
    expect(restored.dagLineId).toBe(lineId);
    expect(saved).not.toHaveProperty("dagFocusReturnSelection");
    store.getState().exitDagFocus();
    expect(store.getState()).toMatchObject({
      dagLineId: lineId, dagOverviewPinned: !lineId, dagFocusIssueId: null,
      dagSelectedNodeId: "selected", dagViewports: { [key]: viewport },
    });
  });
  it("validates persisted focus ids and clears focus when navigating to a line", () => {
    for (const dagFocusIssueId of [1, [], {}])
      expect(mergeViewStatePersisted({ dagFocusIssueId }, makeStore().getState()).dagFocusIssueId).toBeNull();
    const store = makeStore();
    store.getState().enterDagFocus("a");
    store.getState().enterDagLine("b");
    expect(store.getState().dagFocusIssueId).toBeNull();
  });
});
