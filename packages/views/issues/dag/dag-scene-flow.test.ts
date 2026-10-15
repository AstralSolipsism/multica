// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  computeDagFocus,
  computeDagLine,
  computeDagOverview,
  createDagModelIndex,
  DAG_INDEPENDENT_GROUP,
  type DagLineModel,
  type DagOverviewModel,
} from "@multica/core/issues/dag";
import { graphNode as n, issueGraph as g } from "./dag-test-fixtures";
import {
  dagFocusCanvasModel,
  dagDependencyStates,
  dagDisplayedRoutes,
  dagFocusHiddenCount,
  dagSceneStats,
  dagLineWithSatisfiedFilter,
  dagSceneEdgeDisplay,
  dagSceneFlowNodes,
  dagSceneFocusSet,
  dagSegmentDisplay,
  resolveDagSelection,
} from "./dag-scene-flow";
import {
  dagLineLayoutInput,
  dagOverviewLayoutInput,
} from "./dag-scene-inputs";
import { dagSceneKey, type DagSceneGeometry } from "./dag-scene";

function overviewOf(graph: ReturnType<typeof g>, showSatisfiedDependencies = false): DagOverviewModel {
  return computeDagOverview(createDagModelIndex(graph), { showCompleted: false, showSatisfiedDependencies });
}

function lineOf(graph: ReturnType<typeof g>, lineId: string): DagLineModel {
  const line = computeDagLine(createDagModelIndex(graph), lineId);
  if (!line) throw new Error(`no line ${lineId}`);
  return line;
}

describe("dagSceneFocusSet", () => {
  // OL-280's example: A→X, A→Y, B→Y sharing a bus must not blur the highlight.
  const focusPlan = {
    input: {
      kind: "line" as const,
      id: "focus-fixture",
      nodes: [],
      frames: [],
      edges: [
        { id: "a-x", source: "a", target: "x", sourceKind: "task" as const, targetKind: "task" as const },
        { id: "a-y", source: "a", target: "y", sourceKind: "task" as const, targetKind: "task" as const },
        { id: "b-y", source: "b", target: "y", sourceKind: "task" as const, targetKind: "task" as const },
      ],
    },
    dependencyIds: { "a-x": ["a-x"], "a-y": ["a-y"], "b-y": ["b-y"] },
    overlays: [],
    overlayDependencyIds: {},
  };

  it("highlights only the selected node's own routes", () => {
    const fromY = dagSceneFocusSet(focusPlan, "y", "upstream")!;
    expect([...fromY.edgeIds].sort()).toEqual(["a-y", "b-y"]);
    expect([...fromY.nodeIds].sort()).toEqual(["a", "b", "y"]);
    const fromX = dagSceneFocusSet(focusPlan, "x", "upstream")!;
    expect([...fromX.edgeIds]).toEqual(["a-x"]);
    expect([...fromX.nodeIds].sort()).toEqual(["a", "x"]);
    const fromB = dagSceneFocusSet(focusPlan, "b", "downstream")!;
    expect([...fromB.edgeIds]).toEqual(["b-y"]);
    expect([...fromB.nodeIds].sort()).toEqual(["b", "y"]);
  });

  it("unions the upstream and downstream closures for the click-cycle mode", () => {
    // From A: only its dependents — B is a sibling, never pulled in.
    const fromA = dagSceneFocusSet(focusPlan, "a", "both")!;
    expect([...fromA.edgeIds].sort()).toEqual(["a-x", "a-y"]);
    expect([...fromA.nodeIds].sort()).toEqual(["a", "x", "y"]);
    // From Y: only its prerequisites — X is not on either directional chain.
    const fromY = dagSceneFocusSet(focusPlan, "y", "both")!;
    expect([...fromY.edgeIds].sort()).toEqual(["a-y", "b-y"]);
    expect([...fromY.nodeIds].sort()).toEqual(["a", "b", "y"]);
  });
});

