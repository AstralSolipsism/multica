// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IssueGraphSchema } from "../../api/issue-graph-schemas";
import {
  ISSUE_GRAPH_FIXTURE_DATASETS,
  analyzeIssueGraphFixture,
  buildIssueGraphFixture,
  issueGraphFixtureDigest,
  type IssueGraphFixtureDatasetName,
} from "./issue-graph-fixture";

const DATASETS: IssueGraphFixtureDatasetName[] = [
  "accept-5000",
  "stress-5000",
  "1000",
  "2500",
  "10000",
  "big-line",
];

describe("synthetic issue graph fixtures", () => {
  it.each(DATASETS)("passes IssueGraphSchema: %s", (name) => {
    const graph = buildIssueGraphFixture(name);
    const parsed = IssueGraphSchema.parse(graph);
    expect(parsed.matchedCount).toBe(graph.nodes.length);
    expect(parsed.scope.type).toBe("workspace");
  });

  it.each(DATASETS)("matches the requested scale and shape: %s", (name) => {
    const config = ISSUE_GRAPH_FIXTURE_DATASETS[name];
    const graph = buildIssueGraphFixture(name);
    const stats = analyzeIssueGraphFixture(graph);
    expect(stats.nodes).toBe(config.totalTasks);
    expect(stats.acyclic).toBe(true);
    expect(stats.maxDepth).toBeLessThanOrEqual(4);
    expect(stats.stages.max).toBeLessThanOrEqual(6);
    expect(stats.stages.min).toBeGreaterThanOrEqual(1);
    // Cross-line dependencies: OL-183's ~20% target (a single line has none).
    if (name !== "big-line") expect(stats.crossLineShare).toBeGreaterThanOrEqual(0.05);
    expect(stats.crossLineShare).toBeLessThanOrEqual(0.5);
    // In-line prerequisites: every leaf except line roots has at least one.
    const lineRoots = graph.nodes.filter((n) => n.parent_issue_id === null).length;
    const leaves = stats.leaves;
    const minEdges = leaves - lineRoots;
    expect(graph.edges.length).toBeGreaterThanOrEqual(minEdges);
    if (name === "accept-5000") {
      // OL-183's acceptance shape: no more than 800 unfinished tasks.
      expect(stats.unfinished).toBeLessThanOrEqual(800);
    }
    if (name === "stress-5000") {
      // OL-184's stress shape: roughly 2,400 unfinished.
      expect(stats.unfinished).toBeGreaterThan(1_500);
      expect(stats.unfinished).toBeLessThan(3_200);
    }
    if (name === "big-line") {
      expect(stats.lines).toBe(1);
    } else {
      // Six projects, one line each at minimum.
      expect(graph.projects).toHaveLength(6);
      expect(stats.lines).toBeGreaterThanOrEqual(6);
      expect(stats.fullyDoneLines).toBeGreaterThanOrEqual(1);
      expect(stats.hiddenLineTasks).toBeGreaterThan(0);
      expect(stats.cancelledStillBlocking).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(["accept-5000", "stress-5000"] as const)(
    "produces the documented status spread: %s",
    (name) => {
      const stats = analyzeIssueGraphFixture(buildIssueGraphFixture(name));
      const share = (status: string) => (stats.statuses[status] ?? 0) / stats.nodes;
      expect(share("done")).toBeGreaterThan(0.3);
      // Active work: in_progress / in_review / blocked all present.
      expect(share("in_progress")).toBeGreaterThan(0.01);
      expect(share("in_review")).toBeGreaterThan(0);
      expect(share("blocked")).toBeGreaterThan(0);
      expect(share("cancelled")).toBeGreaterThan(0);
      // Running summaries: every in_progress task carries one.
      expect(stats.inProgressWithoutRunSummary).toBe(0);
    },
  );

  it("regenerates byte-identical documents for the same dataset", { timeout: 30_000 }, () => {
    for (const name of DATASETS.slice(0, 3)) {
      const a = buildIssueGraphFixture(name);
      const b = buildIssueGraphFixture(name);
      expect(a).toEqual(b);
      expect(issueGraphFixtureDigest(a)).toBe(issueGraphFixtureDigest(b));
    }
    // And distinct across datasets and seeds.
    const a = buildIssueGraphFixture("1000");
    const b = buildIssueGraphFixture("2500");
    expect(issueGraphFixtureDigest(a)).not.toBe(issueGraphFixtureDigest(b));
    const c = buildIssueGraphFixture({ ...ISSUE_GRAPH_FIXTURE_DATASETS["1000"]!, seed: "other" });
    expect(issueGraphFixtureDigest(a)).not.toBe(issueGraphFixtureDigest(c));
  });
});
