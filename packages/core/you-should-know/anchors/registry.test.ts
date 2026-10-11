// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createTipAnchorRegistry } from "./registry";

const measure = () => 0;

describe("createTipAnchorRegistry", () => {
  it("registers and unregisters anchors", () => {
    const registry = createTipAnchorRegistry();
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      measure,
    });
    expect(Object.keys(registry.getState().anchors)).toEqual(["a1"]);
    expect(registry.getState().anchors["a1"]).toMatchObject({ visible: false });
    registry.getState().unregister("a1");
    expect(registry.getState().anchors).toEqual({});
  });

  it("tracks viewport visibility", () => {
    const registry = createTipAnchorRegistry();
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      measure,
    });
    registry.getState().setAnchorVisible("a1", true);
    expect(registry.getState().anchors["a1"]!.visible).toBe(true);
  });

  it("does not notify subscribers on a no-op register or visibility update", () => {
    const registry = createTipAnchorRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      measure,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    registry.getState().register({
      id: "a1",
      descriptor: { level: "row", issueId: "issue-1" },
      measure,
    });
    registry.getState().setAnchorVisible("a1", false);
    registry.getState().unregister("missing");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("updates a descriptor in place: keeps visibility and display references", () => {
    const registry = createTipAnchorRegistry();
    registry.getState().register({
      id: "a1",
      descriptor: { level: "summary", scope: { "issue-1": "OL-1" } },
      measure,
    });
    registry.getState().setAnchorVisible("a1", true);
    registry.getState().setDisplay({
      bubbleAnchorId: "a1",
      dotAnchorIds: ["a1"],
    });
    // The summary's scope grows (infinite scroll loaded another page): the
    // anchor must not drop its visibility, bubble, or dots.
    registry.getState().register({
      id: "a1",
      descriptor: {
        level: "summary",
        scope: { "issue-1": "OL-1", "issue-2": "OL-2" },
      },
      measure,
    });
    const anchor = registry.getState().anchors["a1"]!;
    expect(anchor.descriptor).toEqual({
      level: "summary",
      scope: { "issue-1": "OL-1", "issue-2": "OL-2" },
    });
    expect(anchor.visible).toBe(true);
    expect(registry.getState().display).toEqual({
      bubbleAnchorId: "a1",
      dotAnchorIds: ["a1"],
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
      measure,
    });
    registry.getState().register({
      id: "a2",
      descriptor: { level: "row", issueId: "issue-2" },
      measure,
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
