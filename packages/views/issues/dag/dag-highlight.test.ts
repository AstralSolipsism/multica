// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  computeDagOverview,
  createDagModelIndex,
  type DagOverviewModel,
} from "@multica/core/issues/dag";
import { graphNode as n, issueGraph as g } from "./dag-test-fixtures";
import {
  dagBusDependencyIds,
  dagCullBounds,
  dagCullBoundsKey,
  dagDependencyEdgeIds,
  dagMotionSegments,
  dagOverviewHoverOverlay,
  dagPointVisible,
  dagRouteVisible,
  dagSceneSelectionSet,
  dagSegmentFlowDirection,
  dagSegmentVisible,
  dagStateMotion,
  dagVisibleBounds,
  dagWithAncestorFrames,
  type DagMotionCandidate,
} from "./dag-highlight";
import type { DagSceneGeometry, DagScenePlan } from "./dag-scene";
import { DAG_MOTION_MAX_SEGMENTS } from "./dag-constants";

// OL-280 option B's example: A→X, A→Y, B→Y sharing a bus must not blur.
const abxyPlan: DagScenePlan = {
  input: {
    kind: "line",
    id: "abxy",
    nodes: ["a", "b", "x", "y"].map((id) => ({
      id,
      parentId: null,
      width: 248,
      height: 116,
      stage: null,
    })),
    frames: [],
    edges: [
      { id: "a-x", source: "a", target: "x", sourceKind: "task", targetKind: "task" },
      { id: "a-y", source: "a", target: "y", sourceKind: "task", targetKind: "task" },
      { id: "b-y", source: "b", target: "y", sourceKind: "task", targetKind: "task" },
    ],
  },
  dependencyIds: { "a-x": ["a-x"], "a-y": ["a-y"], "b-y": ["b-y"] },
  overlays: [],
  overlayDependencyIds: {},
};

describe("dagSceneSelectionSet", () => {
  it("lights only the clicked node's own dependencies, never the whole bus", () => {
    const fromY = dagSceneSelectionSet(abxyPlan, "y")!;
    expect([...fromY.edgeIds].sort()).toEqual(["a-y", "b-y"]);
    expect([...fromY.nodeIds].sort()).toEqual(["a", "b", "y"]);
    const fromX = dagSceneSelectionSet(abxyPlan, "x")!;
    expect([...fromX.edgeIds]).toEqual(["a-x"]);
    expect([...fromX.nodeIds].sort()).toEqual(["a", "x"]);
    const fromB = dagSceneSelectionSet(abxyPlan, "b")!;
    expect([...fromB.edgeIds]).toEqual(["b-y"]);
    expect([...fromB.nodeIds].sort()).toEqual(["b", "y"]);
  });

  it("returns null for an isolated node — its brand ring is signal enough", () => {
    const plan: DagScenePlan = {
      ...abxyPlan,
      input: {
        ...abxyPlan.input,
        nodes: [
          ...abxyPlan.input.nodes,
          { id: "solo", parentId: null, width: 248, height: 116, stage: null },
        ],
      },
    };
    expect(dagSceneSelectionSet(plan, "solo")).toBeNull();
  });

  it("keeps the frames containing lit cards lit", () => {
    const plan: DagScenePlan = {
      input: {
        kind: "line",
        id: "framed",
        nodes: [
          { id: "t1", parentId: "f1", width: 248, height: 116, stage: null },
          { id: "t2", parentId: "f2", width: 248, height: 116, stage: null },
        ],
        frames: [
          { id: "f1", modelId: "f1", parentId: "root" },
          { id: "f2", modelId: "f2", parentId: "root" },
          { id: "root", modelId: "root", parentId: null },
        ],
        edges: [{ id: "e1", source: "t1", target: "t2", sourceKind: "task", targetKind: "task" }],
      },
      dependencyIds: { e1: ["e1"] },
      overlays: [],
      overlayDependencyIds: {},
    };
    const set = dagSceneSelectionSet(plan, "t1")!;
    expect([...set.nodeIds].sort()).toEqual(["f1", "f2", "root", "t1", "t2"]);
  });

  it("counts overlay edges as connections when the satisfied switch is off", () => {
    const plan: DagScenePlan = {
      ...abxyPlan,
      overlays: [{ id: "ov", source: "x", target: "y", sourceKind: "task", targetKind: "task" }],
      overlayDependencyIds: { ov: ["ov"] },
    };
    const set = dagSceneSelectionSet(plan, "x")!;
    expect([...set.edgeIds].sort()).toEqual(["a-x", "ov"]);
  });
});

