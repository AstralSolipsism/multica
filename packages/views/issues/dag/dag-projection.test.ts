// @vitest-environment node
import { describe, expect, it } from "vitest";
import { graphNode as makeNode, issueGraph as makeGraph } from "./dag-test-fixtures";
import {
  computeDagProjection,
  dagFeatureRepId,
  dagFocusNeighborhood,
  DAG_INDEPENDENT_GROUP,
  defaultDagCollapsedIds,
  repsToRevealIssues,
} from "./dag-projection";
const P1 = "proj-1";
const P2 = "proj-2";

describe("task-line projection", () => {
  function fixture() {
    return makeGraph(
      [
        makeNode("one", { projectId: P1 }),
        makeNode("a", { parentIssueId: "one", projectId: P1 }),
        makeNode("b", { parentIssueId: "one", projectId: P2 }),
        makeNode("two"),
        makeNode("c", { parentIssueId: "two" }),
        makeNode("solo"),
      ],
      [
        { id: "ab", source: "a", target: "b" },
        { id: "ac", source: "a", target: "c" },
        { id: "bc", source: "b", target: "c" },
        { id: "ca", source: "c", target: "a" },
      ],
    );
  }
  it("defaults to folded task lines and a separate folded independent group", () => {
    const graph = fixture(),
      folded = defaultDagCollapsedIds(graph);
    expect(folded.sort()).toEqual(["issue:one", "issue:two"]);
    const view = computeDagProjection(graph, folded);
    expect(view.nodes.map((n) => n.id)).toEqual(["issue:one", "issue:two", DAG_INDEPENDENT_GROUP]);
    expect(view.groups.every((g) => g.collapsed)).toBe(true);
    expect(view.foldedNodeCount).toBe(4);
  });
  it("preserves all original endpoints when aggregating opposite cross-line directions", () => {
    const graph = fixture(),
      before = JSON.stringify(graph);
    const view = computeDagProjection(graph, defaultDagCollapsedIds(graph));
    const forward = view.edges.find((e) => e.source === "issue:one")!;
    expect(forward.sourceEdgeIds.sort()).toEqual(["ac", "bc"]);
    expect(forward.sources).toEqual(
      expect.arrayContaining([
        { edgeId: "ac", source: "a", target: "c" },
        { edgeId: "bc", source: "b", target: "c" },
      ]),
    );
    expect(view.edges.find((e) => e.source === "issue:two")?.sourceEdgeIds).toEqual(["ca"]);
    expect(view.nodes.find((n) => n.id === "issue:one")?.internalEdgeCount).toBe(1);
    expect(JSON.stringify(graph)).toBe(before);
  });
  it("keeps the parent as a container header and connects expanded children to folded boundaries", () => {
    const view = computeDagProjection(fixture(), ["issue:two"]);
    expect(view.nodes.find((n) => n.id === "one")).toBeUndefined();
    expect(view.nodes.find((n) => n.id === "issue:one")?.kind).toBe("feature");
    expect(view.nodes.find((n) => n.id === "b")?.groupId).toBe("issue:one");
    expect(view.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      "a->b",
      "a->issue:two",
      "b->issue:two",
      "issue:two->a",
    ]);
    expect(view.representatives.get("one")).toBe("issue:one");
  });
  it("keeps independent tasks folded while all task lines are expanded", () => {
    const graph = fixture(),
      folded = computeDagProjection(graph, []),
      expanded = computeDagProjection(graph, [], true);
    expect(folded.nodes.some((n) => n.id === "solo")).toBe(false);
    expect(expanded.nodes.find((n) => n.id === "solo")?.groupId).toBe(DAG_INDEPENDENT_GROUP);
    expect(expanded.groups.find((g) => g.independent)?.collapsed).toBe(false);
  });
  it("does not mistake dependency starts/ends, restricted parents, or unknown summaries for independent tasks", () => {
    const graph = makeGraph(
      [
        makeNode("a"),
        makeNode("end"),
        makeNode("hidden-parent", { hasRestrictedParent: true }),
        makeNode("unknown", { dependencySummary: null }),
        makeNode("restricted", {
          dependencySummary: {
            visibleUnsatisfiedCount: 0,
            hasRestrictedBlockers: true,
            dependencyVersion: "v",
          },
        }),
      ],
      [{ id: "ae", source: "a", target: "end" }],
    );
    const view = computeDagProjection(graph, []);
    expect(view.groups).toEqual([]);
    expect(view.nodes).toHaveLength(5);
  });
  it("keeps unordered children and cross-project descendants inside their real task line", () => {
    const graph = makeGraph(
      [
        makeNode("root", { projectId: P1 }),
        makeNode("child", { parentIssueId: "root", projectId: P2 }),
      ],
      [],
    );
    const view = computeDagProjection(graph, []);
    expect(view.groups).toHaveLength(1);
    expect(view.nodes.find((n) => n.id === "child")?.groupId).toBe("issue:root");
    expect(view.groups[0]!.memberIds).toEqual(["root", "child"]);
  });
  it("preserves nested group boundaries and folds only the selected subtree", () => {
    const graph = makeGraph(
      [
        makeNode("root"),
        makeNode("middle", { parentIssueId: "root", stage: 1 }),
        makeNode("leaf", { parentIssueId: "middle", stage: 99 }),
        makeNode("last", { parentIssueId: "root", stage: 2 }),
      ],
      [],
    );
    const view = computeDagProjection(graph, ["issue:middle"]);
    expect(view.groups.find((g) => g.id === "issue:middle")?.parentId).toBe("issue:root");
    expect(view.nodes.find((n) => n.id === "issue:middle")?.issue?.stage).toBe(1);
    expect(view.nodes.some((n) => n.id === "leaf")).toBe(false);
    expect(view.representatives.get("leaf")).toBe("issue:middle");
    expect(
      computeDagProjection(graph, defaultDagCollapsedIds(graph)).nodes.map((n) => n.id),
    ).toEqual(["issue:root"]);
    expect(new Set(repsToRevealIssues(graph, defaultDagCollapsedIds(graph), ["leaf"]))).toEqual(
      new Set(["issue:root", "issue:middle"]),
    );
  });
  it("keeps completed tasks in expanded containers with accurate visible progress", () => {
    const graph = makeGraph(
      [
        makeNode("root"),
        makeNode("done", { parentIssueId: "root", status: "done", statusCategory: "done" }),
        makeNode("todo", { parentIssueId: "root" }),
      ],
      [],
    );
    const view = computeDagProjection(graph, []);
    expect(view.groups[0]).toMatchObject({ taskCount: 2, completedCount: 1 });
    expect(view.nodes.some((n) => n.id === "done")).toBe(true);
  });
  it("aggregates running, blocked, unknown and context signals without inventing hidden members", () => {
    const graph = makeGraph(
      [
        makeNode("root", { role: "context" }),
        makeNode("run", {
          parentIssueId: "root",
          runSummary: {
            queued: 1,
            dispatched: 0,
            running: 1,
            waitingLocalDirectory: 0,
            capturedAt: "now",
          },
        }),
        makeNode("blocked", {
          parentIssueId: "root",
          dependencySummary: {
            visibleUnsatisfiedCount: 2,
            hasRestrictedBlockers: true,
            dependencyVersion: "v",
          },
        }),
        makeNode("unknown", { parentIssueId: "root", dependencySummary: null }),
      ],
      [],
    );
    const header = computeDagProjection(graph, ["issue:root"]).nodes[0]!;
    expect(header).toMatchObject({
      runState: "running",
      blockedMemberCount: 1,
      unknownSummaryCount: 1,
      hasRestrictedBlockers: true,
      matchCount: 3,
      contextCount: 1,
      role: "match",
    });
    expect(header.memberIds).toHaveLength(4);
  });
  it("reports queued only when no visible member is running", () => {
    const graph = makeGraph(
      [
        makeNode("root"),
        makeNode("child", {
          parentIssueId: "root",
          runSummary: {
            queued: 0,
            dispatched: 1,
            running: 0,
            waitingLocalDirectory: 0,
            capturedAt: "now",
          },
        }),
      ],
      [],
    );
    expect(computeDagProjection(graph, ["issue:root"]).nodes[0]?.runState).toBe("queued");
  });
  it("does not synthesize a missing or inaccessible parent", () => {
    const view = computeDagProjection(
      makeGraph([makeNode("child", { parentIssueId: "absent", hasRestrictedParent: true })], []),
      [],
    );
    expect(view.nodes.map((n) => n.id)).toEqual(["child"]);
    expect(view.groups).toEqual([]);
  });
  it("terminates display traversal for an inconsistent parent cycle without mutating it", () => {
    const graph = makeGraph(
      [makeNode("a", { parentIssueId: "b" }), makeNode("b", { parentIssueId: "a" })],
      [],
    );
    const before = JSON.stringify(graph),
      view = computeDagProjection(graph, []);
    expect(view.representatives.size).toBe(2);
    expect(JSON.stringify(graph)).toBe(before);
  });
  it("derives collapsed lines from current membership, with no stored synthetic parents", () => {
    const graph = makeGraph([makeNode("root")], []);
    expect(defaultDagCollapsedIds(graph)).toEqual([]);
    expect(computeDagProjection(graph, defaultDagCollapsedIds(graph)).groups.some((g) => g.id === "issue:root")).toBe(false);
  });
  it("lists only task lines, excluding absent and childless issues", () => {
    expect(defaultDagCollapsedIds(fixture()).sort()).toEqual(["issue:one", "issue:two"]);
  });
  it("reveals only ancestor folds, never an unrelated line", () => {
    const graph = fixture();
    expect(repsToRevealIssues(graph, defaultDagCollapsedIds(graph), ["a"])).toEqual(["issue:one"]);
    expect(repsToRevealIssues(graph, [], ["a"])).toEqual([]);
  });
});

