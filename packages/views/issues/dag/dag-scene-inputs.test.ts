// @vitest-environment node
import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { computeDagFocus, computeDagLine, computeDagOverview, createDagModelIndex } from "@multica/core/issues/dag";
import { graphNode, issueGraph } from "./dag-test-fixtures";
import {
  dagFocusLayoutInput,
  dagLineLayoutInput,
  dagOverviewLayoutInput,
  dagOverviewSatisfiedEdges,
} from "./dag-scene-inputs";
import { layoutDagScene } from "./dag-scene-layout";
import { dagSceneKey } from "./dag-scene";

describe("model to layout boundary", () => {
  it("excludes titles, statuses and satisfied overlays from layout identity", () => {
    const graph = issueGraph([graphNode("a"), graphNode("b"), graphNode("c", { status: "done", statusCategory: "done" })], [["a", "b"], ["c", "b"]]);
    const index = createDagModelIndex(graph);
    const base = dagOverviewLayoutInput(computeDagOverview(index, { showCompleted: true }));
    const all = dagOverviewLayoutInput(computeDagOverview(index, { showCompleted: true, showSatisfiedDependencies: true }));
    expect(dagSceneKey(base.input)).toBe(dagSceneKey(all.input));
    expect(all.overlays.map((e) => e.id)).toEqual([JSON.stringify(["c", "b"])]);
    const updated = createDagModelIndex({ ...graph, nodes: graph.nodes.map((n) => ({ ...n, title: "Updated title", status: n.status === "todo" ? "backlog" : n.status })) });
    expect(dagOverviewLayoutInput(computeDagOverview(updated, { showCompleted: true })).input).toEqual(base.input);
  });
  it("keeps mixed-bundle membership separate from its satisfied subset", () => {
    const index = createDagModelIndex(issueGraph([graphNode("line"), graphNode("a", { parentIssueId: "line" }), graphNode("b", { parentIssueId: "line", status: "done", statusCategory: "done" }), graphNode("c")], [["a", "c"], ["b", "c"]]));
    const model = computeDagOverview(index), plan = dagOverviewLayoutInput(model);
    expect(Object.values(plan.dependencyIds)).toEqual([["a-c", "b-c"]]);
    expect(dagOverviewSatisfiedEdges(model, "issue:line")[0]!.dependencyIds).toEqual(["b-c"]);
  });
  it("preserves frame endpoints, drops hidden redundancy and remaps external groups", () => {
    const index = createDagModelIndex(issueGraph([graphNode("line"), ...["a", "b", "c"].map((id) => graphNode(id, { parentIssueId: "line" })), graphNode("external")], [["a", "b"], ["b", "c"], ["a", "c"], ["external", "line"]]));
    const plan = dagLineLayoutInput(computeDagLine(index, "line")!);
    expect(plan.input.edges.map((e) => e.id)).not.toContain("a-c");
    expect(plan.input.edges.find((e) => e.id === "external-line")).toMatchObject({ target: "line", targetKind: "frame" });
    expect(plan.input.nodes.find((n) => n.side === "upstream")?.width).toBe(184);
  });
  it("keeps upstream left and downstream right across split and nested focus frames", async () => {
    const index = createDagModelIndex(issueGraph([graphNode("line"), graphNode("sub", { parentIssueId: "line" }), ...["a", "focus", "b"].map((id) => graphNode(id, { parentIssueId: "sub" })), graphNode("other"), graphNode("c", { parentIssueId: "other" })], [["a", "focus"], ["focus", "b"], ["focus", "c"]]));
    const model = computeDagFocus(index, "focus"), plan = dagFocusLayoutInput(model);
    const result = await layoutDagScene(plan.input, new ELK());
    expect(result.nodes.a!.x + 248).toBeLessThan(result.nodes.focus!.x);
    expect(result.nodes.b!.x).toBeGreaterThan(result.nodes.focus!.x + 248);
    expect(result.nodes.c!.x).toBeGreaterThan(result.nodes.focus!.x + 248);
    expect(plan.input.frames.filter((f) => f.modelId === "line")).toHaveLength(3);
    expect(Object.keys(result.routes)).toHaveLength(3);
  });
  it("can focus a frame header without reintroducing descendants as cards", async () => {
    const index = createDagModelIndex(issueGraph([graphNode("line"), graphNode("child", { parentIssueId: "line" }), graphNode("before"), graphNode("after")], [["before", "line"], ["line", "after"]]));
    const plan = dagFocusLayoutInput(computeDagFocus(index, "line"));
    const result = await layoutDagScene(plan.input, new ELK());
    const focused = plan.input.frames.find((f) => f.modelId === "line" && f.side === "current")!;
    expect(result.nodes.child).toBeUndefined();
    expect(result.frames[focused.id]!.width).toBeGreaterThanOrEqual(680);
    expect(result.nodes.before!.x + 248).toBeLessThan(result.frames[focused.id]!.x);
    expect(result.nodes.after!.x).toBeGreaterThan(result.frames[focused.id]!.x + result.frames[focused.id]!.width);
  });
});

describe("focus side assignment", () => {
  it("only creates ancestor fragments that contain members or carry a dependency", () => {
    const index = createDagModelIndex(issueGraph([
      graphNode("line"), graphNode("seed", { parentIssueId: "line" }),
      graphNode("other"), graphNode("after", { parentIssueId: "other" }),
    ], [["seed", "after"]]));
    const plan = dagFocusLayoutInput(computeDagFocus(index, "seed"));
    expect(plan.input.frames.map((frame) => [frame.modelId, frame.side])).toEqual([
      ["line", "current"], ["other", "downstream"],
    ]);
    const withPrerequisite = createDagModelIndex(issueGraph([
      ...index.graph.nodes, graphNode("before"),
    ], [["seed", "after"], ["before", "line"]]));
    const inherited = dagFocusLayoutInput(computeDagFocus(withPrerequisite, "seed"));
    const ancestor = inherited.input.frames.find((frame) => frame.modelId === "line" && frame.side === "upstream")!;
    expect(ancestor).toBeDefined();
    expect(inherited.input.edges).toContainEqual(expect.objectContaining({ source: "before", target: ancestor.id }));
  });

  it("places cyclic peers alongside the seed instead of arbitrarily upstream", () => {
    const index = createDagModelIndex(issueGraph([graphNode("a"), graphNode("b"), graphNode("up"), graphNode("down")], [["a", "b"], ["b", "a"], ["up", "a"], ["b", "down"]]));
    const plan = dagFocusLayoutInput(computeDagFocus(index, "a"));
    expect(Object.fromEntries(plan.input.nodes.map((node) => [node.id, node.side]))).toEqual({ a: "current", b: "current", up: "upstream", down: "downstream" });
  });

  it("places a retained cancelled context ancestor on its descendant's side", () => {
    const index = createDagModelIndex(issueGraph([
      graphNode("cancelled", { status: "cancelled", statusCategory: "closed" }),
      graphNode("child", { parentIssueId: "cancelled", status: "cancelled", statusCategory: "closed" }),
      graphNode("seed"), graphNode("outside"), graphNode("waiter"),
    ], [["seed", "child"], ["child", "waiter"], ["cancelled", "outside"]]));
    const model = computeDagFocus(index, "seed");
    expect(model.downstreamIds.has("cancelled")).toBe(false);
    expect(model.upstreamIds.has("cancelled")).toBe(false);
    const plan = dagFocusLayoutInput(model);
    expect(plan.input.nodes.find((node) => node.id === "cancelled")?.side).toBe("downstream");
  });
});
