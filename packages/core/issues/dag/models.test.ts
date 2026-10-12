// @vitest-environment node
import { describe, expect, it } from "vitest";
import { graphNode as n, issueGraph as g } from "./test-fixtures";
import { createDagModelIndex } from "./model-index";
import { computeDagOverview } from "./overview";
import { computeDagLine, computeDagFocus } from "./detail";
import { createDagModelSelector } from "./selector";
import { aggregateDagDependencyState, dagDependencyState } from "./state";
import { computeDagProjection, dagFocusNeighborhood } from "./projection";

const done = { status: "done", statusCategory: "done" };
const closed = { status: "cancelled", statusCategory: "closed" };
const started = { status: "in_progress", statusCategory: "started" };
const review = { status: "in_review", statusCategory: "started" };
const blocked = { status: "blocked", statusCategory: "started" };

describe("dependency display states", () => {
  it.each([
    [done, "satisfied"], [closed, "cancelled-blocking"], [started, "advancing"],
    [review, "advancing"], [blocked, "blocking"], [{}, "blocking"],
    [{ status: "custom-active", statusCategory: "started" }, "advancing"],
    [{ status: "custom-finished", statusCategory: "completed" }, "satisfied"],
    [{ status: "unknown", statusCategory: "unknown" }, "blocking"],
  ] as const)("classifies %o", (status, state) => {
    expect(dagDependencyState(n("source", status), false)).toBe(state);
    expect(dagDependencyState(n("source", status), true)).toBe("satisfied");
  });

  it.each(["queued", "dispatched", "running", "waitingLocalDirectory"] as const)("uses active %s runs, even on blocked tasks", (counter) => {
    const source = n("source", blocked);
    source.runSummary![counter] = 1;
    expect(dagDependencyState(source, false)).toBe("advancing");
    expect(dagDependencyState({ ...source, ...closed }, false)).toBe("cancelled-blocking");
  });

  it("requires a parent waiter and all nested descendants to finish", () => {
    const graph = g([n("s", closed), n("p", done), n("sub", { parentIssueId: "p", ...done }), n("child", { parentIssueId: "sub" })], [["s", "p"]]);
    const index = createDagModelIndex(graph);
    expect(index.dependencies[0]).toMatchObject({ state: "cancelled-blocking", targetKind: "frame" });
    expect(computeDagOverview(index).cards.find((c) => c.issue?.id === "p")?.attention).toBe("exception");
    const finished = createDagModelIndex({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, ...closed })) });
    expect(finished.dependencies[0]?.state).toBe("satisfied");
  });

  it("aggregates by attention, including the blocking/advancing tie", () => {
    expect(aggregateDagDependencyState(["satisfied", "advancing"])).toBe("advancing");
    expect(aggregateDagDependencyState(["advancing", "blocking"])).toBe("blocking");
    expect(aggregateDagDependencyState(["blocking", "cancelled-blocking", "advancing"])).toBe("cancelled-blocking");
    expect(aggregateDagDependencyState([])).toBe("satisfied");
  });
});

