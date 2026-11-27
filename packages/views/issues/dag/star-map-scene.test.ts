import { describe, expect, it } from "vitest";
import { computeDagFocus, computeDagLine, createDagModelIndex } from "@multica/core/issues/dag";
import { graphNode as node, issueGraph } from "./dag-test-fixtures";
import { dagSceneFocusSet } from "./dag-scene-flow";
import { dagSceneSelectionSet } from "./dag-highlight";
import { dagExternalNodeId } from "./dag-scene";
import { starMapFocusScene, starMapLineScene } from "./star-map-scene";

function model() {
  return createDagModelIndex(issueGraph([
    node("root"),
    node("child", { parentIssueId: "root" }),
    node("other-root"),
    node("other-child", { parentIssueId: "other-root" }),
    node("solo"),
  ], [], [
    { from: "solo", to: "child", kind: "wakeup", untilState: "done" },
    { from: "child", to: "other-child", kind: "wakeup", untilState: "in_review" },
  ]));
}

describe("star map wakeup scene context", () => {
  it("pulls line peers into external columns without turning waits into blockers", () => {
    const index = model();
    const { model: sceneModel, plan } = starMapLineScene(computeDagLine(index, "root")!, index);
    expect(sceneModel.kind).toBe("line");
    if (sceneModel.kind !== "line") return;
    expect(sceneModel.line.upstream.find((group) => group.id === "solo")).toMatchObject({ count: 1, kind: "issue" });
    expect(sceneModel.line.downstream.find((group) => group.id === "other-root")).toMatchObject({ count: 1, kind: "line" });
    expect(plan.input.edges.filter((edge) => edge.kind === "wakeup")).toEqual([
      expect.objectContaining({
        source: dagExternalNodeId("upstream", "solo"), target: "child", untilState: "done",
      }),
      expect.objectContaining({
        source: "child", target: dagExternalNodeId("downstream", "other-root"), untilState: "in_review",
      }),
    ]);
    expect(plan.dependencyIds["wakeup:solo:child:done"]).toBeUndefined();
    expect(dagSceneSelectionSet(plan, "child")).toBeNull();
  });

  it("adds missing focus peers as context cards and keeps them out of dependency closure", () => {
    const index = model();
    const { model: sceneModel, plan } = starMapFocusScene(computeDagFocus(index, "child"), index);
    expect(sceneModel.kind).toBe("focus");
    if (sceneModel.kind !== "focus") return;
    expect(sceneModel.tasks.find((task) => task.issue.id === "solo")).toMatchObject({ parentId: null, role: "context" });
    expect(plan.input.nodes.find((node) => node.id === "solo")).toMatchObject({ side: "upstream", parentId: null });
    expect(plan.input.edges.some((edge) => edge.kind === "wakeup" && edge.source === "solo" && edge.target === "child")).toBe(true);
    expect(dagSceneFocusSet(plan, "child", "upstream")?.edgeIds.has("wakeup:solo:child:done")).toBe(false);
  });

  it("keeps an independent task's parent peer as a context endpoint", () => {
    const index = createDagModelIndex(issueGraph([
      node("root"), node("child", { parentIssueId: "root" }), node("solo"),
    ], [], [{ from: "solo", to: "root", kind: "wakeup" }]));
    const { model: sceneModel, plan } = starMapFocusScene(computeDagFocus(index, "solo"), index);
    expect(sceneModel.kind).toBe("focus");
    if (sceneModel.kind !== "focus") return;
    expect(sceneModel.tasks.find((task) => task.issue.id === "root")).toMatchObject({ role: "context", parentId: null });
    expect(plan.input.edges).toContainEqual(expect.objectContaining({
      id: "wakeup:solo:root:done", source: "solo", target: "root", kind: "wakeup", untilState: "done",
    }));
  });

  it("uses only original focus members when weak-edge order changes", () => {
    const weakEdges = [
      { from: "solo", to: "child", kind: "wakeup", untilState: "done" },
      { from: "peer", to: "child", kind: "wakeup", untilState: "in_review" },
    ] as const;
    const makeScene = (edges: readonly { from: string; to: string; kind: "wakeup"; untilState: string }[]) => {
      const index = createDagModelIndex(issueGraph([
        node("root"), node("child", { parentIssueId: "root" }), node("solo"), node("peer"),
      ], [], [...edges]));
      return starMapFocusScene(computeDagFocus(index, "child"), index);
    };
    const forward = makeScene(weakEdges);
    const reversed = makeScene([...weakEdges].reverse());
    expect(forward.model.tasks.map((task) => task.issue.id).sort()).toEqual(["child", "peer", "solo"]);
    expect(reversed.model.tasks.map((task) => task.issue.id).sort()).toEqual(["child", "peer", "solo"]);
    expect(reversed.plan.input.edges).toHaveLength(forward.plan.input.edges.length);
  });

  it("distinguishes waits for the same endpoints by normalized state in both scenes", () => {
    const index = createDagModelIndex(issueGraph([
      node("root"), node("child", { parentIssueId: "root" }), node("solo"),
    ], [], [
      { from: "solo", to: "child", kind: "wakeup" },
      { from: "solo", to: "child", kind: "wakeup", untilState: "in_review" },
    ]));
    const line = starMapLineScene(computeDagLine(index, "root")!, index);
    const focus = starMapFocusScene(computeDagFocus(index, "child"), index);
    for (const scene of [line, focus]) {
      expect(scene.plan.input.edges.map((edge) => edge.id)).toEqual([
        "wakeup:solo:child:done", "wakeup:solo:child:in_review",
      ]);
      expect(scene.plan.input.edges.map((edge) => edge.untilState)).toEqual(["done", "in_review"]);
      expect(scene.plan.dependencyIds).toEqual({});
    }
    expect(line.model.kind).toBe("line");
    if (line.model.kind === "line")
      expect(line.model.line.upstream.find((group) => group.id === "solo")?.count).toBe(2);
  });

  it("enables mentions explicitly without changing dependency or closure semantics", () => {
    const index = createDagModelIndex(issueGraph([
      node("root"), node("child", { parentIssueId: "root" }), node("solo"),
    ], [], [
      { from: "solo", to: "child", kind: "mention" },
      { from: "child", to: "solo", kind: "mention" },
    ]));
    expect(starMapLineScene(computeDagLine(index, "root")!, index).plan.input.edges).toHaveLength(0);
    expect(starMapFocusScene(computeDagFocus(index, "child"), index).model.tasks).toHaveLength(1);

    const line = starMapLineScene(computeDagLine(index, "root")!, index, { mention: true });
    const focus = starMapFocusScene(computeDagFocus(index, "child"), index, { mention: true });
    for (const scene of [line, focus]) {
      expect(scene.plan.input.edges).toEqual([
        expect.objectContaining({ id: "mention:solo:child:", source: expect.any(String), target: "child", kind: "mention" }),
        expect.objectContaining({ id: "mention:child:solo:", source: "child", target: expect.any(String), kind: "mention" }),
      ]);
      expect(scene.plan.dependencyIds).toEqual({});
      expect(dagSceneSelectionSet(scene.plan, "child")).toBeNull();
      expect(dagSceneFocusSet(scene.plan, "child", "upstream")?.edgeIds.size).toBe(0);
    }
    expect(focus.plan.input.edges[0]).toMatchObject({ source: "solo", target: "child" });
    expect(focus.plan.input.edges[1]).toMatchObject({ source: "child", target: "solo" });
  });

  it("connects mention and wakeup endpoints already present in the same scene", () => {
    const index = createDagModelIndex(issueGraph([
      node("root"),
      node("a", { parentIssueId: "root" }),
      node("b", { parentIssueId: "root" }),
    ], [{ id: "manual:b:a", source: "a", target: "b" }], [
      { from: "a", to: "b", kind: "mention" },
      { from: "a", to: "b", kind: "wakeup", untilState: "done" },
    ]));
    const line = starMapLineScene(computeDagLine(index, "root")!, index, { mention: true });
    expect(line.plan.input.edges).toEqual([
      expect.objectContaining({ id: "manual:b:a", source: "a", target: "b" }),
      expect.objectContaining({ id: "mention:a:b:", source: "a", target: "b", kind: "mention" }),
      expect.objectContaining({ id: "wakeup:a:b:done", source: "a", target: "b", kind: "wakeup" }),
    ]);

    const focus = starMapFocusScene(computeDagFocus(index, "a"), index, { mention: true });
    expect(focus.model.tasks.map((task) => task.issue.id).sort()).toEqual(["a", "b"]);
    expect(focus.plan.input.edges).toEqual([
      expect.objectContaining({ id: "manual:b:a", source: "a", target: "b" }),
      expect.objectContaining({ id: "mention:a:b:", source: "a", target: "b", kind: "mention" }),
      expect.objectContaining({ id: "wakeup:a:b:done", source: "a", target: "b", kind: "wakeup" }),
    ]);
  });
});
