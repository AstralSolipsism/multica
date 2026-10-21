// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  TaskMessagePayload,
  TaskMessageThinkingMetadata,
} from "../types/events";
import {
  collectThinkingSamples,
  currentThinkingLevel,
  summarizeThinkingRun,
  thinkingLevelRank,
} from "./thinking-level";

function message(
  seq: number,
  thinking?: TaskMessageThinkingMetadata,
): TaskMessagePayload {
  return {
    task_id: "task",
    issue_id: "issue",
    seq,
    type: "thinking",
    metadata: thinking ? { thinking } : undefined,
  };
}

const adapt = (level: string, step?: number) => ({ level, mode: "adapt" as const, step });
const fixed = (level: string, step?: number) => ({ level, mode: "fixed" as const, step });
const fallback = (
  reason: NonNullable<TaskMessageThinkingMetadata["fallback"]>,
  step?: number,
) => ({
  level: "",
  mode: "adapt" as const,
  fallback: reason,
  step,
});
// Step-level fallback (OL-1000): the decision failed, so the step explicitly
// carried the previous step's level over — `level` stays non-empty.
const stepFallback = (
  level: string,
  reason: NonNullable<TaskMessageThinkingMetadata["fallback"]>,
  step?: number,
) => ({
  level,
  mode: "adapt" as const,
  fallback: reason,
  step,
});

describe("thinkingLevelRank", () => {
  it("orders the known ladder", () => {
    const ladder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    for (let i = 1; i < ladder.length; i++) {
      expect(thinkingLevelRank(ladder[i]!)).toBeGreaterThan(thinkingLevelRank(ladder[i - 1]!)!);
    }
  });

  it("treats custom tokens as unorderable", () => {
    expect(thinkingLevelRank("custom-variant")).toBeUndefined();
    expect(thinkingLevelRank("")).toBeUndefined();
  });
});

describe("collectThinkingSamples", () => {
  it("ignores untagged legacy messages entirely", () => {
    expect(collectThinkingSamples([message(1), message(2)])).toEqual([]);
  });

  it("counts the several tagged messages of one step as that single step", () => {
    const samples = collectThinkingSamples([
      message(1, adapt("high", 1)),
      message(2, adapt("high", 1)),
      message(3, adapt("high", 1)),
      message(4, adapt("xhigh", 2)),
    ]);
    expect(samples.map((s) => s.metadata.level)).toEqual(["high", "xhigh"]);
  });

  it("counts every tag without a step number as one run-level step", () => {
    // A Kimi-style run: five thinking messages, all carrying the same
    // run-level decision — one step, not five.
    const samples = collectThinkingSamples([
      message(1, adapt("high")),
      message(2, adapt("high")),
      message(3, adapt("high")),
      message(4, adapt("high")),
      message(5, adapt("high")),
    ]);
    expect(samples).toHaveLength(1);
  });

  it("orders samples by seq even when the input arrives unsorted", () => {
    const samples = collectThinkingSamples([
      message(3, adapt("xhigh", 2)),
      message(1, adapt("high", 1)),
    ]);
    expect(samples.map((s) => s.seq)).toEqual([1, 3]);
  });
});

