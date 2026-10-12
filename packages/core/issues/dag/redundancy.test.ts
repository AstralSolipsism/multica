// @vitest-environment node
import { describe, expect, it } from "vitest";
import { graphNode as n, issueGraph as g } from "./test-fixtures";
import { createDagModelIndex } from "./model-index";
import { computeDagLine, computeDagFocus } from "./detail";

describe("redundancy", () => {
  it("finds eight redundant dependencies and preserves the two whose intermediates have ended (OL-155 shape)", () => {
    const nodes = [n("root"), n("source", { parentIssueId: "root" })];
    const edges: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      nodes.push(n(`mid${i}`, { parentIssueId: "root", ...(i < 2 ? { status: "done", statusCategory: "done" } : {}) }));
      nodes.push(n(`end${i}`, { parentIssueId: "root" }));
      edges.push(["source", `mid${i}`], [`mid${i}`, `end${i}`], ["source", `end${i}`]);
    }
    const index = createDagModelIndex(g(nodes, edges)), line = computeDagLine(index, "root")!;
    expect(line.dependencies.filter((e) => e.redundant)).toHaveLength(8);
    expect(line.dependencies.filter((e) => e.retained).map((e) => e.id)).toEqual(["source-end0", "source-end1"]);
    expect(line.dependencies.filter((e) => e.hiddenByDefault)).toHaveLength(6);
    expect(computeDagFocus(index, "source").dependencies.every((e) => !e.hiddenByDefault)).toBe(true);
  });

  it("hides an inherited dependency even through a done parent with unfinished children", () => {
    const graph = g([n("root"), n("source", { parentIssueId: "root" }), n("sub", { parentIssueId: "root", status: "done", statusCategory: "done" }), n("child", { parentIssueId: "sub" })], [["source", "sub"], ["source", "child"]]);
    const line = computeDagLine(createDagModelIndex(graph), "root")!;
    expect(line.dependencies.find((edge) => edge.target === "sub")).toMatchObject({ state: "blocking", targetKind: "frame", redundant: false });
    expect(line.dependencies.find((edge) => edge.target === "child")).toMatchObject({ redundant: true, retained: false, hiddenByDefault: true });
  });

  it("requires every alternate path to contain a finished intermediate before retaining", () => {
    const graph = g([n("root"), ...["s", "done", "live", "t"].map((id) => n(id, { parentIssueId: "root", ...(id === "done" ? { status: "done", statusCategory: "done" } : {}) }))], [["s", "done"], ["done", "t"], ["s", "live"], ["live", "t"], ["s", "t"]]);
    const dependency = computeDagLine(createDagModelIndex(graph), "root")!.dependencies.find((edge) => edge.id === "s-t");
    expect(dependency).toMatchObject({ redundant: true, retained: false });
  });

  it("finds alternatives longer than two hops with bounded BFS", () => {
    const graph = g([
      n("root"), ...["s", "a", "b", "t"].map((id) => n(id, { parentIssueId: "root" })),
    ], [["s", "a"], ["a", "b"], ["b", "t"], ["s", "t"]]);
    const line = computeDagLine(createDagModelIndex(graph), "root")!;
    expect(line.dependencies.find((edge) => edge.id === "s-t")).toMatchObject({
      redundant: true, retained: false, hiddenByDefault: true,
    });
  });

  it("never retains a satisfied redundant dependency even when every alternative crosses a done task", () => {
    const graph = g([
      n("root"), n("s", { parentIssueId: "root", status: "done", statusCategory: "done" }),
      n("mid", { parentIssueId: "root", status: "done", statusCategory: "done" }),
      n("t", { parentIssueId: "root" }),
    ], [["s", "mid"], ["mid", "t"], ["s", "t"]]);
    const line = computeDagLine(createDagModelIndex(graph), "root")!;
    expect(line.dependencies.find((edge) => edge.id === "s-t")).toMatchObject({
      state: "satisfied", redundant: true, retained: false, hiddenByDefault: true,
    });
  });

  it("does not invent a dependency on the parent's status", () => {
    const graph = g([n("root"), n("parent", { parentIssueId: "root" }), n("child", { parentIssueId: "parent" }), n("target", { parentIssueId: "root" })], [["parent", "target"], ["child", "target"]]);
    expect(computeDagLine(createDagModelIndex(graph), "root")!.dependencies.every((edge) => !edge.redundant)).toBe(true);
  });

  it("does not use an open descendant to make a done parent's outgoing dependency still block", () => {
    const graph = g([n("root"), n("s", { parentIssueId: "root" }), n("p", { parentIssueId: "root", status: "done", statusCategory: "done" }), n("child", { parentIssueId: "p" }), n("t", { parentIssueId: "root" })], [["s", "p"], ["p", "t"], ["s", "t"], ["s", "child"]]);
    const edges = computeDagLine(createDagModelIndex(graph), "root")!.dependencies;
    expect(edges.find((edge) => edge.id === "s-t")).toMatchObject({ redundant: true, retained: true, hiddenByDefault: false });
    expect(edges.find((edge) => edge.id === "s-child")).toMatchObject({ redundant: true, retained: false, hiddenByDefault: true });
  });

  it("handles cyclic dependencies without walking through the tested source again", () => {
    const graph = g([n("root"), ...["s", "a", "t"].map((id) => n(id, { parentIssueId: "root" }))], [["s", "a"], ["a", "s"], ["s", "t"]]);
    expect(computeDagLine(createDagModelIndex(graph), "root")!.dependencies.find((edge) => edge.id === "s-t")?.redundant).toBe(false);
  });

  it("never disconnects a cyclic read by hiding mutually justifying alternatives", () => {
    const graph = g([n("root"), ...["s", "a", "b"].map((id) => n(id, { parentIssueId: "root" }))], [["s", "a"], ["s", "b"], ["a", "b"], ["b", "a"]]);
    expect(computeDagLine(createDagModelIndex(graph), "root")!.dependencies.every((edge) => !edge.hiddenByDefault)).toBe(true);
  });

  it("keeps even an otherwise redundant edge when another part of the line contains a cycle", () => {
    const nodes = [n("root"), ...["s", "a", "t", "x", "y"].map((id) => n(id, { parentIssueId: "root" }))];
    const edges: [string, string][] = [["s", "a"], ["a", "t"], ["s", "t"]];
    const acyclic = computeDagLine(createDagModelIndex(g(nodes, edges)), "root")!;
    expect(acyclic.dependencies.find((edge) => edge.id === "s-t")?.redundant).toBe(true);

    const cyclic = computeDagLine(createDagModelIndex(g(nodes, [...edges, ["x", "y"], ["y", "x"]])), "root")!;
    expect(cyclic.dependencies).toHaveLength(5);
    for (const edge of cyclic.dependencies) {
      expect(edge).toMatchObject({ redundant: false, retained: false, hiddenByDefault: false });
    }
  });

  it("does not invent a dependency on the parent's status when using bitset reachability", () => {
    const nodes = [
      n("root"), n("s", { parentIssueId: "root" }), n("t", { parentIssueId: "root" }),
      n("parent", { parentIssueId: "root" }), n("child", { parentIssueId: "parent" }),
    ];
    const edges: [string, string][] = [["s", "t"], ["parent", "t"], ["child", "t"]];
    // The many long alternatives select the bitset path instead of bounded BFS.
    for (let i = 0; i < 100; i++) {
      nodes.push(n(`mid${i}`, { parentIssueId: "root", status: "done", statusCategory: "done" }));
      edges.push(["s", `mid${i}`], [`mid${i}`, i === 99 ? "t" : `mid${i + 1}`]);
    }
    const line = computeDagLine(createDagModelIndex(g(nodes, edges)), "root")!;
    expect(line.dependencies.find((edge) => edge.id === "s-t")).toMatchObject({ redundant: true, retained: true });
    expect(line.dependencies.find((edge) => edge.id === "parent-t")).toMatchObject({
      redundant: false, retained: false, hiddenByDefault: false,
    });
  });

  it("handles many long alternatives and retains a wait only until one entire path is live", () => {
    const nodes = [n("root"), n("s", { parentIssueId: "root" }), n("t", { parentIssueId: "root" })];
    const edges: [string, string][] = [["s", "t"]];
    for (let i = 0; i < 100; i++) {
      nodes.push(n(`mid${i}`, { parentIssueId: "root", status: "done", statusCategory: "done" }));
      edges.push(["s", `mid${i}`], [`mid${i}`, i === 99 ? "t" : `mid${i + 1}`]);
    }
    const graph = g(nodes.reverse(), edges);
    const target = (input: typeof graph) => computeDagLine(createDagModelIndex(input), "root")!.dependencies.find((edge) => edge.id === "s-t");
    expect(target(graph)).toMatchObject({ redundant: true, retained: true });
    expect(target({ ...graph, nodes: graph.nodes.map((node) => node.id === "mid99" ? { ...node, status: "todo", statusCategory: "unstarted" } : node) })).toMatchObject({ redundant: true, retained: false });
  });
});
