// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { RuntimePlanQuotaWindow } from "../types";
import {
  evaluatePlanQuota,
  formatCompactDuration,
  groupQuotaWindows,
  isCollectorObservationInterrupted,
  isQuotaCollectionInterrupted,
  parsePlanQuota,
  planQuotaState,
  quotaTone,
  quotaWindowGroup,
  quotaWindowLabel,
  windowRemainingPercent,
} from "./plan-quota";

const NOW_SEC = 1_800_000_000; // 2027-01-15T06:40:00Z
const NOW_MS = NOW_SEC * 1000;

function makeQuota(overrides: Record<string, unknown> = {}) {
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
        used_percent: 19,
        window_minutes: 10080,
        resets_at: NOW_SEC + 4 * 24 * 3600,
      },
    ],
    observed_at: NOW_SEC - 60,
    source: "daemon",
    ...overrides,
  };
}

describe("parsePlanQuota", () => {
  it("returns null for missing or non-object payloads", () => {
    expect(parsePlanQuota(null)).toBeNull();
    expect(parsePlanQuota(undefined)).toBeNull();
    expect(parsePlanQuota("quota")).toBeNull();
    expect(parsePlanQuota(42)).toBeNull();
    expect(parsePlanQuota([])).toBeNull();
  });

  it("returns null when top-level fields are malformed", () => {
    expect(parsePlanQuota({ windows: "not-an-array" })).toBeNull();
    expect(parsePlanQuota(makeQuota({ observed_at: "yesterday" }))).toBeNull();
  });

  it("parses a well-formed snapshot, preserving limited status", () => {
    const quota = parsePlanQuota(makeQuota({ status: "limited" }));
    expect(quota).not.toBeNull();
    expect(quota?.status).toBe("limited");
    expect(quota?.provider).toBe("codex");
    expect(quota?.windows).toHaveLength(2);
    expect(quota?.observed_at).toBe(NOW_SEC - 60);
  });

  it("folds an unknown status to ok", () => {
    expect(parsePlanQuota(makeQuota({ status: "throttled" }))?.status).toBe("ok");
  });

  it("drops a single malformed window instead of failing the snapshot", () => {
    const quota = parsePlanQuota(
      makeQuota({
        windows: [
          {
            name: "primary",
            used_percent: 38,
            window_minutes: 300,
            resets_at: NOW_SEC + 3600,
          },
          { name: "broken", used_percent: "high" },
          "garbage",
        ],
      }),
    );
    expect(quota?.windows).toHaveLength(1);
    expect(quota?.windows[0]?.name).toBe("primary");
  });

  it("never throws on exotic input", () => {
    expect(() =>
      parsePlanQuota({ windows: [Symbol.iterator], observed_at: NaN }),
    ).not.toThrow();
  });
});

describe("windowRemainingPercent", () => {
  it("is 100 - used_percent", () => {
    expect(
      windowRemainingPercent({
        name: "primary",
        used_percent: 38,
        window_minutes: 300,
        resets_at: null,
      }),
    ).toBe(62);
  });

  it("is null when the provider reports no percentage", () => {
    expect(
      windowRemainingPercent({
        name: "primary",
        used_percent: null,
        window_minutes: 300,
        resets_at: null,
      }),
    ).toBeNull();
  });
});

describe("collection interruption", () => {
  it.each(["kimi", "antigravity", "zenmux"])("flags %s after an hour without a poll", (provider) => {
    const quota = parsePlanQuota(makeQuota({ provider, observed_at: NOW_SEC - 3600 }))!;
    expect(isQuotaCollectionInterrupted(quota, NOW_MS)).toBe(false);
    expect(isQuotaCollectionInterrupted(quota, NOW_MS + 1)).toBe(true);
  });

  it.each(["codex", "claude", "custom"])("never flags task-reported %s snapshots", (provider) => {
    // No task means no usage: the last observation stays valid until reset.
    const quota = parsePlanQuota(makeQuota({ provider, observed_at: NOW_SEC - 30 * 86400 }))!;
    expect(isQuotaCollectionInterrupted(quota, NOW_MS)).toBe(false);
  });

  it("applies the same hour to any polled observation", () => {
    expect(isCollectorObservationInterrupted(NOW_SEC - 3600, NOW_MS)).toBe(false);
    expect(isCollectorObservationInterrupted(NOW_SEC - 3601, NOW_MS)).toBe(true);
  });
});

