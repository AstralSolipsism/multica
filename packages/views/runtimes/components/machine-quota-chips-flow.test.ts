// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fitChipCount } from "./machine-quota-chips";

describe("fitChipCount", () => {
  it("keeps everything when it all fits", () => {
    expect(fitChipCount(300, [80, 80, 80], 6, 30)).toBe(3);
  });
  it("drops whole pills (never clips mid-pill) until the rest fits", () => {
    // 2 pills + gaps = 172, + overflow pill 30 = 208 ≤ 224; three would be 256.
    expect(fitChipCount(224, [80, 80, 80], 6, 30)).toBe(2);
  });
  it("charges the overflow pill only when something is hidden", () => {
    // Exactly fits without overflow: 3 pills = 252 ≤ 252.
    expect(fitChipCount(252, [80, 80, 80], 6, 30)).toBe(3);
  });
  it("collapses to the +N pill alone when nothing fits", () => {
    expect(fitChipCount(20, [80, 80], 6, 30)).toBe(0);
  });
  it("handles an empty list", () => {
    expect(fitChipCount(100, [], 6, 30)).toBe(0);
  });
});