describe("dagBusDependencyIds / dagDependencyEdgeIds", () => {
  const plan: DagScenePlan = {
    ...abxyPlan,
    dependencyIds: { "a-x": ["raw-ax"], "a-y": ["raw-ay", "raw-shared"], "b-y": ["raw-by"] },
    overlays: [{ id: "ov", source: "x", target: "y", sourceKind: "task", targetKind: "task" }],
    overlayDependencyIds: { ov: ["raw-ov", "raw-shared"] },
  };

  it("unions segment memberships deduplicated, in first-seen order", () => {
    expect(dagBusDependencyIds(["a-y", "b-y"], plan)).toEqual(["raw-ay", "raw-shared", "raw-by"]);
    expect(dagBusDependencyIds(["a-y", "ov"], plan)).toEqual(["raw-ay", "raw-shared", "raw-ov"]);
    expect(dagBusDependencyIds(["missing"], plan)).toEqual([]);
  });

  it("selects every scene edge carrying a chosen original dependency", () => {
    expect([...dagDependencyEdgeIds(plan, new Set(["raw-shared"]))].sort()).toEqual(["a-y", "ov"]);
    expect([...dagDependencyEdgeIds(plan, new Set(["raw-ax", "raw-by"]))].sort()).toEqual([
      "a-x",
      "b-y",
    ]);
    expect([...dagDependencyEdgeIds(plan, new Set(["nope"]))]).toEqual([]);
  });
});

describe("motion policy", () => {
  it("maps states to their motion", () => {
    expect(dagStateMotion("advancing")).toBe("flow");
    expect(dagStateMotion("cancelled-blocking")).toBe("breathe");
    expect(dagStateMotion("blocking")).toBeNull();
    expect(dagStateMotion("satisfied")).toBeNull();
  });

  const candidates = (count: number): DagMotionCandidate[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `segment:${i}`,
      edgeIds: [`edge-${i}`],
    }));

  it("animates every candidate under the budget", () => {
    const result = dagMotionSegments({
      candidates: candidates(3),
      highlightedEdgeIds: null,
      zoom: 1,
      reducedMotion: false,
    });
    expect([...result].sort()).toEqual(["segment:0", "segment:1", "segment:2"]);
  });

  it("over the budget even the selected chain is truncated to the limit", () => {
    const highlighted = new Set(["edge-2", "edge-7", "edge-9"]);
    const result = dagMotionSegments({
      candidates: candidates(DAG_MOTION_MAX_SEGMENTS + 1),
      highlightedEdgeIds: highlighted,
      zoom: 1,
      reducedMotion: false,
    });
    expect([...result].sort()).toEqual(["segment:2", "segment:7", "segment:9"]);
    const bigChain = dagMotionSegments({
      candidates: candidates(DAG_MOTION_MAX_SEGMENTS + 1),
      highlightedEdgeIds: new Set(candidates(DAG_MOTION_MAX_SEGMENTS + 1).flatMap((c) => c.edgeIds)),
      zoom: 1,
      reducedMotion: false,
    });
    expect(bigChain.size).toBe(DAG_MOTION_MAX_SEGMENTS);
  });

  it("over the budget with nothing selected, nothing moves", () => {
    const result = dagMotionSegments({
      candidates: candidates(DAG_MOTION_MAX_SEGMENTS + 1),
      highlightedEdgeIds: null,
      zoom: 1,
      reducedMotion: false,
    });
    expect(result.size).toBe(0);
  });

  it("stops below 50% zoom and under system reduced motion", () => {
    const few = candidates(2);
    expect(
      dagMotionSegments({ candidates: few, highlightedEdgeIds: null, zoom: 0.49, reducedMotion: false })
        .size,
    ).toBe(0);
    expect(
      dagMotionSegments({ candidates: few, highlightedEdgeIds: null, zoom: 0.5, reducedMotion: false })
        .size,
    ).toBe(2);
    expect(
      dagMotionSegments({ candidates: few, highlightedEdgeIds: null, zoom: 1, reducedMotion: true })
        .size,
    ).toBe(0);
  });
});

