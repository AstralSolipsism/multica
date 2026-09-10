// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { IssueGraph, IssueGraphNode } from "@multica/core/api";
import {
  computeDagProjection,
  dagFeatureRepId,
  dagFocusNeighborhood,
  dagProjectRepId,
  defaultDagCollapsedIds,
  pruneDagCollapsedIds,
  repsToRevealIssues,
} from "./dag-projection";

const P1 = "proj-1";
const P2 = "proj-2";

function makeNode(
  id: string,
  partial: Partial<IssueGraphNode> = {},
): IssueGraphNode {
  return {
    id,
    identifier: `T-${id.toUpperCase()}`,
    title: `Task ${id}`,
    status: "todo",
    statusCategory: "todo",
    revision: 1,
    parentIssueId: null,
    hasRestrictedParent: false,
    projectId: null,
    stage: null,
    priority: "none",
    assignee: null,
    role: "match",
    runSummary: {
      queued: 0,
      dispatched: 0,
      running: 0,
      waitingLocalDirectory: 0,
      capturedAt: "2026-09-10T00:00:00Z",
    },
    dependencySummary: {
      visibleUnsatisfiedCount: 0,
      hasRestrictedBlockers: false,
      dependencyVersion: `v-${id}`,
    },
    ...partial,
  };
}

function makeGraph(
  nodes: IssueGraphNode[],
  edges: { id: string; source: string; target: string }[],
): IssueGraph {
  return {
    schemaVersion: 1,
    snapshotId: "snap-1",
    topologyId: "topo-1",
    capturedAt: "2026-09-10T00:00:00Z",
    complete: true,
    scope: { type: "workspace", projectId: null },
    focusIssueId: null,
    matchedCount: nodes.filter((n) => n.role === "match").length,
    contextCount: nodes.filter((n) => n.role === "context").length,
    nodes,
    edges: edges.map((e) => ({
      sourceEdgeId: e.id,
      source: e.source,
      target: e.target,
      type: "blocked_by" as const,
    })),
    projects: [
      { id: P1, title: "Account" },
      { id: P2, title: "Orders" },
    ],
    hasRestrictedContext: false,
  };
}

/**
 * F1 (P1) ── child A1 (P1); B1 (P2); C1 (no project); D1 (context, P2)
 * edges: e1 F1→B1, e2 B1→F1 (legal cross-project bidirectional),
 *        e3 A1→B1, e4 F1→A1 (intra-project)
 */
function fixture() {
  const nodes = [
    makeNode("f1", { projectId: P1, title: "Accounts feature" }),
    makeNode("a1", { projectId: P1, parentIssueId: "f1" }),
    makeNode("b1", { projectId: P2 }),
    makeNode("c1"),
    makeNode("d1", { projectId: P2, role: "context" }),
  ];
  const graph = makeGraph(nodes, [
    { id: "e1", source: "f1", target: "b1" },
    { id: "e2", source: "b1", target: "f1" },
    { id: "e3", source: "a1", target: "b1" },
    { id: "e4", source: "f1", target: "a1" },
  ]);
  return graph;
}

describe("defaultDagCollapsedIds", () => {
  it("folds every project rep and every feature under project grouping", () => {
    const ids = defaultDagCollapsedIds(fixture(), "project");
    expect(ids).toEqual(
      expect.arrayContaining([
        dagProjectRepId(P1),
        dagProjectRepId(P2),
        dagProjectRepId(null),
        dagFeatureRepId("f1"),
      ]),
    );
    expect(ids).toHaveLength(4);
  });

  it("folds only features under parent/none grouping", () => {
    expect(defaultDagCollapsedIds(fixture(), "parent")).toEqual([
      dagFeatureRepId("f1"),
    ]);
    expect(defaultDagCollapsedIds(fixture(), "none")).toEqual([
      dagFeatureRepId("f1"),
    ]);
  });
});