describe("currentThinkingLevel", () => {
  it("returns undefined for runs without any tagged message", () => {
    expect(currentThinkingLevel([message(1), message(2)])).toBeUndefined();
  });

  it("picks the latest tagged message regardless of message type", () => {
    const toolCall: TaskMessagePayload = {
      task_id: "task",
      issue_id: "issue",
      seq: 2,
      type: "tool_use",
      tool: "exec_command",
      metadata: { thinking: adapt("xhigh", 2) },
    };
    const result = currentThinkingLevel([message(1, adapt("high", 1)), toolCall]);
    expect(result?.current.metadata.level).toBe("xhigh");
    expect(result?.trend).toBe("up");
  });

  it("reports up, down, and flat against the previous step, not the previous tagged message", () => {
    expect(
      currentThinkingLevel([
        message(1, adapt("low", 1)),
        message(2, adapt("low", 1)),
        message(3, adapt("xhigh", 2)),
      ])?.trend,
    ).toBe("up");
    expect(currentThinkingLevel([message(1, adapt("xhigh", 1)), message(2, adapt("low", 2))])?.trend).toBe("down");
    expect(currentThinkingLevel([message(1, adapt("high", 1)), message(2, adapt("high", 2))])?.trend).toBe("flat");
  });

  it("shows no arrow when either level is unorderable", () => {
    expect(
      currentThinkingLevel([message(1, adapt("custom-variant", 1)), message(2, adapt("high", 2))])?.trend,
    ).toBeUndefined();
    expect(
      currentThinkingLevel([message(1, adapt("high", 1)), message(2, adapt("custom-variant", 2))])?.trend,
    ).toBeUndefined();
  });

  it("shows no arrow when the previous step fell back without a level", () => {
    const result = currentThinkingLevel([message(1, fallback("timeout", 1)), message(2, adapt("high", 2))]);
    expect(result?.trend).toBeUndefined();
  });

  it("never shows an arrow for fixed levels", () => {
    const result = currentThinkingLevel([message(1, fixed("low", 1)), message(2, fixed("xhigh", 2))]);
    expect(result?.current.metadata.mode).toBe("fixed");
    expect(result?.trend).toBeUndefined();
  });

  it("exposes a run-level fallback (empty level) as the current state", () => {
    const result = currentThinkingLevel([message(1, adapt("high", 1)), message(2, fallback("breaker", 2))]);
    expect(result?.current.metadata.level).toBe("");
    expect(result?.current.metadata.fallback).toBe("breaker");
    expect(result?.trend).toBeUndefined();
  });

  it("shows a step-level fallback's carried level without an arrow", () => {
    const result = currentThinkingLevel([
      message(1, adapt("xhigh", 1)),
      message(2, stepFallback("xhigh", "timeout", 2)),
    ]);
    expect(result?.current.metadata.level).toBe("xhigh");
    expect(result?.current.metadata.fallback).toBe("timeout");
    expect(result?.trend).toBeUndefined();
  });

  it("compares against a step-level fallback's carried level on the next decided step", () => {
    const result = currentThinkingLevel([
      message(1, adapt("high", 1)),
      message(2, stepFallback("high", "timeout", 2)),
      message(3, adapt("xhigh", 3)),
    ]);
    expect(result?.trend).toBe("up");
  });
});

describe("summarizeThinkingRun", () => {
  it("returns undefined for runs without any tagged message", () => {
    expect(summarizeThinkingRun([message(1), message(2)])).toBeUndefined();
  });

  it("summarizes an adaptive run: per-step sequence, step count, peak, fallbacks", () => {
    const summary = summarizeThinkingRun([
      message(1, adapt("low", 1)),
      message(2, adapt("low", 1)),
      message(3, adapt("xhigh", 2)),
      message(4, fallback("timeout", 3)),
      message(5, fallback("no_candidates", 4)),
      message(6, adapt("high", 5)),
    ]);
    expect(summary?.mode).toBe("adapt");
    expect(summary?.samples.map((s) => s.metadata.level)).toEqual(["low", "xhigh", "", "", "high"]);
    expect(summary?.steps).toBe(5);
    expect(summary?.fallbacks).toBe(2);
    expect(summary?.peak).toBe("xhigh");
  });

  it("counts a run with five same-tag thinking messages as one step", () => {
    const summary = summarizeThinkingRun([
      message(1, adapt("high")),
      message(2, adapt("high")),
      message(3, adapt("high")),
      message(4, adapt("high")),
      message(5, adapt("high")),
    ]);
    expect(summary?.steps).toBe(1);
    expect(summary?.fallbacks).toBe(0);
  });

  it("counts step-level fallbacks among the fallback steps", () => {
    const summary = summarizeThinkingRun([
      message(1, adapt("high", 1)),
      message(2, stepFallback("high", "timeout", 2)),
      message(3, adapt("xhigh", 3)),
    ]);
    expect(summary?.steps).toBe(3);
    expect(summary?.fallbacks).toBe(1);
    expect(summary?.peak).toBe("xhigh");
  });

  it("summarizes a fixed run", () => {
    const summary = summarizeThinkingRun([message(1, fixed("ultra", 1)), message(2, fixed("ultra", 1))]);
    expect(summary?.mode).toBe("fixed");
    expect(summary?.steps).toBe(1);
    expect(summary?.fallbacks).toBe(0);
    expect(summary?.peak).toBe("ultra");
  });

  it("leaves the peak undefined when every level is a custom token", () => {
    const summary = summarizeThinkingRun([message(1, adapt("custom-variant", 1))]);
    expect(summary?.peak).toBeUndefined();
    expect(summary?.steps).toBe(1);
  });
});
