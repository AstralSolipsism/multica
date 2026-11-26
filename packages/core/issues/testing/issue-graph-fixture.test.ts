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
    const projectIds = graph.projects.map((p) => p.id);
    expect([...projectIds].sort()).toEqual(projectIds);
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
    // In-line prerequisites: every leaf after its line's first has 1–2, and
    // both counts actually occur (max === 2 kills "always 1").
    expect(stats.inlinePrereqMin).toBeGreaterThanOrEqual(1);
    expect(stats.inlinePrereqMax).toBe(2);
    expect(stats.leavesWithoutInlinePrereq).toBe(stats.lines);
    // Lines of 30–40 tasks (single-line dataset excepted).
    if (name !== "big-line") {
      expect(stats.lineSizeMin).toBeGreaterThanOrEqual(30);
      expect(stats.lineSizeMax).toBeLessThanOrEqual(40);
      expect(graph.projects).toHaveLength(6);
      expect(stats.lines).toBeGreaterThanOrEqual(6);
      expect(stats.fullyDoneLines).toBeGreaterThanOrEqual(1);
      expect(stats.hiddenLineTasks).toBeGreaterThan(0);
      expect(stats.cancelledSatisfiedEdges).toBeGreaterThanOrEqual(1);
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

  it.each(DATASETS)(
    "aligns effective_issue_blocker edges and dependency summaries with migration 746: %s",
    (name) => {
      const graph = buildIssueGraphFixture(name);
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      // Partition emitted edges into manual vs stage and enforce unique endpoint
      // pairs plus canonical `<via>:<target>:<source>` provenance IDs.
      const manualPairs = new Set<string>();
      const seenPairs = new Set<string>();
      const actualStageIds: string[] = [];
      let manualOverridingStage = 0;
      for (const edge of graph.edges) {
        const pair = `${edge.source}->${edge.target}`;
        expect(seenPairs.has(pair)).toBe(false);
        seenPairs.add(pair);
        const source = byId.get(edge.source)!;
        const target = byId.get(edge.target)!;
        const isStageEligible =
          source.parent_issue_id !== null &&
          source.parent_issue_id === target.parent_issue_id &&
          source.stage !== null &&
          target.stage !== null &&
          source.stage < target.stage;
        if (edge.source_edge_id.startsWith("manual:")) {
          expect(edge.source_edge_id).toBe(`manual:${edge.target}:${edge.source}`);
          manualPairs.add(pair);
          if (isStageEligible) manualOverridingStage += 1;
        } else {
          expect(edge.source_edge_id).toBe(`stage:${edge.target}:${edge.source}`);
          expect(isStageEligible).toBe(true);
          actualStageIds.push(edge.source_edge_id);
        }
      }

      // Independently derive all expected same-parent stage edges from node
      // (parent_issue_id, stage), excluding pairs already covered by manual rows
      // (exact mirror of server/migrations/746_issue_blocker_rules.up.sql:6-10).
      const byParent = new Map<string, SyntheticGraphNode[]>();
      for (const node of graph.nodes) {
        if (node.parent_issue_id === null || node.stage === null) continue;
        const list = byParent.get(node.parent_issue_id) ?? [];
        list.push(node);
        byParent.set(node.parent_issue_id, list);
      }
      const expectedStageIds: string[] = [];
      const expectedSourcesOf = new Map<string, string[]>();
      for (const pair of manualPairs) {
        const [source, target] = pair.split("->") as [string, string];
        const list = expectedSourcesOf.get(target) ?? [];
        list.push(source);
        expectedSourcesOf.set(target, list);
      }
      for (const siblings of byParent.values()) {
        for (const target of siblings) {
          for (const source of siblings) {
            if (source.stage! >= target.stage!) continue;
            const pair = `${source.id}->${target.id}`;
            if (manualPairs.has(pair)) continue;
            expectedStageIds.push(`stage:${target.id}:${source.id}`);
            const list = expectedSourcesOf.get(target.id) ?? [];
            list.push(source.id);
            expectedSourcesOf.set(target.id, list);
          }
        }
      }
      expectedStageIds.sort();
      actualStageIds.sort();
      expect(actualStageIds).toEqual(expectedStageIds);
      expect(expectedStageIds.length).toBeGreaterThan(0);
      // Verify manual-over-stage precedence is actually exercised on same-parent
      // earlier-stage pairs (retained as `manual:`, never duplicated as `stage:`).
      expect(manualOverridingStage).toBeGreaterThan(0);

      // Recompute dependency summaries strictly from the independently derived
      // effective edge set (server/internal/service/issue_graph.go:260).
      let mismatched = 0;
      for (const node of graph.nodes) {
        const directSources = expectedSourcesOf.get(node.id) ?? [];
        const expected = directSources.filter((id) => {
          const status = byId.get(id)!.status;
          return status !== "done" && status !== "cancelled";
        }).length;
        if (node.dependency_summary!.visible_unsatisfied_count !== expected) {
          mismatched += 1;
        }
      }
      expect(mismatched).toBe(0);

      // Cancelled prerequisites retain their relationship edges in the graph
      // while already counting as satisfied (never blocking downstream tasks).
      if (name !== "big-line") {
        const cancelledEdgesToUnfinished = graph.edges.filter((edge) => {
          const source = byId.get(edge.source)!;
          const target = byId.get(edge.target)!;
          return (
            source.status === "cancelled" &&
            target.status !== "done" &&
            target.status !== "cancelled"
          );
        });
        expect(cancelledEdgesToUnfinished.length).toBeGreaterThan(0);
        for (const edge of cancelledEdgesToUnfinished) {
          const target = byId.get(edge.target)!;
          const nonTerminalDirect = (expectedSourcesOf.get(target.id) ?? []).filter((id) => {
            const status = byId.get(id)!.status;
            return status !== "done" && status !== "cancelled";
          }).length;
          expect(target.dependency_summary!.visible_unsatisfied_count).toBe(nonTerminalDirect);
        }
      }
    },
  );

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

  it("analyzes an empty graph without infinities and serves frozen cached documents", () => {
    const stats = analyzeIssueGraphFixture(buildIssueGraphFixture("empty"));
    expect(stats).toEqual({
      nodes: 0, edges: 0, leaves: 0, containers: 0, lines: 0,
      lineSizeMin: 0, lineSizeMax: 0, fullyDoneLines: 0, hiddenLineTasks: 0,
      unfinished: 0, statuses: {}, maxDepth: 0, minDepth: 0, stagesPresent: [],
      crossLineTasks: 0, crossLineShare: 0, crossLineAgainstFlow: 0, ancestorEdges: 0,
      leavesWithoutInlinePrereq: 0, inlinePrereqMin: 0, inlinePrereqMax: 0,
      inProgressWithoutRunSummary: 0, inProgressWithoutActiveRun: 0,
      cancelledSatisfiedEdges: 0, acyclic: true,
    });
    // Cached documents are shared read-only: mutation must throw in strict
    // mode (vitest transpiles ESM, which is strict).
    const graph = buildIssueGraphFixture("1000");
    expect(() => { graph.nodes[0]!.title = "tampered"; }).toThrow();
  });

  it("refuses infeasible generator configurations with explicit errors", () => {
    // Line bounds unreachable for the total (85 tasks cannot make 30–40 lines)
    // must throw, not hang.
    expect(() => buildIssueGraphFixture({
      ...ISSUE_GRAPH_FIXTURE_DATASETS["2500"]!,
      name: "probe-infeasible", totalTasks: 85, seed: "x",
    })).toThrow(/infeasible spread bounds/);
    // No unfinished line for the cancelled-satisfied anchor.
    expect(() => buildIssueGraphFixture({
      ...ISSUE_GRAPH_FIXTURE_DATASETS["2500"]!,
      name: "probe-all-done", seed: "x",
      profile: { ...ISSUE_GRAPH_FIXTURE_DATASETS["2500"]!.profile, doneLineShare: 1 },
    })).toThrow(/no unfinished line/);
  });

  it("hits the exact node total across many seeds, including single-line", { timeout: 30_000 }, () => {
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

    it("counts only fully-done lines as hidden and finds cancelled satisfied edges", () => {
      // Line a is completed (done + cancelled members) and its cancelled member
      // retains a satisfied outgoing edge to an unfinished task in line b.
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
      expect(stats.cancelledSatisfiedEdges).toBe(1);
      expect(stats.unfinished).toBe(2);
      // A cancelled member with no outgoing edge has zero satisfied edges.
      expect(analyzeIssueGraphFixture(graphOf(nodes, [])).cancelledSatisfiedEdges).toBe(0);
    });

    it("counts same-flow cross-line edges as against the flow (N11)", () => {
      // Two lines on the SAME project (flow equal): their cross edges are
      // lateral, not down-flow, and must count as against-flow.
      const nodes = [
        node("a", null, "todo"),
        node("a1", "a", "todo", 1),
        node("b", null, "todo"),
        node("b1", "b", "todo", 1),
      ];
      const stats = analyzeIssueGraphFixture(graphOf(nodes, [["a1", "b1"]]));
      expect(stats.crossLineAgainstFlow).toBe(1); // 1 >= 1
      // Down-flow (client 2 → level 3) stays clean.
      const down = [
        node("a", null, "todo"), node("a1", "a", "todo", 1),
        node("b", null, "todo", null, "p2"), node("b1", "b", "todo", 1, "p2"),
      ];
      expect(analyzeIssueGraphFixture(graphOf(down, [["a1", "b1"]])).crossLineAgainstFlow).toBe(0);
    });

    it("flags ancestor edges in either direction (N12)", () => {
      // Parent → child is an ancestor edge; so is child → parent.
      const nodes = [
        node("a", null, "todo"),
        node("a1", "a", "todo", 1),
        node("b", null, "todo"),
        node("b1", "b", "todo", 1),
      ];
      expect(analyzeIssueGraphFixture(graphOf(nodes, [["a", "a1"]])).ancestorEdges).toBe(1);
      expect(analyzeIssueGraphFixture(graphOf(nodes, [["a1", "a"]])).ancestorEdges).toBe(1);
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
