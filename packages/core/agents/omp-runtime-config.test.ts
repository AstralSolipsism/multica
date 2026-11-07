// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ompRuntimeConfigEquals,
  parseOmpRuntimeConfig,
  serializeOmpRuntimeConfig,
  stripOmpRuntimeConfig,
} from "./omp-runtime-config";

describe("parseOmpRuntimeConfig", () => {
  it("parses a full wire payload", () => {
    expect(
      parseOmpRuntimeConfig({
        smol_model: "zai/glm-5.3-flash",
        slow_model: "openai-codex/gpt-6-astra",
        plan_model: "openai-codex/gpt-6.1-sol",
        handoff_model: "zai/glm-5.3",
        advisor_enabled: true,
        advisor_review_mode: "agent-end",
        execution_mode: "plan_yolo",
        memory_backend: "mnemopi",
        autolearn_enabled: true,
      }),
    ).toEqual({
      smolModel: "zai/glm-5.3-flash",
      slowModel: "openai-codex/gpt-6-astra",
      planModel: "openai-codex/gpt-6.1-sol",
      handoffModel: "zai/glm-5.3",
      advisorEnabled: true,
      advisorReviewMode: "agent-end",
      executionMode: "plan_yolo",
      memoryBackend: "mnemopi",
      autolearnEnabled: true,
    });
  });

  it("collapses malformed payloads to defaults", () => {
    expect(parseOmpRuntimeConfig(null)).toEqual({});
    expect(parseOmpRuntimeConfig([])).toEqual({});
    expect(parseOmpRuntimeConfig("omp")).toEqual({});
    expect(parseOmpRuntimeConfig({ smol_model: 7, slow_model: "   " })).toEqual({});
    expect(parseOmpRuntimeConfig({ advisor_review_mode: "per-step" })).toEqual({});
    expect(parseOmpRuntimeConfig({ execution_mode: "yolo" })).toEqual({});
  });

  it("normalizes standard execution mode away", () => {
    expect(parseOmpRuntimeConfig({ execution_mode: "standard" })).toEqual({});
  });

  it("normalizes the off memory backend away and rejects unknown values", () => {
    expect(parseOmpRuntimeConfig({ memory_backend: "off" })).toEqual({});
    expect(parseOmpRuntimeConfig({ memory_backend: "sqlite" })).toEqual({});
    expect(parseOmpRuntimeConfig({ memory_backend: "sharpshooter" })).toEqual({
      memoryBackend: "sharpshooter",
    });
    expect(parseOmpRuntimeConfig({ autolearn_enabled: false })).toEqual({});
  });

  it("keeps an explicitly disabled advisor out of the parsed state", () => {
    expect(
      parseOmpRuntimeConfig({ advisor_enabled: false, execution_mode: "prewalk" }),
    ).toEqual({ executionMode: "prewalk" });
  });

  it("round-trips through serialize", () => {
    const original = {
      smol_model: "zai/glm-5.3-flash",
      advisor_enabled: true,
      advisor_review_mode: "turn",
      execution_mode: "prewalk",
      handoff_model: "zai/glm-5.3",
      memory_backend: "mnemopi",
      autolearn_enabled: true,
    };
    expect(
      serializeOmpRuntimeConfig(parseOmpRuntimeConfig(original)),
    ).toEqual(original);
    // Defaults serialize to an empty payload.
    expect(serializeOmpRuntimeConfig({})).toEqual({});
    expect(
      serializeOmpRuntimeConfig({ memoryBackend: "off", autolearnEnabled: false }),
    ).toEqual({});
  });
});

describe("ompRuntimeConfigEquals", () => {
  it("treats absent and empty fields as equal", () => {
    expect(ompRuntimeConfigEquals({}, { smolModel: undefined })).toBe(true);
    expect(ompRuntimeConfigEquals({ advisorEnabled: false }, {})).toBe(true);
  });

  it("detects real differences", () => {
    expect(
      ompRuntimeConfigEquals(
        { advisorEnabled: true, advisorReviewMode: "turn" },
        { advisorEnabled: true, advisorReviewMode: "agent-end" },
      ),
    ).toBe(false);
    expect(
      ompRuntimeConfigEquals({ executionMode: "standard" }, { executionMode: "prewalk" }),
    ).toBe(false);
    expect(
      ompRuntimeConfigEquals({ memoryBackend: "off" }, { memoryBackend: "mnemopi" }),
    ).toBe(false);
    expect(
      ompRuntimeConfigEquals({ autolearnEnabled: true }, { autolearnEnabled: false }),
    ).toBe(false);
  });
});

describe("stripOmpRuntimeConfig", () => {
  it("removes only the OMP keys and preserves the rest", () => {
    expect(
      stripOmpRuntimeConfig({
        qoder_agent_id: "agent_1",
        smol_model: "zai/glm-5.3-flash",
        advisor_enabled: true,
        memory_backend: "mnemopi",
        autolearn_enabled: true,
        mode: "gateway",
      }),
    ).toEqual({ qoder_agent_id: "agent_1", mode: "gateway" });
  });

  it("handles null and already-clean configs", () => {
    expect(stripOmpRuntimeConfig(null)).toEqual({});
    expect(stripOmpRuntimeConfig({ mode: "local" })).toEqual({ mode: "local" });
  });
});
