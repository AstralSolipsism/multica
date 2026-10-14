// @vitest-environment node
import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { layoutDagScene } from "./dag-scene-layout";
import { fallbackDagScene } from "./dag-scene-fallback";
import { dagSceneSegments, routeDagOverlays } from "./dag-scene-geometry";
import type { DagSceneEdge, DagSceneGeometry, DagSceneInput } from "./dag-scene";

const engine = new ELK();
const node = (id: string, parentId: string | null = null, stage: number | null = null) => ({ id, parentId, stage, width: 248, height: 116 });
const frame = (id: string, parentId: string | null = null) => ({ id, modelId: id, parentId });
const edge = (source: string, target: string, sourceKind: "task" | "frame" = "task", targetKind: "task" | "frame" = "task"): DagSceneEdge => ({ id: `${source}->${target}`, source, target, sourceKind, targetKind });
const input = (nodes: DagSceneInput["nodes"], edges: DagSceneInput["edges"], frames: DagSceneInput["frames"] = []): DagSceneInput => ({ kind: "line", id: "line", nodes, edges, frames });
function invariants(scene: DagSceneInput, result: DagSceneGeometry) {
  expect(Object.keys(result.routes).sort()).toEqual(scene.edges.map((e) => e.id).sort());
  for (const [id, box] of Object.entries({ ...result.nodes, ...result.frames })) {
    const ports = result.ports[id]!;
    expect(Object.keys(ports).sort()).toEqual(["input", "output"]);
    expect(ports.input.x).toBeCloseTo(box.x);
    expect(ports.output.x).toBeCloseTo(box.x + box.width);
    for (const p of Object.values(ports)) expect(p.y).toBeGreaterThanOrEqual(box.y);
  }
  for (const e of scene.edges) {
    const path = result.routes[e.id]!;
    expect(path[0]!.x).toBeCloseTo(result.ports[e.source]!.output.x, 2);
    expect(path[0]!.y).toBeCloseTo(result.ports[e.source]!.output.y, 2);
    expect(path.at(-1)!.x).toBeCloseTo(result.ports[e.target]!.input.x, 2);
    expect(path.at(-1)!.y).toBeCloseTo(result.ports[e.target]!.input.y, 2);
    for (let i = 1; i < path.length; i++) expect(path[i]!.x === path[i - 1]!.x || path[i]!.y === path[i - 1]!.y).toBe(true);
    if (result.quality === "elk") for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      for (const [id, box] of Object.entries(result.nodes)) {
        if (id === e.source || id === e.target) continue;
        const hit = a.x === b.x
          ? a.x > box.x + 0.01 && a.x < box.x + box.width - 0.01 && Math.max(a.y, b.y) > box.y + 0.01 && Math.min(a.y, b.y) < box.y + box.height - 0.01
          : a.y > box.y + 0.01 && a.y < box.y + box.height - 0.01 && Math.max(a.x, b.x) > box.x + 0.01 && Math.min(a.x, b.x) < box.x + box.width - 0.01;
        expect(hit, `${e.id} must not cross card ${id}`).toBe(false);
      }
      for (const box of Object.values(result.frames)) {
        if (a.x !== b.x || a.x <= box.x + 0.01 || a.x >= box.x + box.width - 0.01) continue;
        for (const y of [box.y, box.y + box.height]) expect(Math.min(a.y, b.y) < y - 0.01 && Math.max(a.y, b.y) > y + 0.01, `${e.id} crosses a frame top/bottom`).toBe(false);
      }
    }
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      const covered = result.segments.filter((s) => s.edgeIds.includes(e.id) && (a.x === b.x
        ? s.start.x === a.x && s.end.x === a.x && Math.min(s.start.y, s.end.y) >= Math.min(a.y, b.y) && Math.max(s.start.y, s.end.y) <= Math.max(a.y, b.y)
        : s.start.y === a.y && s.end.y === a.y && Math.min(s.start.x, s.end.x) >= Math.min(a.x, b.x) && Math.max(s.start.x, s.end.x) <= Math.max(a.x, b.x)));
      expect(covered.reduce((sum, s) => sum + Math.abs(s.end.x - s.start.x) + Math.abs(s.end.y - s.start.y), 0)).toBeCloseTo(Math.abs(b.x - a.x) + Math.abs(b.y - a.y), 2);
    }
  }
}