describe("quotaTone", () => {
  it("is destructive at <=10% remaining", () => {
    expect(quotaTone(10)).toBe("destructive");
    expect(quotaTone(0)).toBe("destructive");
  });

  it("is warning at <=20% remaining, ok otherwise", () => {
    expect(quotaTone(20)).toBe("warning");
    expect(quotaTone(21)).toBe("ok");
    expect(quotaTone(null)).toBe("ok");
  });
});

describe("planQuotaState", () => {
  it("is null when the snapshot is missing, malformed, or windowless", () => {
    expect(planQuotaState(null, NOW_MS)).toBeNull();
    expect(planQuotaState("garbage", NOW_MS)).toBeNull();
    expect(planQuotaState(makeQuota({ windows: [] }), NOW_MS)).toBeNull();
  });

  it("evaluates a usable snapshot", () => {
    expect(planQuotaState(makeQuota(), NOW_MS)?.summary).toEqual({
      limited: false,
      remainingPercent: 62,
      resetsAt: NOW_SEC + 3600,
      tone: "ok",
    });
  });
});

describe("evaluatePlanQuota", () => {
  type Window = {
    name: string;
    used_percent: number | null;
    resets_at: number | null;
    window_minutes?: number | null;
    group?: string | null;
  };
  function evaluate(windows: Window[], overrides: Record<string, unknown> = {}) {
    return evaluatePlanQuota(parsePlanQuota(makeQuota({ windows, ...overrides }))!, NOW_MS);
  }
  const HOUR = 3600;
  const DAY = 24 * HOUR;

  it("refills a window once its reset has passed", () => {
    const state = evaluate([
      { name: "at", used_percent: 99, resets_at: NOW_SEC },
      { name: "next", used_percent: 99, resets_at: NOW_SEC + 1 },
    ]);
    const [at, next] = state.pools[0]!.windows;
    expect(at).toMatchObject({ remainingPercent: 100, resetsAt: null, resetPassedAt: NOW_SEC, tone: "ok" });
    expect(next).toMatchObject({ remainingPercent: 1, resetsAt: NOW_SEC + 1, resetPassedAt: null });
  });

  it("shows the weekly balance once the five-hour window has reset", () => {
    // Claude on agent-ops-host-149: the 5h reset passed, weekly has 86% left.
    const state = evaluate([
      { name: "five_hour", used_percent: 1, window_minutes: 300, resets_at: NOW_SEC - 60 },
      { name: "seven_day", used_percent: 14, window_minutes: 10080, resets_at: NOW_SEC + 4 * DAY },
    ], { provider: "claude" });
    expect(state.summary).toEqual({
      limited: false,
      remainingPercent: 86,
      resetsAt: NOW_SEC + 4 * DAY,
      tone: "ok",
    });
    expect(state.pools[0]!.windows.some((window) => window.notApplicable)).toBe(false);
  });

  it("binds on the least remaining window, not the soonest reset", () => {
    const state = evaluate([
      { name: "five_hour", used_percent: 1, resets_at: NOW_SEC + 4 * HOUR },
      { name: "seven_day", used_percent: 15, resets_at: NOW_SEC + 4 * DAY },
    ]);
    expect(state.summary).toMatchObject({ remainingPercent: 85, resetsAt: NOW_SEC + 4 * DAY });
  });

  it("lets the later reset win a tie", () => {
    const state = evaluate([
      { name: "five_hour", used_percent: 70, resets_at: NOW_SEC + HOUR },
      { name: "seven_day", used_percent: 70, resets_at: NOW_SEC + 3 * DAY },
    ]);
    expect(state.summary.resetsAt).toBe(NOW_SEC + 3 * DAY);
  });

  it("limits the pool until a used-up weekly resets and sets the five-hour aside", () => {
    const state = evaluate([
      { name: "five_hour", used_percent: 50, resets_at: NOW_SEC + 2 * HOUR },
      { name: "seven_day", used_percent: 100, resets_at: NOW_SEC + 3 * DAY },
    ]);
    const pool = state.pools[0]!;
    expect(pool).toMatchObject({ limited: true, resetsAt: NOW_SEC + 3 * DAY, remainingPercent: null, tone: "destructive" });
    expect(pool.windows.map((window) => [window.name, window.exhausted, window.notApplicable])).toEqual([
      ["five_hour", false, true],
      ["seven_day", true, false],
    ]);
    expect(state.summary).toEqual({ limited: true, remainingPercent: null, resetsAt: NOW_SEC + 3 * DAY, tone: "destructive" });
  });

  it("keeps a window that resets after recovery applicable", () => {
    const state = evaluate([
      { name: "five_hour", used_percent: 100, resets_at: NOW_SEC + 2 * HOUR },
      { name: "seven_day", used_percent: 70, resets_at: NOW_SEC + 4 * DAY },
    ]);
    const pool = state.pools[0]!;
    expect(pool).toMatchObject({ limited: true, resetsAt: NOW_SEC + 2 * HOUR });
    expect(pool.windows[1]).toMatchObject({ notApplicable: false, remainingPercent: 30, tone: "ok" });
  });

  it("waits for the latest used-up window and treats a shared reset as not applicable", () => {
    const state = evaluate([
      { name: "five_hour", used_percent: 100, resets_at: NOW_SEC + 2 * HOUR },
      { name: "seven_day", used_percent: 100, resets_at: NOW_SEC + 3 * DAY },
      { name: "boundary", used_percent: 10, resets_at: NOW_SEC + 3 * DAY },
    ]);
    expect(state.pools[0]!.resetsAt).toBe(NOW_SEC + 3 * DAY);
    expect(state.pools[0]!.windows.map((window) => window.notApplicable)).toEqual([false, false, true]);
  });

  it("does not know when a pool recovers if a used-up window has no reset", () => {
    const state = evaluate([
      { name: "seven_day", used_percent: 100, resets_at: null },
      { name: "five_hour", used_percent: 40, resets_at: NOW_SEC + HOUR },
    ]);
    expect(state.pools[0]).toMatchObject({ limited: true, resetsAt: null });
    expect(state.pools[0]!.windows[1]!.notApplicable).toBe(false);
  });

  it("evaluates independent antigravity pools separately", () => {
    // Live 10-08 shape: the claude_gpt weekly pool is used up and the API
    // disables its 5h bucket; gemini is untouched.
    const state = evaluate([
      { name: "gemini_5h", used_percent: 0, window_minutes: 300, resets_at: null, group: "gemini" },
      { name: "gemini_weekly", used_percent: 0, window_minutes: 10080, resets_at: null, group: "gemini" },
      { name: "claude_gpt_5h", used_percent: 0, window_minutes: 300, resets_at: null, group: "claude_gpt" },
      { name: "claude_gpt_weekly", used_percent: 100, window_minutes: 10080, resets_at: NOW_SEC + 2 * DAY, group: "claude_gpt" },
    ], { provider: "antigravity", status: "limited" });
    expect(state.independentPools).toBe(true);
    const [gemini, claudeGpt] = state.pools;
    expect(gemini).toMatchObject({ group: "gemini", limited: false, remainingPercent: 100, resetsAt: null, tone: "ok" });
    expect(gemini!.windows.every((window) => window.tone === "ok" && !window.notApplicable)).toBe(true);
    expect(claudeGpt).toMatchObject({ group: "claude_gpt", limited: true, resetsAt: NOW_SEC + 2 * DAY });
    expect(claudeGpt!.windows.map((window) => window.notApplicable)).toEqual([true, false]);
    expect(state.summary).toMatchObject({ limited: true, resetsAt: NOW_SEC + 2 * DAY });
  });

  it("lifts a limit once the used-up window has reset", () => {
    const state = evaluate([
      { name: "claude_gpt_weekly", used_percent: 100, resets_at: NOW_SEC - 1, group: "claude_gpt" },
      { name: "claude_gpt_5h", used_percent: 0, resets_at: null, group: "claude_gpt" },
    ], { provider: "antigravity", status: "limited" });
    expect(state.pools[0]).toMatchObject({ limited: false, remainingPercent: 100 });
    expect(state.summary.limited).toBe(false);
  });

  it("attributes a limited snapshot to windows without a percentage", () => {
    const state = evaluate([
      { name: "primary", used_percent: null, resets_at: NOW_SEC + 110 },
      { name: "secondary", used_percent: 60, resets_at: NOW_SEC + 3 * DAY },
    ], { status: "limited" });
    expect(state.pools[0]!.windows.map((window) => window.exhausted)).toEqual([true, false]);
    expect(state.summary).toMatchObject({ limited: true, resetsAt: NOW_SEC + 110 });
  });

  it("attributes a limited snapshot to its most used window when all are measured", () => {
    const state = evaluate([
      { name: "five_hour", used_percent: 98, resets_at: NOW_SEC + HOUR },
      { name: "seven_day", used_percent: 40, resets_at: NOW_SEC + 3 * DAY },
    ], { provider: "claude", status: "limited" });
    expect(state.pools[0]!.windows.map((window) => window.exhausted)).toEqual([true, false]);
    expect(state.summary).toMatchObject({ limited: true, resetsAt: NOW_SEC + HOUR });
  });

  it("does not limit an ok snapshot without a full window", () => {
    const state = evaluate([{ name: "primary", used_percent: null, resets_at: NOW_SEC + HOUR }]);
    expect(state.summary).toEqual({ limited: false, remainingPercent: null, resetsAt: null, tone: "ok" });
  });

  it("merges model-specific Claude pools into the single summary", () => {
    const state = evaluate([
      { name: "five_hour", used_percent: 10, resets_at: NOW_SEC + HOUR },
      { name: "seven_day", used_percent: 20, resets_at: NOW_SEC + 3 * DAY },
      { name: "seven_day_opus", used_percent: 100, resets_at: NOW_SEC + 2 * DAY, group: "Opus" },
    ], { provider: "claude" });
    expect(state.independentPools).toBe(false);
    expect(state.pools.map((pool) => [pool.group, pool.limited])).toEqual([["Opus", true], [null, false]]);
    expect(state.summary).toMatchObject({ limited: true, resetsAt: NOW_SEC + 2 * DAY });
  });

  it("takes the tightest pool when none is limited", () => {
    const state = evaluate([
      { name: "gemini_weekly", used_percent: 50, resets_at: NOW_SEC + DAY, group: "gemini" },
      { name: "claude_gpt_weekly", used_percent: 85, resets_at: NOW_SEC + 2 * DAY, group: "claude_gpt" },
    ], { provider: "antigravity" });
    expect(state.summary).toEqual({ limited: false, remainingPercent: 15, resetsAt: NOW_SEC + 2 * DAY, tone: "warning" });
  });

  it("reports collector interruption with the observation time", () => {
    const kimi = evaluatePlanQuota(parsePlanQuota(makeQuota({ provider: "kimi", observed_at: NOW_SEC - 2 * HOUR }))!, NOW_MS);
    expect(kimi).toMatchObject({ interrupted: true, observedAt: NOW_SEC - 2 * HOUR, provider: "kimi" });
    const codex = evaluatePlanQuota(parsePlanQuota(makeQuota({ observed_at: NOW_SEC - 2 * DAY }))!, NOW_MS);
    expect(codex.interrupted).toBe(false);
  });
});