describe("dependency focus on task lines", () => {
  function focusFixture() {
    return makeGraph(
      [
        makeNode("root"),
        makeNode("child", { parentIssueId: "root" }),
        makeNode("b"),
        makeNode("c"),
        makeNode("d"),
        makeNode("unrelated"),
      ],
      [
        { id: "rb", source: "root", target: "b" },
        { id: "bc", source: "b", target: "c" },
        { id: "cd", source: "child", target: "d" },
      ],
    );
  }

  it("walks downstream transitively without following parents or unrelated branches", () => {
    const graph = focusFixture(),
      view = computeDagProjection(graph, []);
    expect([...dagFocusNeighborhood(view, graph, "b", "downstream").nodeIds].sort()).toEqual(["b", "c"]);
    expect([...dagFocusNeighborhood(view, graph, "child", "downstream").nodeIds].sort()).toEqual([
      "child",
      "d",
    ]);
  });

  it("includes upstream ancestors but excludes their downstream siblings", () => {
    const graph = focusFixture(),
      view = computeDagProjection(graph, []);
    expect([...dagFocusNeighborhood(view, graph, "d", "upstream").nodeIds].sort()).toEqual([
      "child",
      "d",
      "issue:root",
    ]);
    expect([...dagFocusNeighborhood(view, graph, "b", "upstream").nodeIds].sort()).toEqual([
      "b",
      "issue:root",
    ]);
  });

  it("highlights folded ancestors instead of invisible child ids", () => {
    const graph = focusFixture(),
      view = computeDagProjection(graph, ["issue:root"]);
    expect([...dagFocusNeighborhood(view, graph, "d", "upstream").nodeIds].sort()).toEqual([
      "d",
      "issue:root",
    ]);
  });

  it("seeds every member of a task-line header and follows their transitive outgoing edges", () => {
    const graph = focusFixture(),
      view = computeDagProjection(graph, ["issue:root"]);
    expect([...dagFocusNeighborhood(view, graph, "issue:root", "downstream").nodeIds].sort()).toEqual([
      "b",
      "c",
      "d",
      "issue:root",
    ]);
  });

  it("propagates an inherited wait through expanded descendants to their external dependents", () => {
    const graph = makeGraph(
      [
        makeNode("prerequisite"),
        makeNode("root"),
        makeNode("middle", { parentIssueId: "root" }),
        makeNode("leaf", { parentIssueId: "middle" }),
        makeNode("out"),
        makeNode("unrelated"),
      ],
      [
        { id: "pr", source: "prerequisite", target: "root" },
        { id: "lo", source: "leaf", target: "out" },
      ],
    );
    const view = computeDagProjection(graph, []);
    expect([...dagFocusNeighborhood(view, graph, "prerequisite", "downstream").nodeIds].sort()).toEqual([
      "issue:middle",
      "issue:root",
      "leaf",
      "out",
      "prerequisite",
    ]);
  });

  it.each(["upstream", "downstream"] as const)(
    "terminates %s traversal on repeated dependency arrivals",
    (way) => {
      const graph = makeGraph(
        [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("out")],
        [
          { id: "ab", source: "a", target: "b" },
          { id: "bc", source: "b", target: "c" },
          { id: "ca", source: "c", target: "a" },
        ],
      );
      expect(
        [...dagFocusNeighborhood(computeDagProjection(graph, []), graph, "a", way).nodeIds].sort(),
      ).toEqual(["a", "b", "c"]);
    },
  );

  it("follows raw dependencies before mapping folded representatives", () => {
    const graph = makeGraph(
      [
        makeNode("up"),
        makeNode("root"),
        makeNode("middle", { parentIssueId: "root" }),
        makeNode("leaf", { parentIssueId: "middle", projectId: P2 }),
        makeNode("out"),
      ],
      [
        { id: "ur", source: "up", target: "root" },
        { id: "lo", source: "leaf", target: "out" },
      ],
    );
    const view = computeDagProjection(graph, ["issue:root", "issue:middle"]);
    const seen = dagFocusNeighborhood(view, graph, "up", "downstream").nodeIds;
    expect([...seen]).toEqual(expect.arrayContaining(["up", "issue:root", "out"]));
    expect(seen.has("leaf")).toBe(false);
  });
  it.each(["upstream", "downstream"] as const)(
    "keeps a folded child's %s edge reachable",
    (way) => {
      const graph = makeGraph(
        [makeNode("root"), makeNode("child", { parentIssueId: "root" }), makeNode("outside")],
        [
          way === "upstream"
            ? { id: "e", source: "outside", target: "child" }
            : { id: "e", source: "child", target: "outside" },
        ],
      );
      const view = computeDagProjection(graph, ["issue:root"]);
      expect(dagFocusNeighborhood(view, graph, "issue:root", way).nodeIds.has("outside")).toBe(true);
    },
  );
  it("recursively includes prerequisites of reached ancestors", () => {
    const graph = makeGraph(
      [
        makeNode("child", { parentIssueId: "root" }),
        makeNode("root"),
        makeNode("dependency", { parentIssueId: "dep-parent" }),
        makeNode("dep-parent"),
        makeNode("up"),
      ],
      [
        { id: "dr", source: "dependency", target: "root" },
        { id: "up", source: "up", target: "dep-parent" },
      ],
    );
    const view = computeDagProjection(graph, []);
    expect([...dagFocusNeighborhood(view, graph, "child", "upstream").nodeIds]).toEqual(
      expect.arrayContaining(["child", "issue:root", "dependency", "issue:dep-parent", "up"]),
    );
  });
  it("does not turn parentage alone into a downstream dependency", () => {
    const graph = makeGraph([makeNode("parent"), makeNode("kid", { parentIssueId: "parent" })], []);
    const view = computeDagProjection(graph, []);
    expect([...dagFocusNeighborhood(view, graph, "parent", "downstream").nodeIds]).toEqual([
      dagFeatureRepId("parent"),
    ]);
  });
});