describe("Stage 8 scene geometry", () => {
  it("packs disconnected overview components instead of making one tall column", async () => {
    const scene = { ...input(Array.from({ length: 20 }, (_, i) => node(`card:${i}`)), [edge("card:0", "card:1"), edge("card:1", "card:2")]), kind: "overview" as const };
    const result = await layoutDagScene(scene, engine);
    invariants(scene, result);
    expect(result.width).toBeGreaterThan(248 * 3);
    expect(result.height).toBeLessThan(116 * 10);
  });
  it("has single centered ports, orthogonal branches, dots and deterministic output", async () => {
    const scene = input([node("a"), node("b"), node("c"), node("d")], [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")]);
    const result = await layoutDagScene(scene, engine);
    invariants(scene, result);
    for (const [id, box] of Object.entries(result.nodes)) expect(result.ports[id]!.input.y).toBe(box.y + 58);
    expect(result.segments.some((s) => s.edgeIds.length === 2)).toBe(true);
    expect(result.junctions.length).toBeGreaterThanOrEqual(2);
    expect(await layoutDagScene(scene, engine)).toEqual(result);
  });
  it("keeps unrelated coincident and transitive-related parallel paths separate", () => {
    const edges = [edge("a", "b"), edge("a", "d"), edge("c", "d")];
    const routes = Object.fromEntries(edges.map((e) => [e.id, [{ x: 0, y: 0 }, { x: 100, y: 0 }]]));
    const geometry = dagSceneSegments(edges, routes);
    expect(geometry.segments.some((s) => s.edgeIds.includes("a->b") && s.edgeIds.includes("c->d"))).toBe(false);
    expect(geometry.junctions).toEqual([]);
  });
  it("uses frame faces across nested boundaries and preserves hierarchy", async () => {
    const scene = input([node("a", "line"), node("b", "sub"), node("c", "sub"), node("d", "line")], [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("a", "sub", "task", "frame"), edge("sub", "d", "frame")], [frame("line"), frame("sub", "line")]);
    const result = await layoutDagScene(scene, engine);
    invariants(scene, result);
    expect(result.frames.sub!.x).toBeGreaterThan(result.frames.line!.x);
    expect(result.frames.sub!.x + result.frames.sub!.width).toBeLessThan(result.frames.line!.x + result.frames.line!.width);
    expect(result.frames.line!.bands).toEqual([]);
  });
  it("enables safe leaf-stage columns but yields to reverse dependencies", async () => {
    const scene = input([node("a", "sub", 1), node("b", "sub", 2), node("c", "sub", 3)], [edge("a", "b"), edge("b", "c")], [frame("line"), frame("sub", "line")]);
    const result = await layoutDagScene(scene, engine);
    expect(result.frames.sub!.bands.map((b) => b.stage)).toEqual([1, 2, 3]);
    expect(result.frames.line!.stageMode).toBe("labels");
    const reversed = await layoutDagScene({ ...scene, edges: [edge("b", "a")] }, engine);
    expect(reversed.frames.sub!.stageMode).toBe("labels");
  });
  it("pins external cards to the left and right of the complete line", async () => {
    const scene = input([{ ...node("in"), side: "upstream" }, node("a", "line"), node("b", "line"), { ...node("out"), side: "downstream" }], [edge("in", "b"), edge("a", "b"), edge("a", "out")], [frame("line")]);
    const result = await layoutDagScene(scene, engine);
    invariants(scene, result);
    expect(result.nodes.in!.x + 248).toBeLessThan(result.frames.line!.x);
    expect(result.nodes.out!.x).toBeGreaterThan(result.frames.line!.x + result.frames.line!.width);
  });
  it("preserves nested wrapper frames and stage bands around a line with external edges", async () => {
    const scene = input([{ ...node("in"), side: "upstream" }, node("a", "leaf", 1), node("b", "leaf", 2), { ...node("out"), side: "downstream" }], [edge("in", "a"), edge("a", "b"), edge("b", "out")], [frame("line"), frame("middle", "line"), frame("leaf", "middle")]);
    const result = await layoutDagScene(scene, engine);
    invariants(scene, result);
    for (const [parent, child] of [["line", "middle"], ["middle", "leaf"]]) {
      const outer = result.frames[parent!]!, inner = result.frames[child!]!;
      expect(inner.x).toBeGreaterThan(outer.x);
      expect(inner.y).toBeGreaterThan(outer.y + 76);
      expect(inner.x + inner.width).toBeLessThan(outer.x + outer.width);
      expect(inner.y + inner.height).toBeLessThan(outer.y + outer.height);
    }
    expect(result.frames.leaf!.bands.map((band) => band.stage)).toEqual([1, 2]);
  });
  it("restores serial cards and edge identities while retaining branches and stage boundaries in ELK", async () => {
    const scene = input([{ ...node("in"), side: "upstream" }, node("a", "line", 1), node("b", "line", 1), node("c", "line", 1), node("d", "line", 2), node("e", "line", 2)], [edge("in", "a"), edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("c", "e")], [frame("line")]);
    const original = structuredClone(scene);
    let solvedCards = 0;
    const result = await layoutDagScene(scene, { async layout(graph) {
      const count = (n: import("elkjs/lib/elk-api").ElkNode): number => n.children ? n.children.reduce((sum, child) => sum + count(child), 0) : 1;
      solvedCards = count(graph);
      return engine.layout(graph);
    } });
    expect(solvedCards).toBe(4);
    expect(scene).toEqual(original);
    invariants(scene, result);
    for (const [source, target] of [["a", "b"], ["b", "c"]]) {
      expect(result.nodes[target!]!.x - result.nodes[source!]!.x).toBe(248 + 64);
      expect(result.nodes[target!]!.y).toBe(result.nodes[source!]!.y);
    }
    expect(result.frames.line!.bands.map((band) => band.stage)).toEqual([1, 2]);
    expect(Object.keys(result.routes).sort()).toEqual(scene.edges.map((e) => e.id).sort());
  });
  it("orders disconnected late-stage tasks inside a leaf frame without inventing dependencies", async () => {
    const scene = input([node("late", "line", 7), node("early", "line", 1), node("middle", "line", 3)], [], [frame("line")]);
    const result = await layoutDagScene(scene, engine);
    expect(result.frames.line!.bands.map((band) => band.stage)).toEqual([1, 3, 7]);
    expect(result.nodes.early!.x + 248).toBeLessThan(result.nodes.middle!.x);
    expect(result.nodes.middle!.x + 248).toBeLessThan(result.nodes.late!.x);
    expect(result.routes).toEqual({}); expect(result.segments).toEqual([]);
  });
  it("leaves a serial-looking cycle with an incoming branch for ELK to solve", async () => {
    const scene = input([node("a", "line"), node("b", "line"), node("c", "line")], [edge("a", "b"), edge("b", "c"), edge("c", "b")], [frame("line")]);
    const result = await layoutDagScene(scene, { async layout(graph) {
      expect(graph.children![0]!.children).toHaveLength(3);
      return engine.layout(graph);
    } });
    invariants(scene, result);
  });
  it("keeps every earlier-stage member left of the next stage when only some have dependency paths", async () => {
    const scene = input([node("linked", "sub", 1), node("disconnected", "sub", 1), node("next", "sub", 2)], [edge("linked", "next")], [frame("line"), frame("sub", "line")]);
    const result = await layoutDagScene(scene, engine);
    invariants(scene, result);
    expect(result.frames.sub!.bands.map((band) => band.stage)).toEqual([1, 2]);
    for (const id of ["linked", "disconnected"]) expect(result.nodes[id]!.x + 248).toBeLessThan(result.nodes.next!.x);
  });
  it("routes satisfied overlays without moving boxes and supports independent grids", async () => {
    const scene = input([node("a"), node("b"), node("c")], [edge("a", "b")]);
    const result = await layoutDagScene(scene, engine), original = structuredClone(result);
    const overlay = routeDagOverlays(result, [edge("a", "b"), edge("c", "a")]);
    expect(overlay.routes["a->b"]).toEqual(result.routes["a->b"]);
    expect(overlay.routes["c->a"]).toBeDefined();
    expect(result).toEqual(original);
    const grid = await layoutDagScene({ ...scene, grid: true, edges: [] }, engine);
    expect(grid.quality).toBe("grid");
    expect(grid.nodes.a!.y).toEqual(grid.nodes.c!.y);
  });
  it("degrades cyclic and nested input to finite orthogonal geometry", () => {
    const scene = input([node("a", "line"), node("b", "sub")], [edge("a", "b"), edge("b", "a")], [frame("line"), frame("sub", "line")]);
    const result = fallbackDagScene(scene);
    expect(result.quality).toBe("fallback");
    invariants(scene, result);
    expect(fallbackDagScene(scene)).toEqual(result);
  });
  it("composes base and satisfied overlay trunk membership before styling", async () => {
    const scene = input([node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")]);
    const result = await layoutDagScene(scene, engine);
    const composed = routeDagOverlays(result, [scene.edges[1]!], [scene.edges[0]!]);
    expect(composed.segments.some((s) => s.edgeIds.includes("a->b") && s.edgeIds.includes("a->c"))).toBe(true);
    expect(Object.keys(composed.routes)).toHaveLength(2);
  });
});