describe("dependency states and display counts", () => {
  // line r1 (children a1 done, a2 open) and line r4 (child c1 done) both block
  // r2's child b1: one mixed bundle, one fully satisfied bundle.
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

  it("keeps satisfied originals out of the count until the switch is on", () => {
    const model = overviewOf(graph);
    const plan = dagOverviewLayoutInput(model);
    const states = dagDependencyStates({ kind: "overview", overview: model });
    const mixed = plan.input.edges.find((e) => e.id === JSON.stringify(["issue:r1", "issue:r2"]))!;
    expect(dagSceneEdgeDisplay(plan, mixed.id, states, false)).toEqual({ count: 1, state: "blocking" });
    expect(dagSceneEdgeDisplay(plan, mixed.id, states, true)).toEqual({ count: 2, state: "blocking" });
  });

  it("routes fully satisfied bundles through overlays with satisfied styling", () => {
    const on = overviewOf(graph, true);
    const planOn = dagOverviewLayoutInput(on);
    const states = dagDependencyStates({ kind: "overview", overview: on });
    const satisfiedId = JSON.stringify(["issue:r4", "issue:r2"]);
    expect(planOn.input.edges.some((e) => e.id === satisfiedId)).toBe(false);
    expect(planOn.overlays.some((e) => e.id === satisfiedId)).toBe(true);
    expect(dagSceneEdgeDisplay(planOn, satisfiedId, states, false)).toBeNull();
    expect(dagSceneEdgeDisplay(planOn, satisfiedId, states, true)).toEqual({ count: 1, state: "satisfied" });
    // The satisfied original is resolvable even though its bundle is hidden.
    expect(states.get("e-c1")).toBe("satisfied");
    // The switch never changes placement: off drops the bundle from the model,
    // on keeps it as an overlay — either way it is outside `input.edges`.
    const off = overviewOf(graph, false);
    expect(dagSceneKey(dagOverviewLayoutInput(off).input)).toBe(dagSceneKey(planOn.input));
  });

  it("a segment shared by two bundles takes the worst state and dedupes counts", () => {
    const model = overviewOf(graph, true);
    const plan = dagOverviewLayoutInput(model);
    const states = dagDependencyStates({ kind: "overview", overview: model });
    const mixed = JSON.stringify(["issue:r1", "issue:r2"]);
    const satisfied = JSON.stringify(["issue:r4", "issue:r2"]);
    const shared = dagSegmentDisplay([mixed, satisfied], plan, states, true)!;
    expect(shared.state).toBe("blocking");
    expect(shared.count).toBe(3);
    expect(shared.width).toBe(2.2);
    const unsatisfiedOnly = dagSegmentDisplay([mixed, satisfied], plan, states, false)!;
    expect(unsatisfiedOnly.count).toBe(1);
    expect(unsatisfiedOnly.width).toBe(1.4);
    expect(dagSegmentDisplay([satisfied], plan, states, false)).toBeNull();
  });

  it("cancelled blockers outrank every other segment state", () => {
    const cancelled = g(
      [
        n("r1"),
        n("a1", { parentIssueId: "r1", status: "cancelled", statusCategory: "closed" }),
        n("r2"),
        n("b1", { parentIssueId: "r2" }),
      ],
      [{ id: "e-a1", source: "a1", target: "b1" }],
    );
    const model = overviewOf(cancelled);
    const plan = dagOverviewLayoutInput(model);
    const states = dagDependencyStates({ kind: "overview", overview: model });
    const display = dagSceneEdgeDisplay(plan, plan.input.edges[0]!.id, states, false)!;
    expect(display.state).toBe("cancelled-blocking");
  });

  it("always paints satisfied dependencies inside a line, whatever the switch", () => {
    // done → open within one line: the satisfied edge is a thin grey line, not
    // filtered out — the switch only covers inter-line surfaces.
    const line = lineOf(
      g(
        [
          n("r1"),
          n("a1", { parentIssueId: "r1", status: "done", statusCategory: "done" }),
          n("a2", { parentIssueId: "r1" }),
        ],
        [{ id: "e-a1", source: "a1", target: "a2" }],
      ),
      "r1",
    );
    const plan = dagLineLayoutInput(line);
    const states = dagDependencyStates({ kind: "line", line });
    for (const showSatisfied of [false, true]) {
      expect(dagSceneEdgeDisplay(plan, "e-a1", states, showSatisfied)).toEqual({
        count: 1,
        state: "satisfied",
      });
      expect(dagSegmentDisplay(["e-a1"], plan, states, showSatisfied)).toMatchObject({
        state: "satisfied",
        count: 1,
      });
    }
  });

  it("composes satisfied overview overlays into the displayed route set when on", () => {
    const graph = g(
      [
        n("r1"),
        n("a1", { parentIssueId: "r1", status: "done", statusCategory: "done" }),
        n("r2"),
        n("b1", { parentIssueId: "r2" }),
      ],
      [{ id: "e-a1", source: "a1", target: "b1" }],
    );
    const model = overviewOf(graph, true);
    const plan = dagOverviewLayoutInput(model);
    expect(plan.overlays).toHaveLength(1);
    const geometry: DagSceneGeometry = {
      nodes: {
        "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
        "issue:r2": { x: 400, y: 0, width: 280, height: 140 },
      },
      frames: {},
      ports: {
        "issue:r1": { input: { x: 0, y: 70 }, output: { x: 280, y: 70 } },
        "issue:r2": { input: { x: 400, y: 70 }, output: { x: 680, y: 70 } },
      },
      routes: {},
      segments: [],
      junctions: [],
      width: 680,
      height: 140,
      quality: "elk",
    };
    // Off: base geometry only, no overlay route.
    const off = dagDisplayedRoutes(geometry, plan, false);
    expect(Object.keys(off.routes)).toHaveLength(0);
    // On: the satisfied overlay is composed in without touching the boxes.
    const on = dagDisplayedRoutes(geometry, plan, true);
    expect(Object.keys(on.routes)).toEqual([plan.overlays[0]!.id]);
    expect(on.routes[plan.overlays[0]!.id]!.length).toBeGreaterThan(1);
    expect(on.segments.length).toBeGreaterThan(0);
  });
});

