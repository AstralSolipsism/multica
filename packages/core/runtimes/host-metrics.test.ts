// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../types";
import {
  isSystemStatsStale,
  metricsTone,
  parseSystemStats,
  pickMachineSystemStats,
} from "./host-metrics";

function makeRuntime(
  overrides: Partial<AgentRuntime> & { id: string },
): AgentRuntime {
  return {
    workspace_id: "ws-1",
    daemon_id: "daemon-1",
    name: "Claude (host)",
    runtime_mode: "local",
    provider: "claude",
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

describe("parseSystemStats", () => {
  it("parses a well-formed sample", () => {
    expect(
      parseSystemStats({ cpu_percent: 42, memory_percent: 68, captured_at: 1000, stale: true }),
    ).toEqual({ cpu_percent: 42, memory_percent: 68, captured_at: 1000, stale: true });
  });

  it("defaults stale to false for older backends", () => {
    expect(parseSystemStats({ cpu_percent: 42, memory_percent: null, captured_at: 1000 })?.stale).toBe(false);
  });

  it("returns null for missing, malformed, or untimestamped payloads", () => {
    expect(parseSystemStats(null)).toBeNull();
    expect(parseSystemStats(undefined)).toBeNull();
    expect(parseSystemStats("not-a-sample")).toBeNull();
    expect(parseSystemStats({ cpu_percent: "high", captured_at: 1000 })).toBeNull();
    expect(parseSystemStats({ cpu_percent: 42, captured_at: 0 })).toBeNull();
  });
});

describe("pickMachineSystemStats", () => {
  it("picks the freshest sample among online runtimes", () => {
    const stats = pickMachineSystemStats([
      makeRuntime({ id: "rt-old", system_stats: { cpu_percent: 10, memory_percent: 20, captured_at: 900, stale: false } }),
      makeRuntime({ id: "rt-new", system_stats: { cpu_percent: 42, memory_percent: 68, captured_at: 1000, stale: false } }),
    ]);
    expect(stats).toMatchObject({ cpu_percent: 42, captured_at: 1000 });
  });

  it("falls back to offline runtimes when no online runtime carries a sample", () => {
    const stats = pickMachineSystemStats([
      makeRuntime({ id: "rt-online" }),
      makeRuntime({
        id: "rt-offline",
        status: "offline",
        system_stats: { cpu_percent: 7, memory_percent: null, captured_at: 800, stale: true },
      }),
    ]);
    expect(stats).toMatchObject({ cpu_percent: 7, stale: true });
  });

  it("returns null when nothing ever reported, and skips malformed rows", () => {
    expect(pickMachineSystemStats([makeRuntime({ id: "rt-none" })])).toBeNull();
    expect(
      pickMachineSystemStats([
        makeRuntime({ id: "rt-bad", system_stats: "junk" as unknown as AgentRuntime["system_stats"] }),
        makeRuntime({ id: "rt-good", system_stats: { cpu_percent: 1, memory_percent: 2, captured_at: 5, stale: false } }),
      ]),
    ).toMatchObject({ cpu_percent: 1 });
  });
});

describe("metricsTone", () => {
  it("maps usage thresholds", () => {
    expect(metricsTone(null)).toBe("ok");
    expect(metricsTone(0)).toBe("ok");
    expect(metricsTone(79.9)).toBe("ok");
    expect(metricsTone(80)).toBe("warning");
    expect(metricsTone(89.9)).toBe("warning");
    expect(metricsTone(90)).toBe("destructive");
    expect(metricsTone(100)).toBe("destructive");
  });
});

describe("isSystemStatsStale", () => {
  const sample = { cpu_percent: 42, memory_percent: 68, captured_at: 1000, stale: false };

  it("honors the server flag and advances with the clock", () => {
    expect(isSystemStatsStale({ ...sample, stale: true }, 1000_000)).toBe(true);
    // 30s old at the boundary: still fresh.
    expect(isSystemStatsStale(sample, 1000_000 + 30_000)).toBe(false);
    // Past the SLA the open page marks stale without waiting for a refetch.
    expect(isSystemStatsStale(sample, 1000_000 + 30_001)).toBe(true);
  });
});