describe("computeDagProjection", () => {
  it("with the default fold leaves only project representatives, aggregating cross-project edges in both directions", () => {
    const graph = fixture();
    const projection = computeDagProjection(
      graph,
      "project",
      defaultDagCollapsedIds(graph, "project"),
    );
    const nodeIds = projection.nodes.map((node) => node.id).sort();
    expect(nodeIds).toEqual([
      dagProjectRepId(null),
      dagProjectRepId(P1),
      dagProjectRepId(P2),
    ]);

    // Both aggregate directions exist and neither is a cycle.
    const p1ToP2 = projection.edges.find(
      (edge) =>
        edge.source === dagProjectRepId(P1) && edge.target === dagProjectRepId(P2),
    );
    const p2ToP1 = projection.edges.find(
      (edge) =>
        edge.source === dagProjectRepId(P2) && edge.target === dagProjectRepId(P1),
    );
    expect(p1ToP2?.sourceEdgeIds.sort()).toEqual(["e1", "e3"]);
    expect(p2ToP1?.sourceEdgeIds).toEqual(["e2"]);
    // Original endpoints stay addressable for explanation and locate.
    expect(p1ToP2?.sources).toEqual([
      { edgeId: "e1", source: "f1", target: "b1" },
      { edgeId: "e3", source: "a1", target: "b1" },
    ]);
    // Intra-project edge e4 is internal to the P1 representative.
    const p1Rep = projection.nodes.find((node) => node.id === dagProjectRepId(P1));
    expect(p1Rep?.internalEdgeCount).toBe(1);
    expect(p1Rep?.matchCount).toBe(2);
    // Context members count separately and never inflate the subject count.
    const p2Rep = projection.nodes.find((node) => node.id === dagProjectRepId(P2));
    expect(p2Rep?.matchCount).toBe(1);
    expect(p2Rep?.contextCount).toBe(1);
    expect(projection.foldedNodeCount).toBe(5);
  });

  it("expanding a project reveals its collapsed feature representatives", () => {
    const graph = fixture();
    const collapsed = defaultDagCollapsedIds(graph, "project").filter(
      (id) => id !== dagProjectRepId(P1),
    );
    const projection = computeDagProjection(graph, "project", collapsed);
    const ids = projection.nodes.map((node) => node.id).sort();
    expect(ids).toEqual([
      dagFeatureRepId("f1"),
      dagProjectRepId(null),
      dagProjectRepId(P2),
    ]);
    // The feature representative carries the feature issue itself plus its
    // folded child, and e4 is internal to it.
    const feature = projection.nodes.find(
      (node) => node.id === dagFeatureRepId("f1"),
    );
    expect(feature?.kind).toBe("feature");
    expect(feature?.memberIds.sort()).toEqual(["a1", "f1"]);
    expect(feature?.internalEdgeCount).toBe(1);
    // Edges to/from the feature itself land on the representative.
    const toFeature = projection.edges.find(
      (edge) =>
        edge.source === dagProjectRepId(P2) && edge.target === dagFeatureRepId("f1"),
    );
    expect(toFeature?.sourceEdgeIds).toEqual(["e2"]);
  });

  it("expanding the feature shows its children as plain issues", () => {
    const graph = fixture();
    const collapsed = defaultDagCollapsedIds(graph, "project").filter(
      (id) => id !== dagProjectRepId(P1) && id !== dagFeatureRepId("f1"),
    );
    const projection = computeDagProjection(graph, "project", collapsed);
    const ids = projection.nodes.map((node) => node.id).sort();
    expect(ids).toEqual(["a1", "f1", dagProjectRepId(null), dagProjectRepId(P2)]);
    const f1 = projection.nodes.find((node) => node.id === "f1");
    expect(f1?.kind).toBe("issue");
    expect(f1?.collapsible).toBe(true);
    const a1 = projection.nodes.find((node) => node.id === "a1");
    expect(a1?.collapsible).toBe(false);
    // Individual edges reappear with their real endpoints.
    const e3 = projection.edges.find(
      (edge) => edge.source === "a1" && edge.target === dagProjectRepId(P2),
    );
    expect(e3?.sourceEdgeIds).toEqual(["e3"]);
  });

  it("parent grouping has no project representatives", () => {
    const graph = fixture();
    const projection = computeDagProjection(
      graph,
      "parent",
      defaultDagCollapsedIds(graph, "parent"),
    );
    const ids = projection.nodes.map((node) => node.id).sort();
    expect(ids).toEqual(["b1", "c1", "d1", dagFeatureRepId("f1")]);
  });

  it("aggregates blocked/run/unknown member signals on representatives", () => {
    const graph = fixture();
    const a1 = graph.nodes.find((node) => node.id === "a1")!;
    a1.dependencySummary = {
      visibleUnsatisfiedCount: 2,
      hasRestrictedBlockers: true,
      dependencyVersion: "v-a1",
    };
    a1.runSummary = {
      queued: 0,
      dispatched: 0,
      running: 1,
      waitingLocalDirectory: 0,
      capturedAt: "2026-09-10T00:00:00Z",
    };
    const d1 = graph.nodes.find((node) => node.id === "d1")!;
    d1.dependencySummary = null;

    const projection = computeDagProjection(
      graph,
      "project",
      defaultDagCollapsedIds(graph, "project"),
    );
    const p1Rep = projection.nodes.find((node) => node.id === dagProjectRepId(P1));
    expect(p1Rep?.blockedMemberCount).toBe(1);
    expect(p1Rep?.hasRestrictedBlockers).toBe(true);
    expect(p1Rep?.runState).toBe("running");
    const p2Rep = projection.nodes.find((node) => node.id === dagProjectRepId(P2));
    expect(p2Rep?.unknownSummaryCount).toBe(1);
  });

  it("reports queued when members queue but none run, and none when idle", () => {
    const graph = fixture();
    const a1 = graph.nodes.find((node) => node.id === "a1")!;
    a1.runSummary = {
      queued: 1,
      dispatched: 0,
      running: 0,
      waitingLocalDirectory: 0,
      capturedAt: "2026-09-10T00:00:00Z",
    };
    const projection = computeDagProjection(
      graph,
      "project",
      defaultDagCollapsedIds(graph, "project"),
    );
    expect(
      projection.nodes.find((node) => node.id === dagProjectRepId(P1))?.runState,
    ).toBe("queued");
    expect(
      projection.nodes.find((node) => node.id === dagProjectRepId(P2))?.runState,
    ).toBe("none");
  });


  it("folds nested features under the outermost collapsed ancestor (review F2)", () => {
    const nodes = [
      makeNode("root"),
      makeNode("middle", { parentIssueId: "root" }),
      makeNode("leaf", { parentIssueId: "middle" }),
    ];
    const graph = makeGraph(nodes, []);
    const projection = computeDagProjection(
      graph,
      "parent",
      defaultDagCollapsedIds(graph, "parent"),
    );
    expect(projection.nodes.map((node) => node.id)).toEqual(["issue:root"]);
    expect(projection.nodes[0]?.memberIds).toEqual(["root", "middle", "leaf"]);

    // Expanding the outermost reveals the still-folded middle layer.
    const next = computeDagProjection(graph, "parent", ["issue:middle"]);
    expect(next.nodes.map((node) => node.id).sort()).toEqual([
      "issue:middle",
      "root",
    ]);
    expect(
      next.nodes.find((node) => node.id === "issue:middle")?.memberIds,
    ).toEqual(["middle", "leaf"]);
  });

  it("keeps every node flat under none grouping with an empty fold", () => {
    const graph = fixture();
    const projection = computeDagProjection(graph, "none", []);
    expect(projection.nodes.map((node) => node.id).sort()).toEqual([
      "a1",
      "b1",
      "c1",
      "d1",
      "f1",
    ]);
    expect(projection.edges).toHaveLength(4);
  });
});

