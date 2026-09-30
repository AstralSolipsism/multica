// @vitest-environment node
import { describe, expect, it } from "vitest";
import { layoutDagProjection } from "./dag-layout";

describe("layoutDagProjection", () => {
  it("positions every node and runs left-to-right under LR", () => {
    const positions = layoutDagProjection(
      [
        { id: "a", width: 100, height: 40 },
        { id: "b", width: 100, height: 40 },
        { id: "c", width: 100, height: 40 },
      ],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
      "LR",
    );
    expect(Object.keys(positions).sort()).toEqual(["a", "b", "c"]);
    // Ranks advance along x for LR, along y for TB.
    expect(positions.a!.x).toBeLessThan(positions.b!.x);
    expect(positions.b!.x).toBeLessThan(positions.c!.x);
  });

  it("advances ranks along y under TB", () => {
    const positions = layoutDagProjection(
      [
        { id: "a", width: 100, height: 40 },
        { id: "b", width: 100, height: 40 },
      ],
      [{ source: "a", target: "b" }],
      "TB",
    );
    expect(positions.a!.y).toBeLessThan(positions.b!.y);
  });

  it("ignores edges to nodes outside the projection and still places isolates", () => {
    const positions = layoutDagProjection(
      [
        { id: "a", width: 100, height: 40 },
        { id: "lonely", width: 100, height: 40 },
      ],
      [
        { source: "a", target: "missing" },
        { source: "missing", target: "a" },
      ],
      "LR",
    );
    expect(Object.keys(positions).sort()).toEqual(["a", "lonely"]);
    for (const position of Object.values(positions)) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
  });

  it("returns top-left coordinates (Dagre centers shifted by half size)", () => {
    const positions = layoutDagProjection(
      [{ id: "only", width: 200, height: 80 }],
      [],
      "LR",
    );
    expect(positions.only).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  function stagedNode(id: string, parentIssueId: string | null, stage: number | null) {
    return { id, width: 100, height: 40, parentIssueId, stage };
  }

  it.each(["LR", "TB"] as const)("orders stages within a task line under %s without stored edges", (direction) => {
    const nodes = [
      stagedNode("last", "line", 5),
      stagedNode("first-a", "line", 1),
      stagedNode("middle", "line", 3),
      stagedNode("first-b", "line", 1),
    ];
    const positions = layoutDagProjection(nodes, [], direction);
    const axis = direction === "LR" ? "x" : "y";
    const size = direction === "LR" ? 100 : 40;
    expect(positions["first-a"]![axis]).toEqual(positions["first-b"]![axis]);
    expect(positions["first-a"]![axis] + size).toBeLessThan(positions.middle![axis]);
    expect(positions.middle![axis] + size).toBeLessThan(positions.last![axis]);
    expect(Object.keys(positions).sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  it("keeps independent task lines, unparented stages and unstaged tasks parallel", () => {
    const positions = layoutDagProjection([
      stagedNode("line-a", "parent-a", 8),
      stagedNode("line-b", "parent-b", 1),
      stagedNode("root-a", null, 1),
      stagedNode("root-b", null, 9),
      stagedNode("unstaged-a", "line", null),
      stagedNode("unstaged-b", "line", null),
    ], [], "LR");
    expect(new Set(Object.values(positions).map((p) => p.x)).size).toBe(1);
  });

  it("honors transitive dependencies within one stage through unstaged tasks", () => {
    const positions = layoutDagProjection([
      stagedNode("a", "line", 1),
      stagedNode("b", "line", null),
      stagedNode("c", "line", 1),
      stagedNode("later", "line", 2),
    ], [{ source: "a", target: "b" }, { source: "b", target: "c" }], "LR");
    expect(positions.a!.x).toBeLessThan(positions.b!.x);
    expect(positions.b!.x).toBeLessThan(positions.c!.x);
    expect(positions.c!.x).toBeLessThan(positions.later!.x);
  });

  it("gives a conflicting dependency path priority over stage numbers", () => {
    const positions = layoutDagProjection([
      stagedNode("early", "line", 1),
      stagedNode("later", "line", 2),
      stagedNode("outside", "another-line", null),
      stagedNode("final", "line", 3),
    ], [
      { source: "later", target: "outside" },
      { source: "outside", target: "early" },
    ], "LR");
    expect(positions.later!.x).toBeLessThan(positions.outside!.x);
    expect(positions.outside!.x).toBeLessThan(positions.early!.x);
    expect(positions.later!.x).toBeLessThan(positions.final!.x);
  });

  it("does not reverse dependencies when stage constraints across lines would make a cycle", () => {
    const positions = layoutDagProjection([
      stagedNode("a1", "a", 1), stagedNode("a2", "a", 2),
      stagedNode("b1", "b", 1), stagedNode("b2", "b", 2),
    ], [
      { source: "a2", target: "b1" },
      { source: "b2", target: "a1" },
    ], "LR");
    expect(positions.a2!.x).toBeLessThan(positions.b1!.x);
    expect(positions.b2!.x).toBeLessThan(positions.a1!.x);
  });

});
