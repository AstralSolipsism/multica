// @vitest-environment node

import { describe, expect, it } from "vitest";
import { runtimeKeys, runtimeListOptions } from "./queries";
import {
  runtimeHostMetricsListOptions,
  runtimeHostMetricsRefetchInterval,
  SYSTEM_STATS_RECOVERY_MS,
  SYSTEM_STATS_REFRESH_MS,
} from "./host-metrics";

describe("runtimeListOptions", () => {
  it("does not poll: the shell observes the list on every page", () => {
    const options = runtimeListOptions("ws-1");
    expect(options.queryKey).toEqual(runtimeKeys.list("ws-1"));
    expect(options.refetchInterval).toBeUndefined();
    expect(runtimeListOptions("ws-1", "me").refetchInterval).toBeUndefined();
  });
});

describe("runtimeHostMetricsListOptions", () => {
  it("shares the list cache and adds the host-metrics poll", () => {
    const options = runtimeHostMetricsListOptions("ws-1");
    expect(options.queryKey).toEqual(runtimeListOptions("ws-1").queryKey);
    expect(options.refetchInterval).toBe(runtimeHostMetricsRefetchInterval);
  });
});

describe("runtimeHostMetricsRefetchInterval", () => {
  it("polls fast with samples and keeps a bounded recovery poll without", () => {
    const interval = runtimeHostMetricsRefetchInterval;
    // No data yet / no samples: the poll never switches off — a slower
    // recovery cadence keeps the path back after samples vanish (TTL expiry
    // during a sampler pause, a transient read failure).
    expect(interval({ state: { status: "pending", data: undefined } } as never)).toBe(
      SYSTEM_STATS_RECOVERY_MS,
    );
    expect(
      interval({
        state: { status: "success", data: [{ id: "rt-1", system_stats: null }] },
      } as never),
    ).toBe(SYSTEM_STATS_RECOVERY_MS);
    // A live sample switches to the fast freshness cadence.
    expect(
      interval({
        state: {
          status: "success",
          data: [
            { id: "rt-1", system_stats: null },
            {
              id: "rt-2",
              system_stats: { cpu_percent: 42, memory_percent: 68, captured_at: 1000, stale: false },
            },
          ],
        },
      } as never),
    ).toBe(SYSTEM_STATS_REFRESH_MS);
  });
});