describe("pruneDagCollapsedIds", () => {
  it("drops only provably inert feature folds and keeps everything else", () => {
    const graph = fixture();
    // f1 has a visible child (a1): its fold stays. A feature fold whose node
    // is absent from this graph (filtered out or unknown) also stays — absence
    // is not proof of deletion. Project folds are never auto-pruned.
    expect(
      pruneDagCollapsedIds(
        [dagProjectRepId(P1), "project:gone", dagFeatureRepId("f1"), "issue:gone"],
        graph,
      ),
    ).toEqual([dagProjectRepId(P1), "project:gone", dagFeatureRepId("f1"), "issue:gone"]);
  });

  it("prunes a feature fold whose issue lost all visible children", () => {
    const graph = fixture();
    // Remove a1: f1 remains but has no visible child, so issue:f1 is inert.
    graph.nodes = graph.nodes.filter((node) => node.id !== "a1");
    graph.edges = graph.edges.filter(
      (edge) => edge.source !== "a1" && edge.target !== "a1",
    );
    expect(pruneDagCollapsedIds([dagFeatureRepId("f1")], graph)).toEqual([]);
  });
});

describe("repsToRevealIssues", () => {
  it("returns the nested representatives hiding a node, outermost first", () => {
    const graph = fixture();
    const collapsed = defaultDagCollapsedIds(graph, "project");
    const reps = repsToRevealIssues(graph, "project", collapsed, ["a1"]);
    expect(reps).toEqual([dagProjectRepId(P1), dagFeatureRepId("f1")]);
    // After removing them, the node is visible.
    const next = collapsed.filter((id) => !reps.includes(id));
    const projection = computeDagProjection(graph, "project", next);
    expect(projection.nodes.some((node) => node.id === "a1")).toBe(true);
  });

  it("returns an empty list for already-visible nodes", () => {
    const graph = fixture();
    const collapsed = defaultDagCollapsedIds(graph, "project").filter(
      (id) => id !== dagProjectRepId(P1) && id !== dagFeatureRepId("f1"),
    );
    expect(repsToRevealIssues(graph, "project", collapsed, ["a1"])).toEqual([]);
  });
});

