// @vitest-environment node
import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  layoutDagProjection as computeLayout,
  type DagLayoutNodeInput,
  type DagLayoutGroupInput,
  type DagLayoutEdgeInput,
  type DagLayoutResult,
} from "./dag-layout";

const engine = new ELK();
const layoutDagProjection = (
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
  direction: "LR" | "TB",
  groups: DagLayoutGroupInput[] = [],
) => computeLayout(nodes, edges, direction, groups, engine);
const node = (
  id: string,
  groupId: string | null = null,
  stage: number | null = null,
): DagLayoutNodeInput => ({ id, groupId, stage, width: 248, height: 116 });
const group = (
  id: string,
  collapsed = false,
  parentId: string | null = null,
): DagLayoutGroupInput => ({ id, collapsed, parentId, independent: false });
const edge = (source: string, target: string): DagLayoutEdgeInput => ({
  id: `${source}->${target}`,
  source,
  target,
});
function routeEndpoints(result: DagLayoutResult, edges: DagLayoutEdgeInput[]) {
  expect(Object.keys(result.routes).sort()).toEqual(edges.map((e) => e.id).sort());
  for (const e of edges) {
    const path = result.routes[e.id]!;
    expect(path.length).toBeGreaterThan(1);
    for (const p of path) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    const sourcePort = result.ports[e.source]!.find((p) => p.id === `source:${e.id}`)!;
    const targetPort = result.ports[e.target]!.find((p) => p.id === `target:${e.id}`)!;
    expect(path[0]!.x).toBeCloseTo(result.positions[e.source]!.x + sourcePort.x);
    expect(path[0]!.y).toBeCloseTo(result.positions[e.source]!.y + sourcePort.y);
    expect(path.at(-1)!.x).toBeCloseTo(result.positions[e.target]!.x + targetPort.x);
    expect(path.at(-1)!.y).toBeCloseTo(result.positions[e.target]!.y + targetPort.y);
  }
}
function expectNoCardIntersections(
  result: DagLayoutResult,
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
) {
  for (const e of edges) {
    const path = result.routes[e.id]!;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!,
        b = path[i]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
      for (const n of nodes) {
        if (result.groups[n.id] || n.id === e.source || n.id === e.target) continue;
        const p = result.positions[n.id]!;
        const hit =
          a.x === b.x
            ? a.x > p.x + 0.01 &&
              a.x < p.x + n.width - 0.01 &&
              Math.max(a.y, b.y) > p.y + 0.01 &&
              Math.min(a.y, b.y) < p.y + n.height - 0.01
            : a.y > p.y + 0.01 &&
              a.y < p.y + n.height - 0.01 &&
              Math.max(a.x, b.x) > p.x + 0.01 &&
              Math.min(a.x, b.x) < p.x + n.width - 0.01;
        expect(hit, `${e.id} intersects ${n.id}`).toBe(false);
      }
    }
  }
}

