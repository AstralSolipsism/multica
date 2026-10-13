// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IssueGraphSchema } from "../../api/issue-graph-schemas";
import {
  ISSUE_GRAPH_FIXTURE_DATASETS,
  analyzeIssueGraphFixture,
  buildIssueGraphFixture,
  issueGraphFixtureDigest,
  type IssueGraphFixtureDatasetName,
  type SyntheticGraphNode,
  type SyntheticIssueGraph,
} from "./issue-graph-fixture";

const DATASETS: IssueGraphFixtureDatasetName[] = [
  "accept-5000",
  "stress-5000",
  "1000",
  "2500",
  "10000",
  "big-line",
];

/** Shape datasets: "empty" is a harness self-check, not a shape to assert. */
const SHAPE_DATASETS = DATASETS;

describe("synthetic issue graph fixtures", () => {
  it.each(DATASETS)("passes IssueGraphSchema: %s", (name) => {
    const graph = buildIssueGraphFixture(name);
    const parsed = IssueGraphSchema.parse(graph);
    expect(parsed.matchedCount).toBe(graph.nodes.length);
    expect(parsed.scope.type).toBe("workspace");
    // The endpoint sorts by id; the document must arrive in that order.
    const ids = graph.nodes.map((n) => n.id);
    expect([...ids].sort()).toEqual(ids);
    expect(graph.edges.map((e) => e.source_edge_id)).toEqual(
      [...graph.edges.map((e) => e.source_edge_id)].sort(),
    );
  });

  it("parses the empty self-check dataset", () => {
    const graph = buildIssueGraphFixture("empty");
    expect(graph.nodes).toHaveLength(0);
    expect(IssueGraphSchema.parse(graph).matchedCount).toBe(0);
  });

  it.each(SHAPE_DATASETS)("matches the requested scale and shape: %s", (name) => {
    const config = ISSUE_GRAPH_FIXTURE_DATASETS[name]!;
    const graph = buildIssueGraphFixture(name);
    const stats = analyzeIssueGraphFixture(graph);
    expect(stats.nodes).toBe(config.totalTasks);
    expect(stats.acyclic).toBe(true);
    expect(stats.maxDepth).toBeLessThanOrEqual(4);
    expect(stats.stagesPresent).toEqual([1, 2, 3, 4, 5, 6]);
    // Backend rule: no edge may connect an ancestor and a descendant.
    expect(stats.ancestorEdges).toBe(0);
    // Cross-line dependencies follow the production flow, never against it.
    expect(stats.crossLineAgainstFlow).toBe(0);
    // Cross-line share (target side): OL-183's ~20% target.
    if (name !== "big-line") {
      expect(stats.crossLineShare).toBeGreaterThanOrEqual(0.15);
      expect(stats.crossLineShare).toBeLessThanOrEqual(0.25);
    }
    // In-line prerequisites: every leaf after its line's first has 1–2.
    expect(stats.inlinePrereqMin).toBeGreaterThanOrEqual(1);
    expect(stats.inlinePrereqMax).toBeLessThanOrEqual(2);
    expect(stats.leavesWithoutInlinePrereq).toBe(stats.lines);
    // Lines of 30–40 tasks (single-line dataset excepted).
    if (name !== "big-line") {
      expect(stats.lineSizeMin).toBeGreaterThanOrEqual(30);
      expect(stats.lineSizeMax).toBeLessThanOrEqual(40);
      expect(graph.projects).toHaveLength(6);
      expect(stats.lines).toBeGreaterThanOrEqual(6);
      expect(stats.fullyDoneLines).toBeGreaterThanOrEqual(1);
      expect(stats.hiddenLineTasks).toBeGreaterThan(0);
      expect(stats.cancelledStillBlocking).toBeGreaterThanOrEqual(1);
    } else {
      expect(stats.lines).toBe(1);
    }
    if (name === "accept-5000") {
      // OL-183's acceptance shape: no more than 800 unfinished tasks.
      expect(stats.unfinished).toBeLessThanOrEqual(800);
    }
    if (name === "stress-5000") {
      // OL-184's stress shape: roughly 2,400 unfinished.
      expect(stats.unfinished).toBeGreaterThan(1_500);
      expect(stats.unfinished).toBeLessThan(3_200);
    }
  });

  it.each(["accept-5000", "stress-5000"] as const)(
    "produces the documented status spread: %s",
    (name) => {
      const stats = analyzeIssueGraphFixture(buildIssueGraphFixture(name));
      const share = (status: string) => (stats.statuses[status] ?? 0) / stats.nodes;
      expect(share("done")).toBeGreaterThan(0.3);
      expect(share("in_progress")).toBeGreaterThan(0.01);
      expect(share("in_review")).toBeGreaterThan(0);
      expect(share("blocked")).toBeGreaterThan(0);
      expect(share("cancelled")).toBeGreaterThan(0);
      // Every in-progress task carries a summary with an active count.
      expect(stats.inProgressWithoutRunSummary).toBe(0);
      expect(stats.inProgressWithoutActiveRun).toBe(0);
    },
  );

  it("computes dependency summaries the way the backend does", () => {
    const graph = buildIssueGraphFixture("stress-5000");
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Backend: unique direct prerequisites of the node AND its ancestors,
    // satisfied only by `done` (model.go Prerequisites + VisibleUnsatisfied).
    const sourcesOf = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      const set = sourcesOf.get(edge.target) ?? new Set<string>();
      set.add(edge.source);
      sourcesOf.set(edge.target, set);
    }
    for (const node of graph.nodes.slice(0, 500)) {
      const closure = new Set<string>();
      let current: string | null = node.id;
      while (current != null) {
        for (const source of sourcesOf.get(current) ?? []) closure.add(source);
        current = byId.get(current)!.parent_issue_id;
      }
      const expected = [...closure].filter((id) => byId.get(id)!.status !== "done").length;
      expect(node.dependency_summary!.visible_unsatisfied_count).toBe(expected);
    }
    // And the cancelled-but-blocking anchor really blocks: a cancelled node
    // whose downstream target stays unfinished.
    const cancelled = graph.nodes.filter((n) => n.status === "cancelled");
    expect(cancelled.length).toBeGreaterThan(0);
    const blockingCancelled = cancelled.filter((n) => {
      const targets = graph.edges.filter((e) => e.source === n.id).map((e) => byId.get(e.target)!);
      return targets.some((t) => t.status !== "done" && t.status !== "cancelled");
    });
    expect(blockingCancelled.length).toBeGreaterThan(0);
  });

  it("regenerates byte-identical documents for the same dataset", () => {
    // Fresh-process semantics are emulated by config objects (the named cache
    // would hand back the same reference): same config, same bytes.
    const a = buildIssueGraphFixture({ ...ISSUE_GRAPH_FIXTURE_DATASETS["1000"]!, name: "copy-a" });
    const b = buildIssueGraphFixture({ ...ISSUE_GRAPH_FIXTURE_DATASETS["1000"]!, name: "copy-b" });
    expect(a).toEqual(b);
    expect(issueGraphFixtureDigest(a)).toBe(issueGraphFixtureDigest(b));
    const c = buildIssueGraphFixture({ ...ISSUE_GRAPH_FIXTURE_DATASETS["1000"]!, name: "copy-c", seed: "other" });
    expect(issueGraphFixtureDigest(a)).not.toBe(issueGraphFixtureDigest(c));
    // The named datasets are stable singletons per process.
    expect(buildIssueGraphFixture("2500")).toBe(buildIssueGraphFixture("2500"));
  });

  it("hits the exact node total across many seeds, including single-line", () => {
    for (const seed of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]) {
      const single = buildIssueGraphFixture({
        ...ISSUE_GRAPH_FIXTURE_DATASETS["big-line"]!, name: `probe-${seed}`, seed,
      });
      expect(analyzeIssueGraphFixture(single).nodes).toBe(1_000);
      const multi = buildIssueGraphFixture({
        ...ISSUE_GRAPH_FIXTURE_DATASETS["2500"]!, name: `probe-m-${seed}`, seed,
      });
      const stats = analyzeIssueGraphFixture(multi);
      expect(stats.nodes).toBe(2_500);
      expect(stats.lineSizeMin).toBeGreaterThanOrEqual(30);
      expect(stats.lineSizeMax).toBeLessThanOrEqual(40);
    }
  });

  // The analyzer is the oracle for every shape assertion above; pin it on a
  // hand-built graph whose properties are known exactly.
  describe("analyzer", () => {
    const node = (
      id: string,
      parent: string | null,
      status: string,
      stage: number | null = null,
      projectId = "p1",
    ): SyntheticGraphNode => ({
      id,
      identifier: id.toUpperCase(),
      title: `node ${id}`,
      status,
      status_category: status === "done" ? "done" : status === "cancelled" ? "closed" : "started",
      revision: 1,
      parent_issue_id: parent,
      has_restricted_parent: false,
      project_id: projectId,
      stage,
      priority: "none",
      assignee: null,
      role: "match",
      run_summary: null,
      dependency_summary: null,
    });
    const graphOf = (
      nodes: SyntheticGraphNode[],
      edges: [string, string][],
      projects: { id: string; title: string }[] = [
        { id: "p1", title: "Client" },
        { id: "p2", title: "Level" },
      ],
    ): SyntheticIssueGraph => ({
      schema_version: 1,
      snapshot_id: "s",
      topology_id: "t",
      captured_at: "2026-10-01T00:00:00.000Z",
      complete: true,
      scope: { type: "workspace", project_id: null },
      focus_issue_id: null,
      matched_count: nodes.length,
      context_count: 0,
      nodes,
      edges: edges.map(([source, target], i) => ({
        source_edge_id: `e${i}`, source, target, type: "blocked_by" as const,
      })),
      projects,
      has_restricted_context: false,
    });

    it("detects cycles, ancestor edges, flow violations and counts", () => {
      // Line a (root a, task a1, Client flow 2) and line b (root b, tasks
      // b1/b2, Level flow 3). a1 → b1 is down-flow; b1 → a1 would not be.
      const nodes = [
        node("a", null, "todo"),
        node("a1", "a", "in_progress", 1),
        node("b", null, "todo", null, "p2"),
        node("b1", "b", "done", 1, "p2"),
        node("b2", "b", "cancelled", 2, "p2"),
      ];
      const cleanStats = analyzeIssueGraphFixture(graphOf(nodes, [["a1", "b1"]]));
      expect(cleanStats.acyclic).toBe(true);
      expect(cleanStats.ancestorEdges).toBe(0);
      expect(cleanStats.crossLineAgainstFlow).toBe(0); // Client → Level
      expect(cleanStats.crossLineTasks).toBe(1); // b1 has a cross-line prereq
      expect(cleanStats.crossLineShare).toBeCloseTo(1 / 3); // leaves: a1, b1, b2
      expect(cleanStats.leavesWithoutInlinePrereq).toBe(3); // no in-line edges
      expect(cleanStats.unfinished).toBe(3); // a, a1, b (b1 done, b2 cancelled)

      expect(analyzeIssueGraphFixture(graphOf(nodes, [["a1", "b1"], ["b1", "a1"]])).acyclic).toBe(false);
      expect(analyzeIssueGraphFixture(graphOf(nodes, [["a", "a1"]])).ancestorEdges).toBe(1);
      expect(analyzeIssueGraphFixture(graphOf(nodes, [["b1", "a1"]])).crossLineAgainstFlow).toBe(1);

      // b1 → b2 is in-line; a1 → b1 cross-line; a1 has none.
      const inlineStats = analyzeIssueGraphFixture(graphOf(nodes, [["b1", "b2"], ["a1", "b1"]]));
      expect(inlineStats.inlinePrereqMin).toBe(1);
      expect(inlineStats.inlinePrereqMax).toBe(1);
      expect(inlineStats.leavesWithoutInlinePrereq).toBe(2); // a1 has none; b1's only prereq is cross-line
      expect(inlineStats.crossLineTasks).toBe(1);
    });

    it("counts only fully-done lines as hidden and finds cancelled blockers", () => {
      // Line a fully done (done + cancelled members) but its cancelled member
      // still blocks an unfinished task in line b.
      const nodes = [
        node("a", null, "done"),
        node("a1", "a", "done", 1),
        node("a2", "a", "cancelled", 2),
        node("b", null, "in_progress", null, "p2"),
        node("b1", "b", "in_progress", 1, "p2"),
      ];
      const stats = analyzeIssueGraphFixture(graphOf(nodes, [["a2", "b1"]]));
      expect(stats.fullyDoneLines).toBe(1);
      expect(stats.hiddenLineTasks).toBe(3);
      expect(stats.cancelledStillBlocking).toBe(1);
      expect(stats.unfinished).toBe(2);
      // A cancelled member with no downstream edge blocks nothing.
      expect(analyzeIssueGraphFixture(graphOf(nodes, [])).cancelledStillBlocking).toBe(0);
    });

    it("reports stages present and line size bounds", () => {
      const nodes = [
        node("a", null, "todo"),
        node("a1", "a", "todo", 1),
        node("a2", "a", "todo", 3),
        node("a3", "a", "todo", 6),
        node("a4", "a", "todo", 6),
      ];
      const stats = analyzeIssueGraphFixture(graphOf(nodes, []));
      expect(stats.stagesPresent).toEqual([1, 3, 6]);
      expect(stats.lineSizeMin).toBe(5);
      expect(stats.lineSizeMax).toBe(5);
      expect(stats.maxDepth).toBe(2);
    });
  });
});
