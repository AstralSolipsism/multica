// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { RuntimePlanQuotaWindow } from "../types";
import {
  activeQuotaWindows,
  formatCompactDuration,
  groupQuotaWindows,
  isQuotaStale,
  parsePlanQuota,
  quotaTone,
  quotaWindowGroup,
  quotaWindowLabel,
  windowRemainingPercent,
  worstQuotaWindow,
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

describe("isQuotaStale", () => {
  it("is fresh within 24h and stale beyond it", () => {
    const fresh = parsePlanQuota(makeQuota({ observed_at: NOW_SEC - 23 * 3600 }));
    const stale = parsePlanQuota(makeQuota({ observed_at: NOW_SEC - 25 * 3600 }));
    expect(fresh && isQuotaStale(fresh, NOW_MS)).toBe(false);
    expect(stale && isQuotaStale(stale, NOW_MS)).toBe(true);
  });
});

describe("activeQuotaWindows", () => {
  it("drops windows whose reset time has passed, keeps null resets", () => {
    const quota = parsePlanQuota(
      makeQuota({
        windows: [
          { name: "expired", used_percent: 10, window_minutes: 300, resets_at: NOW_SEC - 5 },
          { name: "live", used_percent: 10, window_minutes: 300, resets_at: NOW_SEC + 5 },
          { name: "open", used_percent: 10, window_minutes: null, resets_at: null },
        ],
      }),
    );
    expect(quota && activeQuotaWindows(quota, NOW_SEC).map((w) => w.name)).toEqual([
      "live",
      "open",
    ]);
  });
});

describe("worstQuotaWindow", () => {
  it("picks the active window with the lowest remaining percent", () => {
    const quota = parsePlanQuota(makeQuota());
    expect(quota && worstQuotaWindow(quota, NOW_SEC)?.name).toBe("primary");
  });

  it("ignores expired windows and windows without a percentage", () => {
    const quota = parsePlanQuota(
      makeQuota({
        windows: [
          { name: "expired", used_percent: 99, window_minutes: 300, resets_at: NOW_SEC - 5 },
          { name: "no-data", used_percent: null, window_minutes: 300, resets_at: NOW_SEC + 5 },
          { name: "live", used_percent: 50, window_minutes: 300, resets_at: NOW_SEC + 5 },
        ],
      }),
    );
    expect(quota && worstQuotaWindow(quota, NOW_SEC)?.name).toBe("live");
  });

  it("returns null when no active window carries a percentage", () => {
    const quota = parsePlanQuota(
      makeQuota({
        windows: [
          { name: "no-data", used_percent: null, window_minutes: 300, resets_at: NOW_SEC + 5 },
        ],
      }),
    );
    expect(quota && worstQuotaWindow(quota, NOW_SEC)).toBeNull();
  });
});

describe("quotaTone", () => {
  it("is destructive when limited, at <=10% remaining", () => {
    expect(quotaTone(50, "limited")).toBe("destructive");
    expect(quotaTone(10, "ok")).toBe("destructive");
    expect(quotaTone(0, "ok")).toBe("destructive");
  });

  it("is warning at <=20% remaining, ok otherwise", () => {
    expect(quotaTone(20, "ok")).toBe("warning");
    expect(quotaTone(21, "ok")).toBe("ok");
    expect(quotaTone(null, "ok")).toBe("ok");
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
    expect(formatCompactDuration((2 * 3600 + 13 * 60) * 1000)).toBe("2h13m");
    expect(formatCompactDuration(3600 * 1000)).toBe("1h");
    expect(formatCompactDuration(26 * 3600 * 1000)).toBe("26h");
  });

  it("formats sub-hour durations as mm:ss", () => {
    expect(formatCompactDuration(110 * 1000)).toBe("01:50");
    expect(formatCompactDuration(30 * 1000)).toBe("00:30");
  });

  it("clamps negative and non-finite input to zero", () => {
    expect(formatCompactDuration(-5)).toBe("00:00");
    expect(formatCompactDuration(Number.NaN)).toBe("00:00");
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

  it("never ranks the most-constrained bucket by group", () => {
    // The chip's "worst bucket" metric stays group-blind: whichever pool is
    // closest to exhausting throttles first, regardless of its label.
    const quota = parsePlanQuota(makeQuota({
      status: "ok",
      windows: [...antigravityWindows, { name: "x", used_percent: 99, window_minutes: 300, resets_at: null, group: "claude_gpt" }],
    }));
    expect(quota && worstQuotaWindow(quota, NOW_SEC)?.name).toBe("x");
  });
});