describe("dagSegmentFlowDirection", () => {
  const segment = { start: { x: 100, y: 50 }, end: { x: 200, y: 50 } };

  it("follows the route's own order over a shared interval", () => {
    const forward = [
      { x: 0, y: 50 },
      { x: 300, y: 50 },
    ];
    expect(dagSegmentFlowDirection(forward, segment)).toBe(1);
    const backward = [
      { x: 300, y: 50 },
      { x: 0, y: 50 },
    ];
    expect(dagSegmentFlowDirection(backward, segment)).toBe(-1);
  });

  it("finds the matching leg of an orthogonal route", () => {
    const route = [
      { x: 300, y: 10 },
      { x: 300, y: 50 },
      { x: 0, y: 50 },
    ];
    expect(dagSegmentFlowDirection(route, segment)).toBe(-1);
  });

  it("defaults to forward when the segment is off the route", () => {
    const route = [
      { x: 0, y: 200 },
      { x: 300, y: 200 },
    ];
    expect(dagSegmentFlowDirection(route, segment)).toBe(1);
  });
});

describe("dagOverviewHoverOverlay", () => {
  // r1 blocks r2 twice: one satisfied (a1 done), one still blocking (a2 open);
  // r4's fully satisfied bundle has no base route.
  const graph = g(
    [
      n("r1"),
      n("a1", { parentIssueId: "r1", status: "done", statusCategory: "done" }),
      n("a2", { parentIssueId: "r1" }),
      n("r2"),
      n("b1", { parentIssueId: "r2" }),
      n("r4"),
      n("c1", { parentIssueId: "r4", status: "done", statusCategory: "done" }),
    ],
    [
      { id: "e-a1", source: "a1", target: "b1" },
      { id: "e-a2", source: "a2", target: "b1" },
      { id: "e-c1", source: "c1", target: "b1" },
    ],
  );
  const model: DagOverviewModel = computeDagOverview(createDagModelIndex(graph), {
    showCompleted: false,
    showSatisfiedDependencies: false,
  });
  const mixedId = JSON.stringify(["issue:r1", "issue:r2"]);
  const satisfiedId = JSON.stringify(["issue:r4", "issue:r2"]);
  const geometry: DagSceneGeometry = {
    nodes: {
      "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
      "issue:r2": { x: 500, y: 0, width: 280, height: 140 },
      "issue:r4": { x: 0, y: 300, width: 280, height: 140 },
    },
    frames: {},
    ports: {
      "issue:r1": { input: { x: 0, y: 70 }, output: { x: 280, y: 70 } },
      "issue:r2": { input: { x: 500, y: 70 }, output: { x: 780, y: 70 } },
      "issue:r4": { input: { x: 0, y: 370 }, output: { x: 280, y: 370 } },
    },
    routes: { [mixedId]: [{ x: 280, y: 70 }, { x: 500, y: 70 }] },
    segments: [],
    junctions: [],
    width: 780,
    height: 440,
    quality: "elk",
  };
  const canvasModel = { kind: "overview" as const, overview: model };

  it("surfaces the hovered card's satisfied bundles without double-painting mixed ones", () => {
    const overlay = dagOverviewHoverOverlay(canvasModel, geometry, "issue:r2")!;
    expect([...overlay.edgeIds].sort()).toEqual([mixedId, satisfiedId].sort());
    // The mixed bundle already has a base route: only the fully satisfied
    // bundle gets a fresh overlay route.
    expect(Object.keys(overlay.routes)).toEqual([satisfiedId]);
    expect(overlay.routes[satisfiedId]![0]).toEqual({ x: 280, y: 370 });
    expect(overlay.routes[satisfiedId]!.at(-1)).toEqual({ x: 500, y: 70 });
  });

  it("returns null for cards without satisfied bundles and non-overview models", () => {
    const lone = g([n("solo")], []);
    const loneModel = computeDagOverview(createDagModelIndex(lone), {});
    expect(
      dagOverviewHoverOverlay(
        { kind: "overview", overview: loneModel },
        { ...geometry, nodes: { solo: { x: 0, y: 0, width: 280, height: 140 } } },
        "solo",
      ),
    ).toBeNull();
    expect(
      dagOverviewHoverOverlay({ kind: "independent", tasks: [] }, geometry, "issue:r2"),
    ).toBeNull();
  });
});

