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

  it("collapses the messages of one step into a single sample", () => {
    const samples = collectThinkingSamples([
      message(1, adapt("high", 1)),
      message(2, adapt("high", 1)),
      message(3, adapt("xhigh", 2)),
    ]);
    expect(samples.map((s) => s.metadata.level)).toEqual(["high", "xhigh"]);
  });

  it("orders samples by seq even when the input arrives unsorted", () => {
    const samples = collectThinkingSamples([
      message(3, adapt("xhigh", 2)),
      message(1, adapt("high", 1)),
    ]);
    expect(samples.map((s) => s.seq)).toEqual([1, 3]);
  });

  it("keeps consecutive same-content samples without step numbers separate from changed ones", () => {
    const samples = collectThinkingSamples([
      message(1, adapt("high")),
      message(2, adapt("high")),
      message(3, adapt("low")),
    ]);
    expect(samples.map((s) => s.metadata.level)).toEqual(["high", "low"]);
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

  it("reports up, down, and flat against the previous step", () => {
    expect(currentThinkingLevel([message(1, adapt("low", 1)), message(2, adapt("xhigh", 2))])?.trend).toBe("up");
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

  it("shows no arrow when the previous step fell back", () => {
    const result = currentThinkingLevel([message(1, fallback("timeout", 1)), message(2, adapt("high", 2))]);
    expect(result?.trend).toBeUndefined();
  });

  it("never shows an arrow for fixed levels", () => {
    const result = currentThinkingLevel([message(1, fixed("low", 1)), message(2, fixed("xhigh", 2))]);
    expect(result?.current.metadata.mode).toBe("fixed");
    expect(result?.trend).toBeUndefined();
  });

  it("exposes the fallback step itself as the current state", () => {
    const result = currentThinkingLevel([message(1, adapt("high", 1)), message(2, fallback("breaker", 2))]);
    expect(result?.current.metadata.level).toBe("");
    expect(result?.current.metadata.fallback).toBe("breaker");
    expect(result?.trend).toBeUndefined();
  });
});

describe("summarizeThinkingRun", () => {
  it("returns undefined for runs without any tagged message", () => {
    expect(summarizeThinkingRun([message(1), message(2)])).toBeUndefined();
  });

  it("summarizes an adaptive run: sequence, decisions, peak, fallbacks", () => {
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
    expect(summary?.decisions).toBe(3);
    expect(summary?.fallbacks).toBe(2);
    expect(summary?.peak).toBe("xhigh");
  });

  it("summarizes a fixed run without counting decisions", () => {
    const summary = summarizeThinkingRun([message(1, fixed("ultra", 1)), message(2, fixed("ultra", 1))]);
    expect(summary?.mode).toBe("fixed");
    expect(summary?.decisions).toBe(0);
    expect(summary?.fallbacks).toBe(0);
    expect(summary?.peak).toBe("ultra");
  });

  it("leaves the peak undefined when every level is a custom token", () => {
    const summary = summarizeThinkingRun([message(1, adapt("custom-variant", 1))]);
    expect(summary?.peak).toBeUndefined();
    expect(summary?.decisions).toBe(1);
  });
});