describe("quotaWindowLabel", () => {
  it("maps 300 to hours and 10080 to weekly", () => {
    expect(quotaWindowLabel(300)).toEqual({ unit: "hours", value: 5 });
    expect(quotaWindowLabel(10080)).toEqual({ unit: "weekly" });
  });

  it("falls back to days / hours / minutes for other durations", () => {
    expect(quotaWindowLabel(2880)).toEqual({ unit: "days", value: 2 });
    expect(quotaWindowLabel(120)).toEqual({ unit: "hours", value: 2 });
    expect(quotaWindowLabel(90)).toEqual({ unit: "minutes", value: 90 });
  });

  it("returns null when the window has no duration", () => {
    expect(quotaWindowLabel(null)).toBeNull();
    expect(quotaWindowLabel(0)).toBeNull();
  });
});

describe("formatCompactDuration", () => {
  it("formats hours as XhYYm, dropping zero minutes", () => {
    expect(formatCompactDuration((2 * 3600 + 13 * 60) * 1000)).toBe("2h 13m");
    expect(formatCompactDuration(3600 * 1000)).toBe("1h");
    expect(formatCompactDuration(26 * 3600 * 1000)).toBe("26h");
  });

  it("formats sub-hour durations with explicit units", () => {
    expect(formatCompactDuration(110 * 1000)).toBe("1m 50s");
    expect(formatCompactDuration(30 * 1000)).toBe("30s");
  });

  it("clamps negative and non-finite input to zero", () => {
    expect(formatCompactDuration(-5)).toBe("0s");
    expect(formatCompactDuration(Number.NaN)).toBe("0s");
  });
});

