// @vitest-environment node

import { describe, expect, it } from "vitest";
import { runtimeKeys, runtimeListOptions } from "./queries";
import { SYSTEM_STATS_RECOVERY_MS, SYSTEM_STATS_REFRESH_MS } from "./host-metrics";

describe("runtimeListOptions freshness poll", () => {
  it("polls fast with samples and keeps a bounded recovery poll without", () => {
    const options = runtimeListOptions("ws-1");
    expect(options.queryKey).toEqual(runtimeKeys.list("ws-1"));
    const interval = options.refetchInterval;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function") return;
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
