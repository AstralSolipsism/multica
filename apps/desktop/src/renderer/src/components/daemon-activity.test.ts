// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentRuntime, AgentTask } from "@multica/core/types";

import { selectLocalDaemonActivity } from "./daemon-activity";

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "rt-1",
    workspace_id: "ws-1",
    daemon_id: "d1",
    name: "Codex (host)",
    runtime_mode: "local",
    provider: "codex",
    launch_header: "",
    status: "online",
    device_info: "",
    metadata: {},
    owner_id: null,
    visibility: "private",
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "rt-1",
    issue_id: "",
    status: "queued",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("selectLocalDaemonActivity", () => {
  it("reports nothing when the daemon id is unknown (stopped daemon)", () => {
    const result = selectLocalDaemonActivity(
      [makeRuntime()],
      [makeTask({ status: "running" })],
      undefined,
    );
    expect(result).toEqual({ runtimeCount: 0, affectedTasks: [] });
  });

  it("counts only runtimes owned by this daemon", () => {
    const result = selectLocalDaemonActivity(
      [makeRuntime(), makeRuntime({ id: "rt-2", daemon_id: "other-daemon" })],
      [],
      "d1",
    );
    expect(result.runtimeCount).toBe(1);
  });

  it("flags running and dispatched tasks on this daemon's runtimes as affected", () => {
    const local = makeRuntime({ id: "rt-local", daemon_id: "d1" });
    const tasks = [
      makeTask({ id: "t-running", runtime_id: "rt-local", status: "running" }),
      makeTask({
        id: "t-dispatched",
        runtime_id: "rt-local",
        status: "dispatched",
      }),
      // Queued work is still server-side — a restart does not interrupt it.
      makeTask({ id: "t-queued", runtime_id: "rt-local", status: "queued" }),
      makeTask({
        id: "t-terminal",
        runtime_id: "rt-local",
        status: "completed",
      }),
      // A running task on ANOTHER machine's runtime must not be flagged.
      makeTask({ id: "t-remote", runtime_id: "rt-remote", status: "running" }),
    ];
    const result = selectLocalDaemonActivity(
      [local, makeRuntime({ id: "rt-remote", daemon_id: "d2" })],
      tasks,
      "d1",
    );
    expect(result.affectedTasks.map((t) => t.id)).toEqual([
      "t-running",
      "t-dispatched",
    ]);
  });
});
