// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  glmFormatResetIn,
  glmWindowRemainingPercent,
  glmWorstFirst,
  type GlmQuotaWindow,
} from "./glm-quota-card";

describe("glmWindowRemainingPercent", () => {
  it("derives remaining from the provider's used percentage", () => {
    const w: GlmQuotaWindow = { type: "TIME_LIMIT", used_percent: 16 };
    expect(glmWindowRemainingPercent(w)).toBe(84);
  });
  it("computes from remaining/usage when percentage is absent (credit pools)", () => {
    const w: GlmQuotaWindow = { type: "CREDIT_LIMIT", usage: 500, remaining: 420 };
    expect(glmWindowRemainingPercent(w)).toBe(84);
  });
  it("returns null when nothing is derivable", () => {
    expect(glmWindowRemainingPercent({ type: "TOKENS_LIMIT" })).toBeNull();
  });
  it("never reports below zero or above one hundred", () => {
    expect(glmWindowRemainingPercent({ type: "X", used_percent: 140 })).toBe(0);
    expect(glmWindowRemainingPercent({ type: "X", usage: 10, remaining: 99 })).toBe(100);
  });
});

describe("glmWorstFirst", () => {
  it("leads with the lowest remaining percent; underivable sorts last", () => {
    const windows: GlmQuotaWindow[] = [
      { type: "A", used_percent: 10 },
      { type: "B", used_percent: 90 },
      { type: "C" },
    ];
    expect(glmWorstFirst(windows).map((w) => w.type)).toEqual(["B", "A", "C"]);
  });
});

describe("glmFormatResetIn", () => {
  it("formats minutes, hours and days compactly", () => {
    expect(glmFormatResetIn(45 * 60)).toBe("45m");
    expect(glmFormatResetIn(3600)).toBe("1h");
    expect(glmFormatResetIn(5040)).toBe("1h24m");
    expect(glmFormatResetIn(3 * 86400)).toBe("3d");
  });
});
