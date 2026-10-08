// @vitest-environment node

import { describe, expect, it } from "vitest";
import { quotaChipState } from "./machine-quota-chips";
import type { MachineQuotaChip } from "./runtime-machines";

function chip(overrides: Partial<MachineQuotaChip> = {}): MachineQuotaChip {
  return {
    key: "rt-1",
    runtimeId: "rt-1",
    provider: "codex",
    group: null,
    remainingPercent: 62,
    limited: false,
    tone: "ok",
    interrupted: false,
    ...overrides,
  };
}

describe("quotaChipState", () => {
  it("pins the precedence shared by visible text and aria-label", () => {
    // A limited runtime can still carry a percentage (codex reports 100%
    // used when limited) — limited must win so screen readers never hear
    // "0% left" under a visible "Rate limited".
    expect(quotaChipState(chip({ limited: true, remainingPercent: 0 }))).toEqual({
      kind: "limited",
    });
    expect(quotaChipState(chip({ limited: true, remainingPercent: null }))).toEqual({
      kind: "limited",
    });
    expect(quotaChipState(chip())).toEqual({ kind: "percent", percent: 62 });
    expect(quotaChipState(chip({ remainingPercent: null }))).toEqual({
      kind: "unknown",
    });
  });

  it("keeps the last balance of an interrupted collection", () => {
    expect(quotaChipState(chip({ interrupted: true }))).toEqual({ kind: "percent", percent: 62 });
    expect(quotaChipState(chip({ interrupted: true, limited: true }))).toEqual({ kind: "limited" });
  });
});