describe("overview", () => {
  it("handles an empty scope and a line with only context matches", () => {
    expect(computeDagOverview(createDagModelIndex(g([])))).toMatchObject({ cards: [], dependencies: [], autoEnterLineId: null });
    const model = computeDagOverview(createDagModelIndex(g([n("a", { role: "context" }), n("b", { role: "context", parentIssueId: "a" })])));
    expect(model.cards[0]).toMatchObject({ role: "context", matchCount: 0, contextCount: 2 });
  });
  it("counts progress without the root, done only; classifies all authorized members", () => {
    const graph = g([
      n("line", { ...started, projectId: "p1", priority: "high" }),
      n("b", { parentIssueId: "line", ...blocked }), n("r", { parentIssueId: "line", ...review }),
      n("d", { parentIssueId: "line", ...done }), n("c", { parentIssueId: "line", ...closed }),
      n("u", { parentIssueId: "line" }), n("custom", { parentIssueId: "line", status: "custom", statusCategory: "started" }),
    ]);
    const model = computeDagOverview(createDagModelIndex(graph));
    expect(model.cards[0]).toMatchObject({
      kind: "line", progress: { completed: 1, total: 6 },
      unfinished: { blocked: 1, review: 1, inProgress: 2, unstarted: 1 },
      issue: { identifier: "T-LINE", priority: "high", status: "in_progress" }, project: { id: "p1" }, attention: "exception",
    });
    expect(model.autoEnterLineId).toBe("line");
  });

  it("sorts tiers, priority, then identifiers newest first, with runs ahead of review", () => {
    const roots = [
      n("ended", { identifier: "T-999", ...done }), n("todo", { identifier: "T-70" }),
      n("review", { identifier: "T-60", ...review }), n("run", { identifier: "T-50", ...review, runSummary: { ...n("x").runSummary!, queued: 1 } }),
      n("active", { identifier: "T-40", ...started, priority: "high" }),
      n("blocked", { identifier: "T-30", ...blocked }),
      n("blocked-old", { identifier: "T-2", ...blocked, priority: "urgent" }),
      n("blocked-new", { identifier: "T-10", ...blocked, priority: "urgent" }),
    ];
    const nodes = roots.flatMap((root) => [root, n(`${root.id}-child`, { parentIssueId: root.id, ...done })]);
    const cards = computeDagOverview(createDagModelIndex(g(nodes)), { showCompleted: true }).cards;
    expect(cards.map((c) => c.issue?.id)).toEqual(["blocked-new", "blocked-old", "blocked", "active", "run", "review", "todo", "ended"]);
  });

  it("hides only whole finished lines and keeps cancelled blockers as context, including inherited waits", () => {
    const graph = g([
      n("hidden", done), n("cancelled", { parentIssueId: "hidden", ...closed }),
      n("live", done), n("child", { parentIssueId: "live" }),
      n("finished", done), n("solo"),
    ], [["cancelled", "live"]]);
    const model = computeDagOverview(createDagModelIndex(graph));
    expect(model.cards.map((c) => c.id)).toEqual(expect.arrayContaining(["cancelled", "issue:live", "independent:root"]));
    expect(model.cards.find((c) => c.id === "cancelled")).toMatchObject({ kind: "issue", role: "context", cancelledBlocking: true });
    expect(model.cards.find((c) => c.id === "issue:live")?.memberIds).toEqual(["live", "child"]);
    expect(model.hiddenCompleted).toEqual({ lines: 1, lineTasks: 1, singles: 1 });
    expect(model.hiddenLineIds).toEqual(["issue:hidden"]);
    expect(model.autoEnterLineId).toBeNull();
    expect(computeDagOverview(createDagModelIndex(graph), { showCompleted: true }).hiddenCompleted).toEqual({ lines: 0, lineTasks: 0, singles: 0 });
  });

  it("aggregates all originals, filters satisfied pairs, and exposes satisfied overlays on each incident card", () => {
    const graph = g([
      n("a"), n("a1", { parentIssueId: "a", ...done }), n("a2", { parentIssueId: "a", ...started }),
      n("a3", { parentIssueId: "a", ...closed }), n("b"), n("b1", { parentIssueId: "b" }),
      n("c"), n("c1", { parentIssueId: "c" }),
    ], [["a1", "b1"], ["a2", "b1"], ["a3", "b1"], ["a1", "c1"], ["a1", "a2"]]);
    const index = createDagModelIndex(graph), model = computeDagOverview(index);
    expect(model.dependencies).toHaveLength(1);
    expect(model.dependencies[0]).toMatchObject({ source: "issue:a", target: "issue:b", count: 3, state: "cancelled-blocking", sourceEdgeIds: ["a1-b1", "a2-b1", "a3-b1"] });
    expect(model.satisfiedByCard.get("issue:a")).toHaveLength(2);
    expect(model.satisfiedByCard.get("issue:b")?.[0]?.sourceEdgeIds).toEqual(["a1-b1"]);
    expect(computeDagOverview(index, { showSatisfiedDependencies: true }).dependencies).toHaveLength(2);
  });

  it("keeps match/context, unknown and restricted signals without inventing unauthorized members", () => {
    const graph = g([
      n("root", { role: "context", hasRestrictedParent: true, projectId: "p1" }),
      n("child", { parentIssueId: "root", projectId: "p2", dependencySummary: { visibleUnsatisfiedCount: 0, dependencyVersion: "v", hasRestrictedBlockers: true } }),
      n("orphan", { parentIssueId: "missing", role: "context", runSummary: null, dependencySummary: null, statusCategory: "new-category" }),
      n("independent"),
    ]);
    graph.hasRestrictedContext = true;
    const model = computeDagOverview(createDagModelIndex(graph));
    expect(model.hasRestrictedContext).toBe(true);
    expect(model.cards.find((c) => c.kind === "line")).toMatchObject({ role: "match", matchCount: 1, contextCount: 1, hasRestrictedParent: true, hasRestrictedBlockers: true, project: { id: "p1" } });
    expect(model.cards.find((c) => c.id === "orphan")).toMatchObject({ role: "context", unknownDependencyCount: 1, unknownRunCount: 1, unknownStatusCount: 1, attention: "unstarted" });
    expect(model.cards.find((c) => c.kind === "independent")?.memberIds).toEqual(["independent"]);
    expect(model.cards.some((c) => c.issue?.id === "missing")).toBe(false);
  });

  it("repairs cycles, self-parents and missing parents without mutating the graph", () => {
    const graph = g([n("a", { parentIssueId: "b" }), n("b", { parentIssueId: "a" }), n("self", { parentIssueId: "self" }), n("orphan", { parentIssueId: "missing" })]);
    const before = JSON.stringify(graph), index = createDagModelIndex(graph);
    const model = computeDagOverview(index);
    expect(model.cards).toHaveLength(3);
    expect(computeDagLine(index, "a")?.frames[0]?.memberIds).toEqual(["a", "b"]);
    expect(computeDagFocus(index, "b", true).groups).toHaveLength(1);
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe("line and focus models", () => {
  function fixture() {
    return g([
      n("a"), n("sub", { parentIssueId: "a", ...done }), n("x", { parentIssueId: "sub", ...done }),
      n("y", { parentIssueId: "a" }), n("b", { projectId: "p2" }), n("b1", { parentIssueId: "b" }),
      n("b2", { parentIssueId: "b" }), n("solo"),
    ], [["x", "y"], ["solo", "sub"], ["b1", "x"], ["b2", "y"], ["y", "b1"]]);
  }

  it("keeps nested frames and completed members; groups both external directions by the other root", () => {
    const line = computeDagLine(createDagModelIndex(fixture()), "a")!;
    expect(line.frames.map((frame) => [frame.id, frame.parentId])).toEqual([["a", null], ["sub", "a"]]);
    expect(line.frames[0]).toMatchObject({ frameIds: ["sub"], taskIds: ["y"], progress: { completed: 2, total: 3 } });
    expect(line.tasks.map((task) => task.issue.id)).toEqual(["x", "y"]);
    expect(line.upstream.find((group) => group.id === "b")).toMatchObject({ kind: "line", count: 2, project: { id: "p2" } });
    expect(line.upstream.find((group) => group.id === "solo")?.dependencies[0]).toMatchObject({ target: "sub", targetKind: "frame", state: "satisfied" });
    expect(line.downstream[0]).toMatchObject({ id: "b", count: 1 });
    expect(computeDagLine(createDagModelIndex(fixture()), "missing")).toBeNull();
  });

  it("groups an external standalone task as an issue and does not give it a line model", () => {
    const index = createDagModelIndex(g([
      n("a"), n("a1", { parentIssueId: "a" }), n("solo"),
    ], [["solo", "a1"]]));
    expect(computeDagLine(index, "a")!.upstream[0]).toMatchObject({ id: "solo", kind: "issue" });
    expect(computeDagLine(index, "solo")).toBeNull();
  });

  it("counts only done descendants in line frame progress", () => {
    const index = createDagModelIndex(g([
      n("root"), n("a", { parentIssueId: "root", ...done }),
      n("b", { parentIssueId: "root", ...closed }), n("c", { parentIssueId: "root" }),
    ]));
    expect(computeDagLine(index, "root")!.frames[0]!.progress).toEqual({ completed: 1, total: 3 });
  });

  it("keeps reached tasks in nested line frames and marks grouping-only ancestors as context", () => {
    const index = createDagModelIndex(g([
      n("root"), n("sub", { parentIssueId: "root" }), n("child", { parentIssueId: "sub" }), n("source"),
    ], [["source", "child"]]));
    const focus = computeDagFocus(index, "source", true);
    const line = focus.groups.find((group) => group.lineId === "root")!;
    expect(line.tasks.map((task) => [task.issue.id, task.parentId])).toEqual([["child", "sub"]]);
    expect(line.frames.find((frame) => frame.id === "root")).toMatchObject({
      parentId: null, frameIds: ["sub"], taskIds: [], contextOnly: true,
    });
    expect(line.frames.find((frame) => frame.id === "sub")).toMatchObject({
      parentId: "root", frameIds: [], taskIds: ["child"], contextOnly: true,
    });
    expect(line.frames).toHaveLength(2);
  });

  it("excludes hidden closure members from both upstream and downstream ids", () => {
    const index = createDagModelIndex(g([
      n("up", done), n("up-child", { parentIssueId: "up", ...done }), n("target"),
      n("down", done), n("down-child", { parentIssueId: "down", ...done }),
    ], [["up-child", "target"], ["target", "down"]]));
    const hidden = computeDagFocus(index, "target");
    expect(hidden.upstreamIds).toEqual(new Set(["target"]));
    expect(hidden.downstreamIds).toEqual(new Set(["target"]));
    expect(hidden.hiddenIssueCount).toBe(4);

    const shown = computeDagFocus(index, "target", true);
    expect(shown.upstreamIds).toEqual(new Set(["target", "up", "up-child"]));
    expect(shown.downstreamIds).toEqual(new Set(["target", "down", "down-child"]));
    expect(shown.hiddenIssueCount).toBe(0);
  });

  it("gives a kept cancelled task its own focus group when its line is hidden", () => {
    const index = createDagModelIndex(g([
      n("hidden", done), n("cancelled", { parentIssueId: "hidden", ...closed }), n("target"),
    ], [["cancelled", "target"]]));
    const focus = computeDagFocus(index, "target");
    expect(focus.groups.map((group) => group.lineId).sort()).toEqual(["cancelled", "target"]);
    expect(focus.groups.find((group) => group.lineId === "cancelled")).toMatchObject({
      frames: [], tasks: [{ issue: { id: "cancelled" }, parentId: null, role: "context", cancelledBlocking: true }],
    });
  });

  it.each(["a", "sub", "x", "y", "solo"])("matches the existing raw focus closures for %s", (id) => {
    const graph = fixture(), index = createDagModelIndex(graph), projection = computeDagProjection(graph, [], true, true);
    const focused = computeDagFocus(index, id, true);
    for (const way of ["upstream", "downstream"] as const) {
      const old = dagFocusNeighborhood(projection, graph, id, way);
      const mapped = new Set([...focused[way === "upstream" ? "upstreamIds" : "downstreamIds"]].map((raw) => projection.representatives.get(raw) ?? raw));
      expect(mapped).toEqual(old.nodeIds);
    }
  });

  it("counts hidden closure members once and never puts hidden tasks in focus frames", () => {
    const graph = g([n("s", done), n("mid", done), n("target"), n("cancelled", closed)], [["s", "mid"], ["mid", "target"], ["cancelled", "target"]]);
    const index = createDagModelIndex(graph), focus = computeDagFocus(index, "target");
    expect(focus.hiddenIssueCount).toBe(2);
    expect(focus.groups.flatMap((group) => group.tasks.map((task) => task.issue.id)).sort()).toEqual(["cancelled", "target"]);
    expect(focus.dependencies.map((edge) => edge.id)).toEqual(["cancelled-target"]);
    expect(computeDagFocus(index, "target", true).hiddenIssueCount).toBe(0);
    expect(computeDagFocus(index, "missing").groups).toEqual([]);
  });

  it("flattens a kept cancelled frame from a hidden line, and restores its frame with completed work on", () => {
    const index = createDagModelIndex(g([n("cancelled", closed), n("child", { parentIssueId: "cancelled", ...done }), n("target")], [["cancelled", "target"]]));
    const hidden = computeDagFocus(index, "target");
    expect(hidden.groups.flatMap((group) => group.frames)).toEqual([]);
    expect(hidden.dependencies[0]?.sourceKind).toBe("task");
    const shown = computeDagFocus(index, "target", true);
    expect(shown.groups.flatMap((group) => group.frames).map((frame) => frame.id)).toEqual(["cancelled"]);
    expect(shown.dependencies[0]?.sourceKind).toBe("frame");
  });

  it("never parents a retained cancelled task to another flattened task", () => {
    const index = createDagModelIndex(g([n("p", closed), n("c", { parentIssueId: "p", ...closed }), n("target")], [["p", "target"], ["c", "target"]]));
    const focus = computeDagFocus(index, "target");
    expect(focus.groups.flatMap((group) => group.frames)).toEqual([]);
    const tasks = focus.groups.flatMap((group) => group.tasks);
    expect(tasks.find((task) => task.issue.id === "c")).toMatchObject({ parentId: null, role: "context", cancelledBlocking: true });
  });

  it("reuses untouched lines/cards across independent parses and fresh run timestamps", () => {
    const graph = g([n("a"), n("a1", { parentIssueId: "a" }), n("b"), n("b1", { parentIssueId: "b" })]);
    const select = createDagModelSelector();
    const overview = select(graph, { view: "overview" }).overview!;
    const lineA = select(graph, { view: "line", lineId: "a" }).line;
    const lineB = select(graph, { view: "line", lineId: "b" }).line;
    const next = structuredClone(graph);
    next.snapshotId = "new-snapshot";
    for (const node of next.nodes) node.runSummary!.capturedAt = "later";
    Object.assign(next.nodes[1]!, started);
    expect(select(next, { view: "line", lineId: "b" }).line).toBe(lineB);
    expect(select(next, { view: "line", lineId: "a" }).line).not.toBe(lineA);
    expect(select(next, { view: "overview" }).overview!.cards.find((c) => c.id === "issue:b")).toBe(overview.cards.find((c) => c.id === "issue:b"));
    expect(select(next, { view: "overview" })).toBe(select(next, { view: "overview" }));
  });

  it("invalidates a cached line when an external edge changes state with unchanged topology", () => {
    const graph = g([n("a"), n("a1", { parentIssueId: "a" }), n("b"), n("b1", { parentIssueId: "b" })], [["a1", "b1"]]);
    const select = createDagModelSelector(), before = select(graph, { view: "line", lineId: "b" }).line!;
    const next = { ...graph, nodes: graph.nodes.map((node) => node.id === "a1" ? { ...node, ...done } : node) };
    const after = select(next, { view: "line", lineId: "b" }).line!;
    expect(after).not.toBe(before);
    expect(after.upstream[0]?.dependencies[0]?.state).toBe("satisfied");
    expect(before.upstream[0]?.dependencies[0]?.state).toBe("blocking");
  });
});