// The antigravity probe reports two quota pools (gemini, claude_gpt), each
// with a 5h and a weekly window — four buckets a flat list would leave
// ambiguous once the short "5h"/"wk" labels repeat.
describe("quota window groups", () => {
  const antigravityWindows: RuntimePlanQuotaWindow[] = [
    { name: "gemini_weekly", used_percent: 50, window_minutes: 10080, resets_at: null, group: "gemini" },
    { name: "gemini_5h", used_percent: 75, window_minutes: 300, resets_at: null, group: "gemini" },
    { name: "claude_gpt_weekly", used_percent: 25, window_minutes: 10080, resets_at: null, group: "claude_gpt" },
    { name: "claude_gpt_5h", used_percent: 50, window_minutes: 300, resets_at: null, group: "claude_gpt" },
  ];
  const geminiWindow = (group: RuntimePlanQuotaWindow["group"]): RuntimePlanQuotaWindow => ({
    name: "gemini_5h",
    used_percent: 75,
    window_minutes: 300,
    resets_at: null,
    group,
  });

  it("keeps the window group through parsePlanQuota", () => {
    const quota = parsePlanQuota(makeQuota({ windows: antigravityWindows }));
    expect(quota?.windows.map((window) => window.group)).toEqual([
      "gemini",
      "gemini",
      "claude_gpt",
      "claude_gpt",
    ]);
  });

  it("normalizes blank groups to null", () => {
    expect(quotaWindowGroup(geminiWindow("  "))).toBeNull();
    expect(quotaWindowGroup(geminiWindow(null))).toBeNull();
    expect(quotaWindowGroup(geminiWindow(undefined))).toBeNull();
    expect(quotaWindowGroup(geminiWindow("gemini"))).toBe("gemini");
  });

  it("groups windows by pool in documented-first order", () => {
    const groups = groupQuotaWindows(antigravityWindows);
    expect(groups.map((entry) => entry.group)).toEqual(["gemini", "claude_gpt"]);
    const [gemini, claudeGpt] = groups;
    expect(gemini?.windows.map((window) => window.name)).toEqual([
      "gemini_weekly",
      "gemini_5h",
    ]);
    expect(claudeGpt?.windows.map((window) => window.name)).toEqual([
      "claude_gpt_weekly",
      "claude_gpt_5h",
    ]);
  });

  it("renders ungrouped reporters as a single trailing unlabeled group", () => {
    const groups = groupQuotaWindows(makeQuota().windows);
    expect(groups).toHaveLength(1);
    expect(groups.map((entry) => entry.group)).toEqual([null]);
  });

  it("keeps unknown pools readable after the documented ones", () => {
    const groups = groupQuotaWindows([
      { name: "codex_weekly", used_percent: 10, window_minutes: 10080, resets_at: null, group: "codex" },
      { name: "gemini_5h", used_percent: 20, window_minutes: 300, resets_at: null, group: "gemini" },
    ]);
    expect(groups.map((entry) => entry.group)).toEqual(["gemini", "codex"]);
  });

  it("trails ungrouped windows after every labeled pool", () => {
    const groups = groupQuotaWindows([
      { name: "legacy_5h", used_percent: 20, window_minutes: 300, resets_at: null, group: null },
      { name: "gemini_5h", used_percent: 20, window_minutes: 300, resets_at: null, group: "gemini" },
    ]);
    expect(groups.map((entry) => entry.group)).toEqual(["gemini", null]);
  });
});

