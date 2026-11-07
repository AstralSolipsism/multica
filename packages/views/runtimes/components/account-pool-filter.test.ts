// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent } from "@multica/core/types";
import { partitionAccountPools } from "./account-pool-filter";
import type { QuotaAccountPoolState } from "@multica/core/runtimes";

const pool = (id: string): QuotaAccountPoolState =>
  ({
    id,
    availableAccounts: 1,
    totalAccounts: 1,
    disabledAccounts: 0,
    exhausted: false,
    resumesAt: null,
    tone: "ok",
    windows: [],
    accounts: [],
  }) as unknown as QuotaAccountPoolState;

const ompAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    id: "agent-1",
    workspace_id: "workspace-1",
    runtime_id: "runtime-omp",
    runtime_config: {},
    custom_args: [],
    model: "",
    archived_at: null,
    ...overrides,
  }) as Agent;

describe("partitionAccountPools", () => {
  it("includes enabled OMP role providers in the serving pools", () => {
    const partition = partitionAccountPools(
      [pool("zai"), pool("openai-codex")],
      [
        ompAgent({
          model: "zai/glm-5.3",
          runtime_config: {
            smol_model: "zai/glm-5.3-flash",
            advisor_enabled: true,
            slow_model: "openai-codex/gpt-6-astra",
          },
        }),
      ],
      "runtime-omp",
    );

    expect(partition.filtered).toBe(true);
    expect(partition.serving.map((p) => p.id)).toEqual(["zai", "openai-codex"]);
    expect(partition.idle).toEqual([]);
  });

  it("keeps a role's provider in idle when its toggle is off", () => {
    const partition = partitionAccountPools(
      [pool("zai"), pool("openai-codex")],
      [
        ompAgent({
          model: "zai/glm-5.3",
          runtime_config: {
            slow_model: "openai-codex/gpt-6-astra",
            execution_mode: "standard",
            plan_model: "anthropic/claude-opus-4.7",
            handoff_model: "kimi-code/k2.5",
          },
        }),
      ],
      "runtime-omp",
    );

    // Advisor off and standard mode: slow/plan/handoff are not serving.
    expect(partition.serving.map((p) => p.id)).toEqual(["zai"]);
    expect(partition.idle.map((p) => p.id)).toEqual(["openai-codex"]);
  });

  it("falls back to the full list when no provider matches", () => {
    const pools = [pool("zai")];
    const partition = partitionAccountPools(pools, [], "runtime-omp");
    expect(partition).toEqual({
      all: pools,
      serving: pools,
      idle: [],
      filtered: false,
    });
  });
});