describe("viewport culling", () => {
  const bounds = dagVisibleBounds([0, 0, 1], { width: 800, height: 600 }, 0)!;
  it("maps the screen transform into flow coordinates", () => {
    expect([bounds.x0, bounds.y0, bounds.x1, bounds.y1].map((v) => v + 0)).toEqual([0, 0, 800, 600]);
    expect(dagVisibleBounds([100, 50, 0.5], { width: 800, height: 600 }, 0)).toEqual({
      x0: -200,
      y0: -100,
      x1: 1400,
      y1: 1100,
    });
    expect(dagVisibleBounds([0, 0, 0], { width: 800, height: 600 })).toBeNull();
  });

  it("keeps the cull key stable inside a cell and bumps it across one", () => {
    const size = { width: 800, height: 600 };
    const at = (x: number, y: number, zoom = 1) => dagCullBoundsKey([x, y, zoom], size);
    expect(at(0, 0)).toBe(at(-50, -50));
    expect(at(0, 0)).not.toBe(at(-200, 0));
    expect(dagCullBoundsKey([0, 0, 0], size)).toBe("");
  });

  it("always contains the visible window, also for negative pans and off-step zooms", () => {
    const size = { width: 1600, height: 1000 };
    const cases: [number, number, number][] = [
      [-4000, -500, 0.3],
      [-1000, 0, 0.55],
      [-12000, -8000, 0.39],
      [-4000, 200, 0.24],
      [300, -200, 1.37],
      [-50, -50, 0.05],
    ];
    for (const [tx, ty, zoom] of cases) {
      const key = dagCullBoundsKey([tx, ty, zoom], size);
      const bounds = dagCullBounds(key)!;
      const visible = {
        x0: -tx / zoom,
        y0: -ty / zoom,
        x1: (size.width - tx) / zoom,
        y1: (size.height - ty) / zoom,
      };
      expect(bounds.x0, `case ${tx},${ty},${zoom}`).toBeLessThanOrEqual(visible.x0);
      expect(bounds.y0, `case ${tx},${ty},${zoom}`).toBeLessThanOrEqual(visible.y0);
      expect(bounds.x1, `case ${tx},${ty},${zoom}`).toBeGreaterThanOrEqual(visible.x1);
      expect(bounds.y1, `case ${tx},${ty},${zoom}`).toBeGreaterThanOrEqual(visible.y1);
    }
  });

  it("culls segments, routes and points outside the bounds", () => {
    const vertical = { start: { x: 100, y: -500 }, end: { x: 100, y: 100 } };
    expect(dagSegmentVisible(vertical, bounds)).toBe(true);
    expect(
      dagSegmentVisible({ start: { x: 900, y: 0 }, end: { x: 1000, y: 100 } }, bounds),
    ).toBe(false);
    expect(dagRouteVisible([{ x: -50, y: 300 }, { x: 850, y: 300 }], bounds)).toBe(true);
    expect(dagRouteVisible([{ x: 0, y: 700 }, { x: 100, y: 750 }], bounds)).toBe(false);
    expect(dagPointVisible({ x: 400, y: 300 }, bounds)).toBe(true);
    expect(dagPointVisible({ x: -1, y: 300 }, bounds)).toBe(false);
  });
});

describe("dagWithAncestorFrames", () => {
  it("adds transitive frame parents only", () => {
    const plan: DagScenePlan = {
      ...abxyPlan,
      input: {
        ...abxyPlan.input,
        nodes: [{ id: "t", parentId: "inner", width: 1, height: 1, stage: null }],
        frames: [
          { id: "inner", modelId: "inner", parentId: "outer" },
          { id: "outer", modelId: "outer", parentId: null },
        ],
      },
    };
    expect([...dagWithAncestorFrames(plan, new Set(["t"]))].sort()).toEqual(["inner", "outer", "t"]);
  });
});
