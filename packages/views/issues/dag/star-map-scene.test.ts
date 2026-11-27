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
    expect(plan.dependencyIds["wakeup:solo:child"]).toBeUndefined();
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
    expect(dagSceneFocusSet(plan, "child", "upstream")?.edgeIds.has("wakeup:solo:child")).toBe(false);
  });
});
