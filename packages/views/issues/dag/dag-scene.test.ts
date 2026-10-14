// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dagSceneKey, type DagSceneInput } from "./dag-scene";

const scene: DagSceneInput = {
  kind: "line",
  id: "line",
  grid: false,
  nodes: [
    { id: "a", parentId: "sub", width: 248, height: 116, stage: 1 },
    { id: "b", parentId: "line", width: 248, height: 116, stage: 2 },
  ],
  frames: [
    { id: "line", modelId: "line-model", parentId: null },
    { id: "sub", modelId: "sub-model", parentId: "line" },
  ],
  edges: [
    { id: "a-b", source: "a", target: "b", sourceKind: "task", targetKind: "task" },
    { id: "sub-b", source: "sub", target: "b", sourceKind: "frame", targetKind: "task" },
  ],
};

const changes: [string, (input: DagSceneInput) => void][] = [
  ["scene kind", (input) => { input.kind = "focus"; }],
  ["scene ID", (input) => { input.id = "other"; }],
  ["grid mode", (input) => { input.grid = true; }],
  ["node ID", (input) => { input.nodes[0]!.id = "other"; }],
  ["node parent", (input) => { input.nodes[0]!.parentId = "line"; }],
  ["node width", (input) => { input.nodes[0]!.width += 1; }],
  ["node height", (input) => { input.nodes[0]!.height += 1; }],
  ["node stage", (input) => { input.nodes[0]!.stage = 2; }],
  ["node side", (input) => { input.nodes[0]!.side = "upstream"; }],
  ["frame ID", (input) => { input.frames[1]!.id = "other"; }],
  ["frame model ID", (input) => { input.frames[1]!.modelId = "other-model"; }],
  ["frame parent", (input) => { input.frames[1]!.parentId = null; }],
  ["frame side", (input) => { input.frames[1]!.side = "downstream"; }],
  ["edge ID", (input) => { input.edges[0]!.id = "other"; }],
  ["edge source", (input) => { input.edges[0]!.source = "b"; }],
  ["edge target", (input) => { input.edges[0]!.target = "a"; }],
  ["edge source kind", (input) => { input.edges[0]!.sourceKind = "frame"; }],
  ["edge target kind", (input) => { input.edges[0]!.targetKind = "frame"; }],
  ["node order", (input) => { input.nodes.reverse(); }],
  ["frame order", (input) => { input.frames.reverse(); }],
  ["edge order", (input) => { input.edges.reverse(); }],
  ["node membership", (input) => { input.nodes.pop(); }],
  ["frame membership", (input) => { input.frames.pop(); }],
  ["edge membership", (input) => { input.edges.pop(); }],
];

describe("scene content cache identity", () => {
  it("has the same key for equivalent independently allocated input", () => {
    expect(dagSceneKey(structuredClone(scene))).toBe(dagSceneKey(scene));
  });

  it.each(changes)("invalidates after changing %s", (_name, change) => {
    const changed = structuredClone(scene);
    change(changed);

    expect(dagSceneKey(changed)).not.toBe(dagSceneKey(scene));
  });
});
