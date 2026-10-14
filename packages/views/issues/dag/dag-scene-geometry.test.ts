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