describe("ELK task-line layout", () => {
  it.each(["LR", "TB"] as const)(
    "lays out a real dependency chain inside its line under %s",
    async (direction) => {
      const nodes = [node("line"), node("a", "line"), node("b", "line"), node("c", "line")];
      const edges = [edge("a", "b"), edge("b", "c")];
      const result = await layoutDagProjection(nodes, edges, direction, [group("line")]);
      const axis = direction === "LR" ? "x" : "y";
      expect(result.positions.a![axis]).toBeLessThan(result.positions.b![axis]);
      expect(result.positions.b![axis]).toBeLessThan(result.positions.c![axis]);
      routeEndpoints(result, edges);
      expectNoCardIntersections(result, nodes, edges);
    },
  );
  it.each(["LR", "TB"] as const)(
    "shows stage bands without inventing dependencies under %s",
    async (direction) => {
      const nodes = [
        node("line"),
        node("last", "line", 5),
        node("first-a", "line", 1),
        node("middle", "line", 3),
        node("first-b", "line", 1),
      ];
      const result = await layoutDagProjection(nodes, [], direction, [group("line")]);
      const axis = direction === "LR" ? "x" : "y";
      expect(result.positions["first-a"]![axis]).toBe(result.positions["first-b"]![axis]);
      expect(result.positions["first-a"]![axis]).toBeLessThan(result.positions.middle![axis]);
      expect(result.positions.middle![axis]).toBeLessThan(result.positions.last![axis]);
      expect(result.groups.line!.bands.map((b) => b.stage)).toEqual([1, 3, 5]);
      expect(result.routes).toEqual({});
    },
  );
  it.each(["LR", "TB"] as const)(
    "keeps lines in separate rows/columns and routes cross-line edges without crossing cards under %s",
    async (direction) => {
      const nodes = [
        node("one"),
        node("a", "one", 1),
        node("b", "one", 2),
        node("two"),
        node("c", "two", 1),
        node("d", "two", 2),
        node("folded"),
      ];
      const edges = [
        edge("a", "b"),
        edge("c", "d"),
        edge("a", "c"),
        edge("b", "c"),
        edge("d", "folded"),
      ];
      const result = await layoutDagProjection(nodes, edges, direction, [
        group("one"),
        group("two"),
        group("folded", true),
      ]);
      const axis = direction === "LR" ? "y" : "x",
        size = direction === "LR" ? "height" : "width";
      expect(result.groups.one![axis] + result.groups.one![size]).toBeLessThan(
        result.groups.two![axis],
      );
      expect(result.groups.two![axis] + result.groups.two![size]).toBeLessThan(
        result.groups.folded![axis],
      );
      routeEndpoints(result, edges);
      expectNoCardIntersections(result, nodes, edges);
    },
  );
  it("preserves opposite aggregate directions between folded task lines", async () => {
    const edges = [edge("one", "two"), edge("two", "one")];
    const result = await layoutDagProjection([node("one"), node("two")], edges, "LR", [
      group("one", true),
      group("two", true),
    ]);
    expect(result.groups.one!.y).toBeLessThan(result.groups.two!.y);
    routeEndpoints(result, edges);
  });
  it("joins paths across nested containers and an expanded parent's own endpoint", async () => {
    const nodes = [
      node("one"),
      node("nested", "one", 1),
      node("a", "nested"),
      node("b", "one", 2),
      node("two"),
      node("c", "two"),
    ];
    const edges = [edge("a", "b"), edge("a", "c"), edge("one", "a")];
    const result = await layoutDagProjection(nodes, edges, "LR", [
      group("one"),
      group("nested", false, "one"),
      group("two"),
    ]);
    routeEndpoints(result, edges);
    expectNoCardIntersections(result, nodes, edges);
    expect(result.groups.nested!.x).toBeGreaterThan(result.groups.one!.x);
  });
  it("keeps unordered children in a compact grid and leaves unparented stage numbers unconstrained", async () => {
    const nodes = [
      node("line"),
      ...Array.from({ length: 8 }, (_, i) => node(`n${i}`, "line")),
      node("loose", null, 9),
    ];
    const result = await layoutDagProjection(nodes, [], "LR", [group("line")]);
    expect(new Set(nodes.slice(1, 9).map((n) => result.positions[n.id]!.x)).size).toBe(3);
    expect(new Set(nodes.slice(1, 9).map((n) => result.positions[n.id]!.y)).size).toBe(3);
    expect(result.groups.line!.bands).toEqual([]);
    expect(result.positions.loose).toBeDefined();
  });
  it("honors an unstaged dependency bridge between members of the same stage", async () => {
    const nodes = [
      node("line"),
      node("a", "line", 1),
      node("b", "line"),
      node("c", "line", 1),
      node("later", "line", 2),
    ];
    const edges = [edge("a", "b"), edge("b", "c")];
    const result = await layoutDagProjection(nodes, edges, "LR", [group("line")]);
    expect(result.positions.a!.x).toBeLessThan(result.positions.b!.x);
    expect(result.positions.b!.x).toBeLessThan(result.positions.c!.x);
    expect(result.positions.c!.x).toBeLessThan(result.positions.later!.x);
    routeEndpoints(result, edges);
  });
  it("gives a real dependency path through another line priority over conflicting stages", async () => {
    const nodes = [
      node("line"),
      node("early", "line", 1),
      node("later", "line", 2),
      node("other"),
      node("outside", "other"),
    ];
    const edges = [edge("later", "outside"), edge("outside", "early")];
    const result = await layoutDagProjection(nodes, edges, "LR", [group("line"), group("other")]);
    expect(result.groups.line!.stageConflict).toBe(true);
    expect(result.groups.line!.bands).toEqual([]);
    routeEndpoints(result, edges);
    expectNoCardIntersections(result, nodes, edges);
  });
  it("does not drop real edges when stage preferences form a cross-line cycle", async () => {
    const nodes = [
      node("one"),
      node("a1", "one", 1),
      node("a2", "one", 2),
      node("two"),
      node("b1", "two", 1),
      node("b2", "two", 2),
    ];
    const edges = [edge("a2", "b1"), edge("b2", "a1")];
    const result = await layoutDagProjection(nodes, edges, "LR", [group("one"), group("two")]);
    expect(result.groups.one!.stageConflict).toBe(true);
    expect(result.groups.two!.stageConflict).toBe(true);
    routeEndpoints(result, edges);
    expectNoCardIntersections(result, nodes, edges);
  });
  it("ignores invisible endpoints and does not mutate layout inputs", async () => {
    const nodes = [node("a"), node("lonely")],
      edges = [edge("a", "hidden")];
    const before = JSON.stringify({ nodes, edges });
    const result = await layoutDagProjection(nodes, edges, "LR");
    expect(Object.keys(result.positions).sort()).toEqual(["a", "lonely"]);
    expect(result.routes).toEqual({});
    expect(JSON.stringify({ nodes, edges })).toBe(before);
  });
  it.each(["LR", "TB"] as const)(
    "keeps an unparented dependency chain directional under %s",
    async (direction) => {
      const nodes = [node("c"), node("a"), node("b"), node("independent")];
      const edges = [edge("a", "b"), edge("b", "c")];
      const result = await layoutDagProjection(nodes, edges, direction, [
        { ...group("independent", true), independent: true },
      ]);
      const axis = direction === "LR" ? "x" : "y";
      expect(result.positions.a![axis]).toBeLessThan(result.positions.b![axis]);
      expect(result.positions.b![axis]).toBeLessThan(result.positions.c![axis]);
      routeEndpoints(result, edges);
    },
  );
});

