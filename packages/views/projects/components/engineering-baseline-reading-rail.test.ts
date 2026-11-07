// @vitest-environment node
import { describe, expect, it } from "vitest";
import { layoutBaselineReadingRail } from "./engineering-baseline-reading-rail";

describe("baseline reading rail layout", () => {
  it("aligns cards to their anchors and pushes crowded cards down without overlap", () => {
    const positions = layoutBaselineReadingRail([
      { id: "first", idealTop: 100, height: 80 },
      { id: "second", idealTop: 110, height: 60 },
      { id: "third", idealTop: 170, height: 40 },
      { id: "fourth", idealTop: 400, height: 50 },
    ]);
    expect(positions).toEqual({ first: 100, second: 188, third: 256, fourth: 400 });
    expect(positions.second! - positions.first!).toBeGreaterThanOrEqual(88);
    expect(positions.third! - positions.second!).toBeGreaterThanOrEqual(68);
  });

  it("keeps the original order for equally positioned cards and clamps negative anchors", () => {
    expect(layoutBaselineReadingRail([
      { id: "a", idealTop: -20, height: 20 },
      { id: "b", idealTop: -20, height: 30 },
    ])).toEqual({ a: 0, b: 28 });
  });
});
