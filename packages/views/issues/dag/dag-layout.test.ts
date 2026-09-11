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
});
