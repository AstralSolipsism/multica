// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dagSceneSegments, routeDagOverlays } from "./dag-scene-geometry";
import { emptyDagScene } from "./dag-scene-layout";
import type { DagSceneEdge } from "./dag-scene";

const edge = (source: string, target: string): DagSceneEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  sourceKind: "task",
  targetKind: "task",
});

describe("scene route composition", () => {
  it("preserves the real ABXY dependencies through a shared bus and its junctions", () => {
    const ax = edge("A", "X");
    const ay = edge("A", "Y");
    const by = edge("B", "Y");
    const edges = [ax, ay, by];
    const routes = {
      [ax.id]: [{ x: 100, y: 182 }, { x: 150, y: 182 },
        { x: 150, y: 92 }, { x: 200, y: 92 }],
      [ay.id]: [{ x: 100, y: 182 }, { x: 150, y: 182 },
        { x: 150, y: 32 }, { x: 200, y: 32 }],
      [by.id]: [{ x: 100, y: 122 }, { x: 150, y: 122 },
        { x: 150, y: 32 }, { x: 200, y: 32 }],
    };
    const original = structuredClone(routes);
    const { segments, junctions } = dagSceneSegments(edges, routes);

    expect(routes).toEqual(original);
    expect(segments.filter((s) => s.start.x === 150 && s.end.x === 150)).toEqual([
      { id: expect.any(String), start: { x: 150, y: 32 }, end: { x: 150, y: 92 },
        edgeIds: [ay.id, by.id] },
      { id: expect.any(String), start: { x: 150, y: 92 }, end: { x: 150, y: 122 },
        edgeIds: [ax.id, ay.id, by.id] },
      { id: expect.any(String), start: { x: 150, y: 122 }, end: { x: 150, y: 182 },
        edgeIds: [ax.id, ay.id] },
    ]);
    expect(junctions).toEqual(expect.arrayContaining([
      { x: 150, y: 92, edgeIds: [ax.id, ay.id, by.id] },
      { x: 150, y: 122, edgeIds: [ax.id, ay.id, by.id] },
    ]));
    expect(junctions).toHaveLength(2);

    // Node interaction starts from original edge identities, never geometric
    // connectivity. A shared interval does not select its other passengers.
    for (const [nodeId, expectedEdges] of [
      ["Y", [ay.id, by.id]], ["X", [ax.id]], ["B", [by.id]],
    ] as const) {
      const selected = edges.filter((e) => e.source === nodeId || e.target === nodeId);
      expect(selected.map((e) => e.id)).toEqual(expectedEdges);
      const highlighted = segments.filter((s) => selected.some((e) => s.edgeIds.includes(e.id)));
      expect(highlighted.some((s) => s.start.y === 92 && s.end.y === 92))
        .toBe(nodeId === "X");
    }
  });

  it("merges opposite traversals and retains membership when one route doubles back", () => {
    const a = edge("a", "b");
    const b = edge("c", "d");
    const result = dagSceneSegments([a, b], {
      [a.id]: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 0 }],
      [b.id]: [{ x: 80, y: 0 }, { x: 20, y: 0 }],
    });
    expect(result.segments.map((s) => [s.start.x, s.end.x, s.edgeIds])).toEqual([
      [0, 20, [a.id]], [20, 40, [a.id, b.id]],
      [40, 80, [a.id, b.id]], [80, 100, [a.id]],
    ]);
    expect(result.junctions).toEqual([]);
  });

  it("distinguishes bus joins from perpendicular crossings and disjoint paths", () => {
    const edges = [edge("a", "b"), edge("c", "d"), edge("e", "f"), edge("g", "h"),
      edge("i", "j")];
    const result = dagSceneSegments(edges, {
      [edges[0]!.id]: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [edges[1]!.id]: [{ x: 50, y: -50 }, { x: 50, y: 50 }],
      [edges[2]!.id]: [{ x: 50, y: -50 }, { x: 50, y: 0 }, { x: 80, y: 0 }],
      [edges[3]!.id]: [{ x: 120, y: 0 }, { x: 140, y: 0 }],
      [edges[4]!.id]: [{ x: 0, y: 10 }, { x: 100, y: 10 }],
    });
    // The third path really joins both buses; the crossing alone does not.
    expect(result.junctions).toEqual([
      { x: 50, y: 0, edgeIds: edges.slice(0, 3).map((e) => e.id) },
    ]);
    const crossingOnly = dagSceneSegments(edges.slice(0, 2), {
      [edges[0]!.id]: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [edges[1]!.id]: [{ x: 50, y: -50 }, { x: 50, y: 50 }],
    });
    expect(crossingOnly.junctions).toEqual([]);
    expect(result.segments.find((s) => s.start.x === 120)?.edgeIds).toEqual([edges[3]!.id]);
    expect(result.segments.find((s) => s.start.y === 10)?.edgeIds).toEqual([edges[4]!.id]);
  });

  it("reuses a mixed bundle's detour exactly when satisfied dependencies are overlaid", () => {
    const mixed = edge("a", "b");
    const geometry = emptyDagScene();
    geometry.ports = {
      a: { input: { x: 0, y: 100 }, output: { x: 100, y: 100 } },
      b: { input: { x: 300, y: 200 }, output: { x: 400, y: 200 } },
    };
    const detour = [
      { x: 100, y: 100 },
      { x: 180, y: 100 },
      { x: 180, y: 60 },
      { x: 260, y: 60 },
      { x: 260, y: 200 },
      { x: 300, y: 200 },
    ];
    geometry.routes[mixed.id] = detour;
    const original = structuredClone(geometry);

    const overlay = routeDagOverlays(geometry, [mixed], [mixed]);

    expect(overlay.routes).toEqual({ [mixed.id]: detour });
    expect(overlay.segments).toEqual(dagSceneSegments([mixed], original.routes).segments);
    expect(geometry).toEqual(original);
  });

  it("marks the branching point exactly, without dots at shared trunk corners", () => {
    const upper = edge("source", "upper");
    const lower = edge("source", "lower");
    const trunk = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 80, y: 40 },
    ];
    const routes = {
      [upper.id]: [...trunk, { x: 80, y: 20 }, { x: 120, y: 20 }],
      [lower.id]: [...trunk, { x: 80, y: 80 }, { x: 120, y: 80 }],
    };

    const geometry = dagSceneSegments([upper, lower], routes);

    expect(geometry.junctions).toEqual([
      { x: 80, y: 40, edgeIds: [lower.id, upper.id] },
    ]);
  });
});