describe("free chains alongside task lines", () => {
  it.each(["LR", "TB"] as const)("keeps the free chain in its original row and independent tasks last under %s", async (direction) => {
    const nodes = [node("one"), node("b1"), node("b2"), node("two"), node("c1", "two"), node("c2", "two"), node("independent")];
    const edges = [edge("b1", "b2"), edge("b2", "c1"), edge("c1", "c2")];
    const result = await layoutDagProjection(nodes, edges, direction, [
      group("one", true), group("two"), { ...group("independent", true), independent: true },
    ]);
    const crossAxis = direction === "LR" ? "y" : "x";
    const crossSize = direction === "LR" ? "height" : "width";
    expect(result.groups.one![crossAxis] + result.groups.one![crossSize]).toBeLessThan(result.positions.b1![crossAxis]);
    expect(result.positions.b1![crossAxis] + nodes[1]![crossSize]).toBeLessThan(result.groups.two![crossAxis]);
    expect(result.groups.two![crossAxis] + result.groups.two![crossSize]).toBeLessThan(result.groups.independent![crossAxis]);
    routeEndpoints(result, edges);
    expectNoCardIntersections(result, nodes, edges);
  });

  it.each(["LR", "TB"] as const)("aligns root row slots for differently sized task lines under %s", async (direction) => {
    const result = await layoutDagProjection(
      [node("one"), node("two"), node("a", "two"), node("b", "two"), node("c", "two")],
      [edge("a", "b"), edge("b", "c")],
      direction,
      [group("one", true), group("two")],
    );
    const axis = direction === "LR" ? "x" : "y";
    expect(result.groups.one![axis]).toBeCloseTo(result.groups.two![axis]);
  });

  it.each(["LR", "TB"] as const)("retains the dependency direction and real cross-line routes under %s", async (direction) => {
    for (const collapsed of [false, true]) {
      const nodes = [node("line"), ...(!collapsed ? [node("child", "line")] : []), node("c"), node("b"), node("a")];
      const edges = [edge("a", "b"), edge("b", "c"), edge("c", collapsed ? "line" : "child")];
      const result = await layoutDagProjection(nodes, edges, direction, [group("line", collapsed)]);
      const axis = direction === "LR" ? "x" : "y";
      const crossAxis = direction === "LR" ? "y" : "x";
      const minimumGap = direction === "LR" ? 248 : 116;
      expect(result.positions.a![axis]).toBeLessThan(result.positions.b![axis]);
      expect(result.positions.b![axis]).toBeLessThan(result.positions.c![axis]);
      for (const [source, target] of [["a", "b"], ["b", "c"]]) {
        const from = result.positions[source!]!;
        const to = result.positions[target!]!;
        expect(to[axis] - from[axis]).toBeGreaterThanOrEqual(minimumGap);
        expect(Math.abs(to[crossAxis] - from[crossAxis])).toBeLessThan(1);
      }
      expect(Object.keys(result.groups)).toEqual(["line"]);
      expect(Object.keys(result.positions).sort()).toEqual(nodes.map((n) => n.id).sort());
      routeEndpoints(result, edges);
      expectNoCardIntersections(result, nodes, edges);
    }
  });
});
