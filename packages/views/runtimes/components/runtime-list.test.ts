import { describe, expect, it } from "vitest";
import type { Agent, AgentRuntime, AgentTask } from "@multica/core/types";
import { buildWorkloadIndex, canReadRuntimeUsage } from "./runtime-list";
import { buildRuntimeQuotaView } from "./runtime-quota-cell";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    runtime_id: "runtime-1",
    name: "Agent",
    description: "",
    instructions: "",
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: {},
    custom_args: [],
    visibility: "private",
    permission_mode: "private",
    invocation_targets: [],
    status: "idle",
    max_concurrent_tasks: 1,
    model: "gpt-5.4",
    owner_id: "user-1",
    skills: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    issue_id: "issue-1",
    status: "running",
    priority: 1,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    runtime_id: "runtime-1",
    attempt: 1,
    ...overrides,
  };
}

describe("buildWorkloadIndex", () => {
  it("excludes archived agents from runtime agent counts and workload", () => {
    const activeAgent = makeAgent({ id: "active-agent" });
    const archivedAgent = makeAgent({
      id: "archived-agent",
      archived_at: "2026-01-02T00:00:00Z",
    });

    const tasks = [
      makeTask({ id: "active-task", agent_id: activeAgent.id, status: "running" }),
      makeTask({ id: "archived-task", agent_id: archivedAgent.id, status: "queued" }),
    ];

    const workload = buildWorkloadIndex([activeAgent, archivedAgent], tasks).get("runtime-1");

    expect(workload).toEqual({
      agentIds: [activeAgent.id],
      runningCount: 1,
      queuedCount: 0,
    });
  });
});

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "runtime-1",
    workspace_id: "ws-1",
    daemon_id: "daemon-1",
    name: "Runtime",
    runtime_mode: "local",
    provider: "codex",
    launch_header: "",
    status: "online",
    device_info: "Mac",
    metadata: {},
    owner_id: "user-2",
    visibility: "private",
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("canReadRuntimeUsage", () => {
  it("does not load usage for an admin viewing another member's private runtime", () => {
    expect(canReadRuntimeUsage(makeRuntime(), "admin-1")).toBe(false);
  });

  it("allows usage for a public teammate runtime", () => {
    expect(
      canReadRuntimeUsage(makeRuntime({ visibility: "public" }), "member-1"),
    ).toBe(true);
  });
});

describe("buildRuntimeQuotaView", () => {
  const NOW_SEC = 1_800_000_000;
  const NOW = NOW_SEC * 1000;

  function makeQuota(
    overrides: Record<string, unknown> = {},
  ): NonNullable<AgentRuntime["plan_quota"]> {
    return {
      provider: "codex",
      status: "ok",
      windows: [
        {
          name: "primary",
          used_percent: 38,
          window_minutes: 300,
          resets_at: NOW_SEC + 3600,
        },
        {
          name: "secondary",
          used_percent: 88,
          window_minutes: 10080,
          resets_at: NOW_SEC + 3 * 24 * 3600,
        },
      ],
      observed_at: NOW_SEC - 120,
      source: "daemon",
      ...overrides,
    } as NonNullable<AgentRuntime["plan_quota"]>;
  }

  it("is not_reported when the snapshot is missing, malformed, or fully expired", () => {
    expect(buildRuntimeQuotaView(makeRuntime(), NOW).kind).toBe("not_reported");
    expect(
      buildRuntimeQuotaView(
        makeRuntime({
          plan_quota: "garbage" as unknown as AgentRuntime["plan_quota"],
        }),
        NOW,
      ).kind,
    ).toBe("not_reported");
    expect(
      buildRuntimeQuotaView(
        makeRuntime({
          plan_quota: makeQuota({
            windows: [
              {
                name: "primary",
                used_percent: 10,
                window_minutes: 300,
                resets_at: NOW_SEC - 5,
              },
            ],
          }),
        }),
        NOW,
      ).kind,
    ).toBe("not_reported");
  });

  it("is stale when the snapshot is older than 24h", () => {
    const view = buildRuntimeQuotaView(
      makeRuntime({ plan_quota: makeQuota({ observed_at: NOW_SEC - 25 * 3600 }) }),
      NOW,
    );
    expect(view).toEqual({ kind: "stale", ageMs: 25 * 3600 * 1000 });
  });

  it("maps each active window to remaining percent, tone, and the soonest reset", () => {
    const view = buildRuntimeQuotaView(
      makeRuntime({ plan_quota: makeQuota() }),
      NOW,
    );
    expect(view).toEqual({
      kind: "ok",
      windows: [
        {
          name: "primary",
          windowMinutes: 300,
          remainingPercent: 62,
          tone: "ok",
          resetInMs: 3600 * 1000,
          group: null,
        },
        {
          name: "secondary",
          windowMinutes: 10080,
          remainingPercent: 12,
          tone: "warning",
          resetInMs: 3 * 24 * 3600 * 1000,
          group: null,
        },
      ],
      resetInMs: 3600 * 1000,
      observedAgeMs: 120 * 1000,
    });
  });

  it("degrades to limited when limited status carries no percentages", () => {
    const view = buildRuntimeQuotaView(
      makeRuntime({
        plan_quota: makeQuota({
          status: "limited",
          windows: [
            {
              name: "primary",
              used_percent: null,
              window_minutes: 300,
              resets_at: NOW_SEC + 110,
            },
          ],
        }),
      }),
      NOW,
    );
    expect(view.kind).toBe("limited");
    expect(view.kind === "limited" && view.resetInMs).toBe(110 * 1000);
  });

  it("keeps the window rows when limited status still carries percentages", () => {
    const view = buildRuntimeQuotaView(
      makeRuntime({ plan_quota: makeQuota({ status: "limited" }) }),
      NOW,
    );
    expect(view.kind).toBe("ok");
    if (view.kind === "ok") {
      expect(view.windows[0]?.tone).toBe("destructive");
    }
  });

  it("exposes every antigravity bucket with its quota group", () => {
    // The probe reports two pools (gemini, claude_gpt) × (5h, weekly). The
    // detail / settings pages must be able to show all four under group
    // labels, and ungrouped providers must still read as one unlabeled list.
    const antigravityQuota = makeQuota({
      provider: "antigravity",
      windows: [
        { name: "gemini_weekly", used_percent: 50, window_minutes: 10080, resets_at: null, group: "gemini" },
        { name: "gemini_5h", used_percent: 75, window_minutes: 300, resets_at: null, group: "gemini" },
        { name: "claude_gpt_weekly", used_percent: 25, window_minutes: 10080, resets_at: null, group: "claude_gpt" },
        { name: "claude_gpt_5h", used_percent: 60, window_minutes: 300, resets_at: null, group: "claude_gpt" },
      ],
    });
    const view = buildRuntimeQuotaView(makeRuntime({ plan_quota: antigravityQuota }), NOW);
    expect(view.kind).toBe("ok");
    if (view.kind === "ok") {
      expect(view.windows).toHaveLength(4);
      expect(view.windows.map((window) => window.group)).toEqual([
        "gemini",
        "gemini",
        "claude_gpt",
        "claude_gpt",
      ]);
    }

    // Ungrouped reporter: the new field stays null instead of inventing a
    // pool, so the cell renders exactly as it did before the field existed.
    const ungrouped = buildRuntimeQuotaView(makeRuntime({ plan_quota: makeQuota() }), NOW);
    if (ungrouped.kind === "ok") {
      expect(ungrouped.windows.every((window) => window.group === null)).toBe(true);
    }
  });
});