describe("completed visibility", () => {
  const done = (id: string, extra: Partial<Parameters<typeof makeNode>[1]> = {}) =>
    makeNode(id, { status: "done", statusCategory: "done", ...extra });
  const cancelled = (id: string, extra: Partial<Parameters<typeof makeNode>[1]> = {}) =>
    makeNode(id, { status: "cancelled", statusCategory: "closed", ...extra });

  it("hides a fully finished task line as a whole, including nested sub-lines", () => {
    const graph = makeGraph([
      done("root"),
      done("child", { parentIssueId: "root" }),
      cancelled("leaf", { parentIssueId: "child" }),
    ]);
    const view = computeDagProjection(graph, [], false, false);
    expect(view.nodes).toEqual([]);
    expect(view.groups).toEqual([]);
    expect(view.hiddenCompleted).toEqual({ lines: 1, lineTasks: 3, singles: 0 });
    expect(view.representatives.size).toBe(0);
  });

  it("keeps a line whose parent is done but a member is still open", () => {
    const graph = makeGraph([
      done("root"),
      makeNode("child", { parentIssueId: "root" }),
      done("done-sibling", { parentIssueId: "root" }),
    ]);
    const view = computeDagProjection(graph, ["issue:root"], false, false);
    expect(view.nodes.map((n) => n.id)).toEqual(["issue:root"]);
    expect(view.hiddenCompleted).toEqual({ lines: 0, lineTasks: 0, singles: 0 });
    // Expanding the line shows its completed members: they were never hidden.
    const expanded = computeDagProjection(graph, [], false, false);
    expect(expanded.nodes.map((n) => n.id)).toEqual(["issue:root", "child", "done-sibling"]);
  });

  it("hides standalone finished tasks, one by one inside the independent group", () => {
    const graph = makeGraph([
      done("solo-done"),
      makeNode("solo-live"),
      makeNode("solo-live-2"),
    ]);
    const view = computeDagProjection(graph, [], true, false);
    expect(view.hiddenCompleted).toEqual({ lines: 0, lineTasks: 0, singles: 1 });
    const group = view.groups.find((g) => g.independent)!;
    expect(group.memberIds).toEqual(["solo-live", "solo-live-2"]);
    expect(view.nodes.some((n) => n.id === "solo-done")).toBe(false);
    // Everything finished: the empty independent group disappears with them.
    const allDone = computeDagProjection(
      makeGraph([done("a"), cancelled("b")]),
      [],
      true,
      false,
    );
    expect(allDone.nodes).toEqual([]);
    expect(allDone.hiddenCompleted).toEqual({ lines: 0, lineTasks: 0, singles: 2 });
  });

  it("keeps a cancelled prerequisite of visible unfinished work as a marked lone card", () => {
    const graph = makeGraph(
      [cancelled("c"), makeNode("v")],
      [{ id: "cv", source: "c", target: "v" }],
    );
    const view = computeDagProjection(graph, [], false, false);
    const kept = view.nodes.find((n) => n.id === "c");
    expect(kept).toMatchObject({
      kind: "issue",
      groupId: null,
      collapsible: false,
      cancelledBlocking: true,
    });
    expect(view.hiddenCompleted).toEqual({ lines: 0, lineTasks: 0, singles: 0 });
    expect(view.edges.map((e) => e.id)).toEqual(["c→v"]);
  });

  it("pulls a still-blocking cancelled member out of a hidden line as a single card", () => {
    const graph = makeGraph(
      [
        done("root"),
        cancelled("child", { parentIssueId: "root" }),
        done("sibling", { parentIssueId: "root" }),
        makeNode("v"),
      ],
      [{ id: "cv", source: "child", target: "v" }],
    );
    const view = computeDagProjection(graph, ["issue:root"], false, false);
    expect(view.groups).toEqual([]);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["child", "v"]);
    expect(view.nodes.find((n) => n.id === "child")?.cancelledBlocking).toBe(true);
    expect(view.hiddenCompleted).toEqual({ lines: 1, lineTasks: 2, singles: 0 });
    expect(view.edges.map((e) => e.id)).toEqual(["child→v"]);
  });

  it("keeps a cancelled chain upstream through other kept cancelled tasks", () => {
    const graph = makeGraph(
      [cancelled("c1"), cancelled("c2"), makeNode("v")],
      [
        { id: "e1", source: "c1", target: "c2" },
        { id: "e2", source: "c2", target: "v" },
      ],
    );
    const view = computeDagProjection(graph, [], false, false);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["c1", "c2", "v"]);
    expect(view.hiddenCompleted.singles).toBe(0);
  });

  it("does not keep a cancelled task whose downstream is already done", () => {
    const graph = makeGraph(
      [cancelled("c"), done("mid"), makeNode("v")],
      [
        { id: "e1", source: "c", target: "mid" },
        { id: "e2", source: "mid", target: "v" },
      ],
    );
    const view = computeDagProjection(graph, [], false, false);
    // "mid" is done, so it satisfies v; c blocks nothing visible anymore.
    expect(view.nodes.map((n) => n.id)).toEqual(["v"]);
    expect(view.hiddenCompleted).toEqual({ lines: 0, lineTasks: 0, singles: 2 });
  });

  it("drops edges touching hidden nodes and does not count kept cards as hidden", () => {
    const graph = makeGraph(
      [done("h1"), makeNode("v1"), makeNode("v2")],
      [
        { id: "e1", source: "h1", target: "v1" },
        { id: "e2", source: "v1", target: "v2" },
      ],
    );
    const view = computeDagProjection(graph, [], false, false);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["v1", "v2"]);
    expect(view.edges.map((e) => e.id)).toEqual(["v1→v2"]);
  });

  it("counts hidden tasks in the focus neighborhood without revealing them", () => {
    const graph = makeGraph(
      [done("a"), makeNode("b"), makeNode("c", { parentIssueId: "b" })],
      [{ id: "ab", source: "a", target: "b" }],
    );
    const view = computeDagProjection(graph, ["issue:b"], false, false);
    const focus = dagFocusNeighborhood(view, graph, "issue:b", "upstream");
    expect([...focus.nodeIds].sort()).toEqual(["issue:b"]);
    expect(focus.hiddenIssueCount).toBe(1);
    // Nothing hidden once the switch is on.
    const shown = computeDagProjection(graph, ["issue:b"], false, true);
    expect(dagFocusNeighborhood(shown, graph, "issue:b", "upstream").hiddenIssueCount).toBe(0);
  });

  it("keeps everything when showCompleted is on", () => {
    const graph = makeGraph([
      done("root"),
      done("child", { parentIssueId: "root" }),
      cancelled("solo"),
    ]);
    const view = computeDagProjection(graph, ["issue:root"], false, true);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["independent:root", "issue:root"]);
    expect(view.hiddenCompleted).toEqual({ lines: 0, lineTasks: 0, singles: 0 });
    expect(view.nodes.some((n) => n.cancelledBlocking)).toBe(false);
  });

  it("treats an unresolved status category as unfinished and keeps it visible", () => {
    const graph = makeGraph([makeNode("custom", { statusCategory: "custom-stage" })]);
    const view = computeDagProjection(graph, [], true, false);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["custom", "independent:root"]);
    expect(view.hiddenCompleted.singles).toBe(0);
  });
});