describe("dagLineWithSatisfiedFilter", () => {
  const graph = g(
    [
      n("r1"),
      n("a1", { parentIssueId: "r1" }),
      n("r2"),
      n("b1", { parentIssueId: "r2", status: "done", statusCategory: "done" }),
      n("b2", { parentIssueId: "r2" }),
      n("r3"),
      n("c1", { parentIssueId: "r3", status: "done", statusCategory: "done" }),
    ],
    [
      { id: "e-done", source: "b1", target: "a1" },
      { id: "e-open", source: "b2", target: "a1" },
      { id: "e-done2", source: "c1", target: "a1" },
    ],
  );

  it("drops satisfied external dependencies and empty groups when the switch is off", () => {
    const line = lineOf(graph, "r1");
    const filtered = dagLineWithSatisfiedFilter(line, false);
    const r2 = filtered.upstream.find((group) => group.id === "r2")!;
    expect(r2.count).toBe(1);
    expect(r2.dependencies.map((d) => d.id)).toEqual(["e-open"]);
    expect(filtered.upstream.some((group) => group.id === "r3")).toBe(false);
    expect(dagLineWithSatisfiedFilter(line, true)).toBe(line);
  });
});

describe("resolveDagSelection", () => {
  const graph = g(
    [
      n("r1"),
      n("a1", { parentIssueId: "r1" }),
      n("sub", { parentIssueId: "r1" }),
      n("s1", { parentIssueId: "sub" }),
      n("solo"),
    ],
    // A standalone card needs a visible relationship; without one it joins
    // the independent group.
    [{ id: "e-solo", source: "solo", target: "a1" }],
  );

  it("maps overview cards to their selection targets", () => {
    const overview = overviewOf(graph);
    const model = { kind: "overview" as const, overview };
    expect(resolveDagSelection(model, "issue:r1")).toMatchObject({
      kind: "line-card",
      issueId: "r1",
      enterLineId: "r1",
      identifier: "T-R1",
    });
    expect(resolveDagSelection(model, "solo")).toMatchObject({
      kind: "standalone",
      issueId: "solo",
      enterLineId: null,
    });
    expect(resolveDagSelection(model, "missing")).toBeNull();
    expect(resolveDagSelection(model, null)).toBeNull();
  });

  it("maps the independent card to its grid entry", () => {
    const overview = overviewOf(g([n("solo")]));
    const target = resolveDagSelection({ kind: "overview", overview }, DAG_INDEPENDENT_GROUP);
    expect(target).toMatchObject({
      kind: "independent",
      issueId: null,
      enterLineId: DAG_INDEPENDENT_GROUP,
    });
  });

  it("maps line members: tasks and sub-line frame headers", () => {
    const line = lineOf(graph, "r1");
    const model = { kind: "line" as const, line };
    // focusFrameId drives "Focus issue group": tasks recenter on their
    // innermost frame, a frame header on itself.
    expect(resolveDagSelection(model, "a1")).toMatchObject({
      kind: "task",
      issueId: "a1",
      focusFrameId: "r1",
    });
    expect(resolveDagSelection(model, "sub")).toMatchObject({
      kind: "frame",
      issueId: "sub",
      focusFrameId: "sub",
    });
    expect(resolveDagSelection(model, "elsewhere")).toBeNull();
  });
});