describe("dagFocusNeighborhood", () => {
  // f1 → b1 → c1; a1 is f1's child; d1 depends on a1.
  function focusFixture() {
    const nodes = [
      makeNode("f1", { projectId: P1 }),
      makeNode("a1", { projectId: P1, parentIssueId: "f1" }),
      makeNode("b1"),
      makeNode("c1"),
      makeNode("d1"),
    ];
    return makeGraph(nodes, [
      { id: "e1", source: "f1", target: "b1" },
      { id: "e2", source: "b1", target: "c1" },
      { id: "e3", source: "a1", target: "d1" },
    ]);
  }

  it("downstream walks forward edges transitively", () => {
    const graph = focusFixture();
    const projection = computeDagProjection(graph, "none", []);
    expect([...dagFocusNeighborhood(projection, graph, "f1", "downstream")].sort()).toEqual(
      ["b1", "c1", "f1"],
    );
  });

  it("upstream includes direct prerequisites and the ancestor chain", () => {
    const graph = focusFixture();
    const projection = computeDagProjection(graph, "none", []);
    // d1 waits on a1; a1's feature f1 (ancestor) and f1's own downstream do
    // not leak in — but f1's upstream does (here: none).
    expect([...dagFocusNeighborhood(projection, graph, "d1", "upstream")].sort()).toEqual(
      ["a1", "d1", "f1"],
    );
    // b1 waits on f1; nothing else.
    expect([...dagFocusNeighborhood(projection, graph, "b1", "upstream")].sort()).toEqual(
      ["b1", "f1"],
    );
  });

  it("folded ancestors light their representative, not a hidden node", () => {
    const graph = focusFixture();
    const projection = computeDagProjection(graph, "none", ["issue:f1"]);
    // d1 waits on a1, which is folded into the feature rep issue:f1; the
    // neighborhood contains the rep id, and never the invisible a1.
    const seen = dagFocusNeighborhood(projection, graph, "d1", "upstream");
    expect(seen.has("issue:f1")).toBe(true);
    expect(seen.has("a1")).toBe(false);
  });

  it("downstream from a folded feature starts at its representative", () => {
    const graph = focusFixture();
    const projection = computeDagProjection(graph, "none", ["issue:f1"]);
    // b1 waits on the folded feature; the rep's downstream reaches b1/c1.
    const seen = dagFocusNeighborhood(projection, graph, "issue:f1", "downstream");
    expect(seen.has("b1")).toBe(true);
    expect(seen.has("c1")).toBe(true);
  });
  it("downstream includes descendants that inherit a prerequisite (review F4)", () => {
    const graph = makeGraph(
      [makeNode("prerequisite"), makeNode("feature"), makeNode("child", { parentIssueId: "feature" })],
      [{ id: "e1", source: "prerequisite", target: "feature" }],
    );
    const projection = computeDagProjection(graph, "none", []);
    expect([
      ...dagFocusNeighborhood(projection, graph, "prerequisite", "downstream"),
    ]).toContain("child");
  });

  it("upstream recursively resolves prerequisites of reached ancestors (review F4)", () => {
    const graph = makeGraph(
      [
        makeNode("child", { parentIssueId: "feature" }),
        makeNode("feature"),
        makeNode("dependency", { parentIssueId: "dependency-parent" }),
        makeNode("dependency-parent"),
        makeNode("upstream"),
      ],
      [
        { id: "e1", source: "dependency", target: "feature" },
        { id: "e2", source: "upstream", target: "dependency-parent" },
      ],
    );
    const projection = computeDagProjection(graph, "none", []);
    expect([
      ...dagFocusNeighborhood(projection, graph, "child", "upstream"),
    ]).toEqual(
      expect.arrayContaining(["feature", "dependency", "dependency-parent", "upstream"]),
    );
  });

  it("the root's own children are not its downstream", () => {
    const graph = makeGraph(
      [makeNode("parent"), makeNode("kid", { parentIssueId: "parent" })],
      [],
    );
    const projection = computeDagProjection(graph, "none", []);
    expect([...dagFocusNeighborhood(projection, graph, "parent", "downstream")]).toEqual(
      ["parent"],
    );
  });
});
