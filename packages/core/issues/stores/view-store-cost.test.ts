// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { cardPropertyOptionsForView, mergeViewStatePersisted, viewStorePersistOptions, viewStoreSlice, type IssueViewState } from "./view-store";

describe("card cost preference", () => {
  it("defaults on for old persisted preferences and preserves an explicit off across reloads", () => {
    const store = createStore<IssueViewState>()(viewStoreSlice);
    const old = mergeViewStatePersisted({ cardProperties: { priority: false } }, store.getState());
    expect(old.cardProperties).toMatchObject({ priority: false, cost: true });
    store.getState().toggleCardProperty("cost");
    const saved = viewStorePersistOptions("test").partialize(store.getState());
    expect(mergeViewStatePersisted(saved, old).cardProperties.cost).toBe(false);
  });
  it("offers Cost on board/swimlane/dag only and no unsupported DAG properties", () => {
    for (const mode of ["board", "swimlane", "dag"] as const) {
      expect(cardPropertyOptionsForView(mode).map((o) => o.key)).toContain("cost");
    }
    for (const mode of ["list", "table", "gantt"] as const) {
      expect(cardPropertyOptionsForView(mode).map((o) => o.key)).not.toContain("cost");
    }
    expect(cardPropertyOptionsForView("dag").map((o) => o.key)).toEqual(["cost"]);
  });
});