describe("dagSceneStats", () => {
  it("counts overview cards and displayed dependencies per the switch", () => {
    // Mixed bundle api→main (one satisfied, one open) + a fully satisfied one.
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
    const model = overviewOf(graph, true);
    const plan = dagOverviewLayoutInput(model);
    // Off: the mixed bundle counts only its unsatisfied original; the fully
    // satisfied bundle stays in its overlay. On: every original counts.
    expect(dagSceneStats({ kind: "overview", overview: model }, plan, false)).toEqual({
      matched: 7,
      context: 0,
      edges: 1,
    });
    expect(dagSceneStats({ kind: "overview", overview: model }, plan, true)).toEqual({
      matched: 7,
      context: 0,
      edges: 3,
    });
    expect(dagSceneStats({ kind: "overview", overview: model }, null, true).edges).toBe(0);
  });

  it("counts line members and all visible internal + external edges", () => {
    const line = lineOf(
      g(
        [
          n("r1"),
          n("a1", { parentIssueId: "r1", status: "done", statusCategory: "done" }),
          n("a2", { parentIssueId: "r1" }),
          n("r2"),
          n("u1", { parentIssueId: "r2" }),
        ],
        [
          { id: "e-int", source: "a1", target: "a2" },
          { id: "e-ext", source: "u1", target: "a2" },
        ],
      ),
      "r1",
    );
    const stats = dagSceneStats({ kind: "line", line }, null, false);
    expect(stats.matched).toBe(3);
    expect(stats.edges).toBe(2);
  });
});

describe("dagFocusHiddenCount", () => {
  it("counts chain tasks that have no visible overview card", () => {
    // line r1 → h (hidden when complete) → r2: from r1 upstream, h is hidden.
    const graph = g(
      [
        n("r1"),
        n("a1", { parentIssueId: "r1" }),
        n("h", { status: "done", statusCategory: "done" }),
        n("r2"),
        n("b1", { parentIssueId: "r2" }),
      ],
      [
        { id: "e1", source: "h", target: "a1" },
        { id: "e2", source: "b1", target: "h" },
      ],
    );
    const model = overviewOf(graph);
    const card = model.cards.find((c) => c.id === "issue:r1")!;
    expect(
      dagFocusHiddenCount({
        edges: graph.edges,
        card,
        representatives: model.representatives,
        way: "upstream",
      }),
    ).toBe(1);
    // Downstream from r2, the same hidden task is on the chain.
    const card2 = model.cards.find((c) => c.id === "issue:r2")!;
    expect(
      dagFocusHiddenCount({
        edges: graph.edges,
        card: card2,
        representatives: model.representatives,
        way: "downstream",
      }),
    ).toBe(1);
    // And the anchor's own members never count as hidden.
    expect(
      dagFocusHiddenCount({
        edges: graph.edges,
        card,
        representatives: model.representatives,
        way: "downstream",
      }),
    ).toBe(0);
    // The click-cycle mode walks both directions; a task reachable from both
    // sides is still counted once.
    expect(
      dagFocusHiddenCount({
        edges: graph.edges,
        card,
        representatives: model.representatives,
        way: "both",
      }),
    ).toBe(1);
    expect(
      dagFocusHiddenCount({
        edges: graph.edges,
        card: card2,
        representatives: model.representatives,
        way: "both",
      }),
    ).toBe(1);
  });
});

