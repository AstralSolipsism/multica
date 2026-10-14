// @vitest-environment node
import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { IssueGraphSchema } from "@multica/core/api";
import { computeDagLine, createDagModelIndex } from "@multica/core/issues/dag";
import { buildIssueGraphFixture } from "@multica/core/issues/testing/issue-graph-fixture";
import { layoutDagScene } from "./dag-scene-layout";
import { dagLineLayoutInput } from "./dag-scene-inputs";
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
  for (const [index, segment] of result.segments.entries()) {
    const horizontal = segment.start.y === segment.end.y;
    const axis = horizontal ? "x" : "y";
    const fixed = horizontal ? "y" : "x";
    const low = Math.min(segment.start[axis], segment.end[axis]);
    const high = Math.max(segment.start[axis], segment.end[axis]);
    expect(high).toBeGreaterThan(low);
    expect(segment.edgeIds.length).toBeGreaterThan(0);
    for (const other of result.segments.slice(index + 1)) {
      if (other.start[fixed] !== segment.start[fixed]
        || other.end[fixed] !== segment.start[fixed]) continue;
      const overlap = Math.min(high, Math.max(other.start[axis], other.end[axis]))
        - Math.max(low, Math.min(other.start[axis], other.end[axis]));
      expect(overlap, `${segment.id} overlaps ${other.id}`).toBeLessThanOrEqual(0);
    }
    const traversing = scene.edges.filter((edge) => {
      const route = result.routes[edge.id]!;
      return route.some((end, i) => {
        const start = route[i - 1];
        return start && start[fixed] === segment.start[fixed]
          && end[fixed] === segment.start[fixed]
          && Math.min(start[axis], end[axis]) <= low
          && Math.max(start[axis], end[axis]) >= high;
      });
    }).map((edge) => edge.id).sort();
    expect(segment.edgeIds, `exact membership of ${segment.id}`).toEqual(traversing);
  }
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
  it("places an earlier overview component before a later isolated card", async () => {
    const scene: DagSceneInput = {
      ...input([node("a"), node("b"), node("isolated")], [edge("a", "b")]),
      kind: "overview",
    };
    const result = await layoutDagScene(scene, engine);

    invariants(scene, result);
    const readingOrder = ["a", "isolated"].sort((first, second) => {
      const a = result.nodes[first]!;
      const b = result.nodes[second]!;
      return a.y - b.y || a.x - b.x;
    });
    expect(readingOrder).toEqual(["a", "isolated"]);
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
  it("represents coincident paths as one bus with exact membership", () => {
    const edges = [edge("a", "b"), edge("a", "d"), edge("c", "d")];
    const routes = Object.fromEntries(edges.map((e) => [e.id, [{ x: 0, y: 0 }, { x: 100, y: 0 }]]));
    const geometry = dagSceneSegments(edges, routes);
    expect(geometry.segments).toEqual([{
      id: "segment:0", start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
      edgeIds: ["a->b", "a->d", "c->d"],
    }]);
    expect(geometry.junctions).toEqual([]);
  });
  it("canonicalizes unrelated overlaps in actual ELK output for the largest shared line", async () => {
    const index = createDagModelIndex(IssueGraphSchema.parse(buildIssueGraphFixture("accept-5000")));
    const largest = [...index.lineInputs.values()]
      .filter((line) => index.forest.children.has(line.id))
      .sort((a, b) => b.members.length - a.members.length)[0]!;
    const scene = dagLineLayoutInput(computeDagLine(index, largest.id)!).input;
    const result = await layoutDagScene(scene, engine);

    invariants(scene, result);
    const byId = new Map(scene.edges.map((edge) => [edge.id, edge]));
    expect(result.segments.some((segment) => segment.edgeIds.some((id, i) => {
      const first = byId.get(id)!;
      return segment.edgeIds.slice(i + 1).some((other) => {
        const second = byId.get(other)!;
        return first.source !== second.source && first.target !== second.target;
      });
    }))).toBe(true);
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
  it("keeps converging tasks connected to the same target within one frame and stage", async () => {
    const scene = input(
      [node("a", "line", 1), node("x", "line", 1), node("b", "line", 1)],
      [edge("a", "b"), edge("x", "b")],
      [frame("line")],
    );
    const result = await layoutDagScene(scene, engine);

    invariants(scene, result);
    expect(Object.keys(result.nodes).sort()).toEqual(["a", "b", "x"]);
    expect(result.routes["a->b"]!.at(-1)).toEqual(result.ports.b!.input);
    expect(result.routes["x->b"]!.at(-1)).toEqual(result.ports.b!.input);
  });
  it("retains dependency endpoints on a sub-line containing only one child frame", async () => {
    const scene = input(
      [{ ...node("external"), side: "upstream" }, node("task", "leaf")],
      [edge("external", "sub", "task", "frame")],
      [frame("line"), frame("sub", "line"), frame("leaf", "sub")],
    );
    const result = await layoutDagScene(scene, engine);

    invariants(scene, result);
    expect(Object.keys(result.frames).sort()).toEqual(["leaf", "line", "sub"]);
    expect(result.routes["external->sub"]!.at(-1)).toEqual(result.ports.sub!.input);
    expect(result.frames.leaf!.x).toBeGreaterThan(result.frames.sub!.x);
    expect(result.frames.leaf!.x + result.frames.leaf!.width).toBeLessThan(
      result.frames.sub!.x + result.frames.sub!.width,
    );
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
  it("preserves focus partitions in fallback even when a cycle has no topological order", () => {
    const scene: DagSceneInput = {
      ...input(
        [node("after", "down"), node("selected", "current"), node("before", "up-child")],
        [edge("before", "selected"), edge("selected", "after"), edge("after", "before")],
        [
          { ...frame("down"), side: "downstream" },
          { ...frame("current"), side: "current" },
          { ...frame("up"), side: "upstream" },
          { ...frame("up-child", "up"), side: "upstream" },
        ],
      ),
      kind: "focus",
    };
    const result = fallbackDagScene(scene);

    expect(result.quality).toBe("fallback");
    invariants(scene, result);
    expect(result.frames.up!.x + result.frames.up!.width).toBeLessThan(
      result.frames.current!.x,
    );
    expect(result.frames.current!.x + result.frames.current!.width).toBeLessThan(
      result.frames.down!.x,
    );
    expect(result.nodes.before!.x).toBeLessThan(result.nodes.selected!.x);
    expect(result.nodes.after!.x).toBeGreaterThan(result.nodes.selected!.x);
  });
  it("pins disconnected external context cards outside a fallback line", () => {
    const scene = input(
      [
        { ...node("after"), side: "downstream" },
        node("a", "line"),
        node("b", "line"),
        { ...node("before"), side: "upstream" },
      ],
      [edge("a", "b")],
      [frame("line")],
    );
    const result = fallbackDagScene(scene);

    expect(result.quality).toBe("fallback");
    invariants(scene, result);
    expect(result.nodes.before!.x + result.nodes.before!.width).toBeLessThan(
      result.frames.line!.x,
    );
    expect(result.nodes.after!.x).toBeGreaterThan(
      result.frames.line!.x + result.frames.line!.width,
    );
  });
  it("composes base and satisfied overlay trunk membership before styling", async () => {
    const scene = input([node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")]);
    const result = await layoutDagScene(scene, engine);
    const composed = routeDagOverlays(result, [scene.edges[1]!], [scene.edges[0]!]);
    expect(composed.segments.some((s) => s.edgeIds.includes("a->b") && s.edgeIds.includes("a->c"))).toBe(true);
    expect(Object.keys(composed.routes)).toHaveLength(2);
  });
});
