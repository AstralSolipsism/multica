// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RuntimeModelThinkingLevel } from "../types";
import {
  adaptThinkingCandidates,
  hasAdaptThinkingCandidates,
  runtimeSupportsThinkingAdapt,
} from "./thinking-adapt";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../server/pkg/agent/testdata/adapt_thinking_candidates.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Array<{
  name: string;
  levels: RuntimeModelThinkingLevel[] | null;
  candidates: RuntimeModelThinkingLevel[];
  supported: boolean;
}>;

describe("adaptThinkingCandidates", () => {
  it.each(vectors)("$name", ({ levels, candidates, supported }) => {
    expect(adaptThinkingCandidates(levels)).toEqual(candidates);
    expect(hasAdaptThinkingCandidates(levels)).toBe(supported);
  });
});

describe("runtimeSupportsThinkingAdapt", () => {
  it("requires the advertised capability", () => {
    expect(
      runtimeSupportsThinkingAdapt({
        metadata: { capabilities: ["thinking-adapt-v1"] },
      }),
    ).toBe(true);
    expect(
      runtimeSupportsThinkingAdapt({ metadata: { capabilities: [] } }),
    ).toBe(false);
    expect(runtimeSupportsThinkingAdapt({ metadata: {} })).toBe(false);
    expect(runtimeSupportsThinkingAdapt(null)).toBe(false);
  });
});