describe("dagSceneFlowNodes", () => {
  it("positions overview cards absolutely", () => {
    const overview = overviewOf(g([n("r1"), n("a1", { parentIssueId: "r1" }), n("solo")]));
    const geometry: DagSceneGeometry = {
      nodes: {
        "issue:r1": { x: 10, y: 20, width: 280, height: 140 },
        [DAG_INDEPENDENT_GROUP]: { x: 400, y: 20, width: 280, height: 140 },
      },
      frames: {},
      ports: {},
      routes: {},
      segments: [],
      junctions: [],
      width: 0,
      height: 0,
      quality: "elk",
    };
    const nodes = dagSceneFlowNodes(
      { kind: "overview", overview },
      { geometry, statusColorOf: () => null, projectNames: new Map() },
    );
    const line = nodes.find((node) => node.id === "issue:r1")!;
    expect(line.position).toEqual({ x: 10, y: 20 });
    expect(line.type).toBe("dagOverviewCard");
  });

  it("nests line frames and tasks with relative positions and stage labels", () => {
    const line = lineOf(
      g([
        n("r1"),
        n("t1", { parentIssueId: "r1", stage: 1 }),
        n("sub", { parentIssueId: "r1" }),
        n("s1", { parentIssueId: "sub" }),
        n("r2"),
        n("u1", { parentIssueId: "r2" }),
      ], [{ id: "e-u1", source: "u1", target: "t1" }]),
      "r1",
    );
    const geometry: DagSceneGeometry = {
      nodes: {
        t1: { x: 60, y: 150, width: 248, height: 116 },
        s1: { x: 420, y: 240, width: 248, height: 116 },
        [JSON.stringify(["external", "upstream", "r2"])]: { x: -240, y: 150, width: 184, height: 76 },
      },
      frames: {
        r1: { x: 0, y: 0, width: 900, height: 500, bands: [], stageMode: "labels" },
        sub: {
          x: 340, y: 160, width: 400, height: 260,
          bands: [{ stage: 1, start: 0, end: 400 }],
          stageMode: "columns",
        },
      },
      ports: {},
      routes: {},
      segments: [],
      junctions: [],
      width: 0,
      height: 0,
      quality: "elk",
    };
    const nodes = dagSceneFlowNodes(
      { kind: "line", line },
      { geometry, statusColorOf: () => null, projectNames: new Map() },
    );
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(byId.get("r1")!.position).toEqual({ x: 0, y: 0 });
    expect(byId.get("sub")!.position).toEqual({ x: 340, y: 160 });
    expect(byId.get("sub")!.parentId).toBe("r1");
    expect(byId.get("t1")!.position).toEqual({ x: 60, y: 150 });
    expect(byId.get("t1")!.parentId).toBe("r1");
    expect((byId.get("t1")!.data as { showStage: boolean }).showStage).toBe(true);
    expect(byId.get("s1")!.position).toEqual({ x: 80, y: 80 });
    expect((byId.get("s1")!.data as { showStage: boolean }).showStage).toBe(false);
    const external = byId.get(JSON.stringify(["external", "upstream", "r2"]))!;
    expect(external.type).toBe("dagExternal");
    expect((external.data as { side: string }).side).toBe("upstream");
  });


  it("lays the independent grid flat without frames", () => {
    const graph = g([n("solo-1"), n("solo-2")]);
    const tasks = graph.nodes.map((node) => ({
      issue: node,
      parentId: null,
      isFrame: false,
      role: "match" as const,
      cancelledBlocking: false,
    }));
    const geometry: DagSceneGeometry = {
      nodes: {
        "solo-1": { x: 28, y: 28, width: 248, height: 116 },
        "solo-2": { x: 292, y: 28, width: 248, height: 116 },
      },
      frames: {},
      ports: {},
      routes: {},
      segments: [],
      junctions: [],
      width: 0,
      height: 0,
      quality: "grid",
    };
    const nodes = dagSceneFlowNodes(
      { kind: "independent", tasks },
      { geometry, statusColorOf: () => null, projectNames: new Map() },
    );
    expect(nodes.map((node) => node.id).sort()).toEqual(["solo-1", "solo-2"]);
    expect(nodes.every((node) => !node.parentId)).toBe(true);
  });
});



describe("focus scene adapter", () => {
  it("counts a retained ancestor frame as context and counts split frames only once", () => {
    const index = createDagModelIndex(g([
      n("root"), n("before", { parentIssueId: "root" }), n("seed", { parentIssueId: "root" }),
      n("other"), n("after", { parentIssueId: "other" }),
    ], [["before", "seed"], ["seed", "after"]]));
    const model = dagFocusCanvasModel(computeDagFocus(index, "seed"));
    expect(model.frames.filter((frame) => frame.issue.id === "root")).toHaveLength(2);
    expect(model.frames.find((frame) => frame.issue.id === "other")).toMatchObject({ contextOnly: true });
    expect(dagSceneStats(model, model.plan, false)).toEqual({ matched: 4, context: 1, edges: 2 });
  });

  it("resolves fragment selections to raw issues and paints satisfied/redundant dependencies", () => {
    const index = createDagModelIndex(g([n("root"), n("a", { parentIssueId: "root", status: "done", statusCategory: "done" }), n("seed", { parentIssueId: "root" }), n("after")], [["a", "seed"], ["seed", "after"], ["a", "after"]]));
    const model = dagFocusCanvasModel(computeDagFocus(index, "seed", true));
    const currentFrame = model.plan.input.frames.find((frame) => frame.modelId === "root" && frame.side === "current")!;
    expect(resolveDagSelection(model, currentFrame.id)).toMatchObject({ id: currentFrame.id, issueId: "root", focusFrameId: currentFrame.id });
    expect(resolveDagSelection(model, "seed")).toMatchObject({ issueId: "seed", focusFrameId: currentFrame.id });
    const states = dagDependencyStates(model);
    expect(dagSceneEdgeDisplay(model.plan, "a-after", states, false)).toEqual({ state: "satisfied", count: 1 });
    expect(model.plan.input.edges).toHaveLength(3);
    expect(dagSceneStats(model, model.plan, false)).toEqual({ matched: 4, context: 0, edges: 3 });
  });
});
