// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import { TaskMessageListSchema } from "./schemas";
import type { TaskMessagePayload } from "../types/events";

const row = { task_id: "task", issue_id: "issue", seq: 1, type: "thinking", content: "planning" };
const thinking = {
  level: "ultra", mode: "adapt", step: 2, source: "opencode-free",
  confidence: 0.88, probabilities: { low: 0.12, ultra: 0.88 }, latency_ms: 284,
  future: { extra: true },
};
const parse = (metadata: unknown) => parseWithFallback<TaskMessagePayload[]>(
  [{ ...row, metadata }, { ...row, seq: 2 }],
  TaskMessageListSchema, [], { endpoint: "GET /api/tasks/:id/messages" },
);

describe("task message metadata", () => {
  it("preserves valid decisions and unknown fields", () => {
    const metadata = { thinking, future: ["opaque"] };
    expect(parse(metadata)[0]?.metadata).toEqual(metadata);
    expect(parse({ thinking: { level: "custom-variant", mode: "fixed" } })[0]?.metadata?.thinking?.level).toBe("custom-variant");
  });

  it.each([undefined, null, [], "bad", 42, false])("degrades invalid metadata %j without losing the transcript", (value) => {
    const result = parse(value);
    expect(result).toHaveLength(2);
    expect(result[0]?.content).toBe("planning");
    expect(result[0]?.metadata).toBeUndefined();
    expect(result[1]?.metadata).toBeUndefined();
  });

  it.each([null, [], "bad", {}, { mode: "adapt" }, { level: 42, mode: "fixed" }, { level: "high", mode: "future" }])(
    "degrades invalid thinking %j while retaining other metadata", (value) => {
      const result = parse({ thinking: value, future: true });
      expect(result).toHaveLength(2);
      expect(result[0]?.metadata?.thinking).toBeUndefined();
      expect(result[0]?.metadata?.future).toBe(true);
    },
  );

  it.each([
    ["step", -1], ["step", 1.5], ["source", {}],
    ["confidence", 1.1], ["confidence", -0.1], ["confidence", "0.9"],
    ["probabilities", { low: 2 }], ["probabilities", []],
    ["latency_ms", -1], ["latency_ms", Infinity], ["fallback", "unknown"],
  ])("drops malformed optional %s without losing the decision", (field, value) => {
    const parsed = parse({ thinking: { ...thinking, [field as string]: value } })[0]?.metadata?.thinking;
    expect(parsed?.level).toBe("ultra");
    expect(parsed?.[field as string]).toBeUndefined();
    expect(parsed?.future).toEqual({ extra: true });
  });

  it.each(["timeout", "error", "invalid", "breaker", "disabled", "no_candidates"])("accepts fallback %s with an empty level", (fallback) => {
    const value = { level: "", mode: "adapt", fallback };
    expect(parse({ thinking: value })[0]?.metadata?.thinking).toEqual(value);
  });

  it("accepts empty metadata and missing thinking", () => {
    expect(parse({})[0]?.metadata).toEqual({});
  });
});