describe("fully replenished windows (OL-141 four-window shape)", () => {
  // Shape emitted by the antigravity summary collector: one window per pool
  // and period, where a fully replenished window carries no reset time (the
  // rolling "now + period" the API reports would never hold still).
  const fourWindows: RuntimePlanQuotaWindow[] = [
    { name: "gemini_5h", used_percent: 1, window_minutes: 300, resets_at: NOW_SEC + 5 * 3600, group: "gemini" },
    { name: "gemini_weekly", used_percent: 20, window_minutes: 10080, resets_at: NOW_SEC + 3600, group: "gemini" },
    { name: "claude_gpt_5h", used_percent: 0, window_minutes: 300, resets_at: null, group: "claude_gpt" },
    { name: "claude_gpt_weekly", used_percent: 100, window_minutes: 10080, resets_at: NOW_SEC + 3 * 24 * 3600, group: "claude_gpt" },
  ];

  it("groups both pools with 5h and weekly windows side by side", () => {
    const groups = groupQuotaWindows(fourWindows);
    expect(groups.map((entry) => entry.group)).toEqual(["gemini", "claude_gpt"]);
    expect(groups[0]?.windows.map((window) => window.name)).toEqual(["gemini_5h", "gemini_weekly"]);
    expect(groups[1]?.windows.map((window) => window.name)).toEqual(["claude_gpt_5h", "claude_gpt_weekly"]);
  });
});
