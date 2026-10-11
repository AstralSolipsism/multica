// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createTipAnchorRegistry } from "./registry";

describe("createTipAnchorRegistry", () => {
  it("registers and unregisters anchors", () => {
    const registry = createTipAnchorRegistry();
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      top: 100,
    });
    expect(Object.keys(registry.getState().anchors)).toEqual(["a1"]);
    expect(registry.getState().anchors["a1"]).toMatchObject({
      visible: false,
      top: 100,
    });
    registry.getState().unregister("a1");
    expect(registry.getState().anchors).toEqual({});
  });

  it("tracks visibility and page position", () => {
    const registry = createTipAnchorRegistry();
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      top: 0,
    });
    registry.getState().setAnchorGeometry("a1", { visible: true, top: 42 });
    expect(registry.getState().anchors["a1"]).toMatchObject({
      visible: true,
      top: 42,
    });
  });

  it("does not notify subscribers on a no-op register or geometry update", () => {
    const registry = createTipAnchorRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      top: 0,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      top: 0,
    });
    registry.getState().setAnchorGeometry("a1", { visible: false, top: 0 });
    registry.getState().unregister("missing");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps live geometry across a same-id re-register", () => {
    const registry = createTipAnchorRegistry();
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      top: 0,
    });
    registry.getState().setAnchorGeometry("a1", { visible: true, top: 42 });
    // Same id, changed descriptor content (recycled row): re-registers...
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-2" },
      top: 0,
    });
    expect(registry.getState().anchors["a1"]).toMatchObject({
      descriptor: { level: "row", issueId: "issue-2" },
      visible: true,
    });
  });

  it("stores display state and skips identical writes", () => {
    const registry = createTipAnchorRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.getState().setDisplay({
      bubbleAnchorId: "a1",
      dotAnchorIds: ["a2", "a3"],
    });
    expect(registry.getState().display).toEqual({
      bubbleAnchorId: "a1",
      dotAnchorIds: ["a2", "a3"],
    });
    expect(listener).toHaveBeenCalledTimes(1);
    registry.getState().setDisplay({
      bubbleAnchorId: "a1",
      dotAnchorIds: ["a2", "a3"],
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops display references when an anchor unregisters", () => {
    const registry = createTipAnchorRegistry();
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      top: 0,
    });
    registry.getState().register({
      id: "a2",
      descriptor: { level: "row", issueId: "issue-2" },
      top: 0,
    });
    registry.getState().setDisplay({
      bubbleAnchorId: "a1",
      dotAnchorIds: ["a1", "a2"],
    });
    registry.getState().unregister("a1");
    expect(registry.getState().display).toEqual({
      bubbleAnchorId: null,
      dotAnchorIds: ["a2"],
    });
  });
});
