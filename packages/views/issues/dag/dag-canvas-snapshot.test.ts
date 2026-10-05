// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { IssueGraph } from "@multica/core/api";
import { selectCanvasSnapshot, type CanvasSnapshot } from "./dag-canvas-snapshot";
import { computeDagProjection } from "./dag-projection";
import { graphNode, issueGraph } from "./dag-test-fixtures";

function snapshot(graph: IssueGraph, key: string, collapsed: string[] = []): CanvasSnapshot {
  return { key, graph, projection: computeDagProjection(graph, collapsed) };
}

function twoLines() {
  return issueGraph([
    graphNode("one"),
    graphNode("a", { parentIssueId: "one" }),
    graphNode("b", { parentIssueId: "one" }),
    graphNode("two"),
    graphNode("c", { parentIssueId: "two" }),
  ], [["a", "b"], ["b", "c"]]);
}

describe("canvas snapshots during replacement layout", () => {
  it("returns current content when its layout key is already committed", () => {
    const graph = twoLines();
    const committed = snapshot(graph, "same-layout");
    const current = snapshot({ ...graph, snapshotId: "new-content" }, "same-layout");

    expect(selectCanvasSnapshot(current, committed)).toBe(current);
  });

  it("keeps the committed projection for a local fold on the same graph", () => {
    const graph = twoLines();
    const committed = snapshot(graph, "expanded");
    const current = snapshot(graph, "folded", ["issue:one"]);

    expect(selectCanvasSnapshot(current, committed)).toBe(committed);
  });

  it("excludes a card and its routes when the card changes task lines", () => {
    const graph = twoLines();
    const currentGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "a" ? { ...node, parentIssueId: "two" } : node),
    };
    const committed = snapshot(graph, "old-membership");
    const current = snapshot(currentGraph, "new-membership");
    const selected = selectCanvasSnapshot(current, committed)!;

    expect(selected.graph).toBe(currentGraph);
    expect(selected.projection!.nodes.map((node) => node.id).sort()).toEqual([
      "b", "c", "issue:one", "issue:two",
    ]);
    expect(selected.projection!.edges).toEqual(
      current.projection!.edges.filter((edge) => edge.source === "b" && edge.target === "c"),
    );
    expect(selected.projection!.edges).toHaveLength(1);
  });

  it("excludes a reparented task line and every descendant until their new layout commits", () => {
    const graph = issueGraph([
      graphNode("one"),
      graphNode("nested", { parentIssueId: "one" }),
      graphNode("leaf", { parentIssueId: "nested" }),
      graphNode("a", { parentIssueId: "one" }),
      graphNode("two"),
      graphNode("b", { parentIssueId: "two" }),
    ], [["leaf", "b"]]);
    const currentGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "one" ? { ...node, parentIssueId: "two" } : node),
    };
    const selected = selectCanvasSnapshot(
      snapshot(currentGraph, "reparented"),
      snapshot(graph, "original-parents"),
    )!;

    expect(selected.projection!.nodes.map((node) => node.id).sort()).toEqual(["b", "issue:two"]);
    expect(selected.projection!.groups.map((group) => group.id)).toEqual(["issue:two"]);
    expect(selected.projection!.edges).toEqual([]);
  });

  it.each([false, true])("keeps committed collapsed=%s during a concurrent graph refresh", (collapsed) => {
    const graph = twoLines();
    const currentGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "one" ? { ...node, title: "Updated title" } : node),
    };
    const selected = selectCanvasSnapshot(
      snapshot(currentGraph, "new-fold", collapsed ? [] : ["issue:one"]),
      snapshot(graph, "committed-fold", collapsed ? ["issue:one"] : []),
    )!;

    expect(selected.projection!.groups.find((group) => group.id === "issue:one")!.collapsed).toBe(collapsed);
    expect(selected.projection!.nodes.find((node) => node.id === "issue:one")!.title).toBe("Updated title");
  });
});
