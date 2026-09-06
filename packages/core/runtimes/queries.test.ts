// @vitest-environment node

import { describe, expect, it } from "vitest";
import { runtimeKeys, runtimeListOptions } from "./queries";
import { SYSTEM_STATS_REFRESH_MS } from "./host-metrics";

describe("runtimeListOptions freshness poll", () => {
  it("polls only while a runtime carries a system_stats sample", () => {
    const options = runtimeListOptions("ws-1");
    expect(options.queryKey).toEqual(runtimeKeys.list("ws-1"));
    const interval = options.refetchInterval;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function") return;
    // No data yet / no samples: the poll stays off — the bounded re-sync
    // exists only for views actually showing host metrics.
    expect(interval({ state: { status: "pending", data: undefined } } as never)).toBe(false);
    expect(
      interval({
        state: { status: "success", data: [{ id: "rt-1", system_stats: null }] },
      } as never),
    ).toBe(false);
    // A live sample switches the bounded freshness poll on.
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
