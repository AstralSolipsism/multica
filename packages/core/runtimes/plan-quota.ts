// Pure helpers for the runtime plan-quota snapshot (`RuntimeDevice.plan_quota`
// — optional, older backends omit it). Parsing degrades to "no data" (null /
// empty) instead of throwing or inventing numbers. evaluatePlanQuota derives
// what the UI shows: a window whose reset has passed counts as refilled, and a
// used-up window blocks the rest of its pool until it resets.

import type {
  RuntimePlanQuota,
  RuntimePlanQuotaWindow,
} from "../types";
import {
  RuntimePlanQuotaSchema,
  RuntimePlanQuotaWindowSchema,
} from "../api/schemas";

export type QuotaTone = "ok" | "warning" | "destructive";

// Collectors poll every two minutes and can back off for up to 30 minutes.
const COLLECTOR_QUOTA_INTERRUPTED_MS = 3600 * 1000;
// Matches the daemon's Kimi, Antigravity and ZenMux quota collectors.
const COLLECTOR_QUOTA_PROVIDERS = ["kimi", "antigravity", "zenmux"];

/**
 * Sanitize a raw `plan_quota` payload. A malformed snapshot returns null
 * (caller renders the not-reported state); a single malformed window is
 * dropped while the well-formed ones survive. Never throws.
 */
export function parsePlanQuota(raw: unknown): RuntimePlanQuota | null {
  if (raw == null) return null;
  const parsed = RuntimePlanQuotaSchema.safeParse(raw);
  if (!parsed.success) return null;
  const windows: RuntimePlanQuotaWindow[] = [];
  for (const candidate of parsed.data.windows) {
    const result = RuntimePlanQuotaWindowSchema.safeParse(candidate);
    if (result.success) {
      windows.push({
        name: result.data.name,
        used_percent: result.data.used_percent,
        window_minutes: result.data.window_minutes,
        resets_at: result.data.resets_at,
        group: result.data.group,
      });
    }
  }
  return {
    provider: parsed.data.provider,
    status: parsed.data.status === "limited" ? "limited" : "ok",
    windows,
    observed_at: parsed.data.observed_at,
    source: parsed.data.source,
  };
}

/**
 * A quota window's quota pool, normalized to null for ungrouped reporters.
 * Generic over the window shape so both raw wire windows and view models
 * group identically.
 */
export function quotaWindowGroup(
  window: { name: string; group?: string | null },
): string | null {
  const group = window.group?.trim();
  return group ? group : null;
}

/**
 * Windows grouped by quota pool for grouped display (the antigravity detail /
 * settings cards show every pool under its own label). Order is stable: the
 * documented antigravity pools first (gemini, then claude_gpt), unknown pools
 * after them in first-seen order, and ungrouped windows trailing as a null
 * group so a reporter without groups renders exactly as it did before the
 * field existed.
 */
export function groupQuotaWindows<T extends { name: string; group?: string | null }>(
  windows: T[],
): { group: string | null; windows: T[] }[] {
  const DOCUMENTED_ORDER = ["gemini", "claude_gpt"];
  const groups: { group: string | null; windows: T[] }[] = [];
  const firstSeen = new Map<string, { group: string | null; windows: T[] }>();
  for (const window of windows) {
    const group = quotaWindowGroup(window);
    const key = group ?? "\0ungrouped";
    let bucket = firstSeen.get(key);
    if (bucket == null) {
      bucket = { group, windows: [] };
      firstSeen.set(key, bucket);
      groups.push(bucket);
    }
    bucket.windows.push(window);
  }
  const rank = (group: string | null): number => {
    if (group == null) return DOCUMENTED_ORDER.length + 1;
    const at = DOCUMENTED_ORDER.indexOf(group);
    return at === -1 ? DOCUMENTED_ORDER.length : at;
  };
  // Array#sort is stable, so equal ranks keep first-seen order.
  return groups.sort((a, b) => rank(a.group) - rank(b.group));
}

/** Remaining percentage of a quota window; null when the provider only
 *  signals exhaustion without a percentage. */
export function windowRemainingPercent(
  window: RuntimePlanQuotaWindow,
): number | null {
  if (window.used_percent == null) return null;
  return 100 - window.used_percent;
}

/** A polled observation older than an hour means collection stopped. The
 *  last balance stays visible but is no longer current. */
export function isCollectorObservationInterrupted(
  observedAtSec: number,
  nowMs: number,
): boolean {
  return nowMs - observedAtSec * 1000 > COLLECTOR_QUOTA_INTERRUPTED_MS;
}

/** Only polling collectors can be interrupted. Task-reported providers
 *  observe quota while a task runs, so no new observation means no usage:
 *  their last balance holds until its reset time. */
export function isQuotaCollectionInterrupted(
  quota: RuntimePlanQuota,
  nowMs: number,
): boolean {
  return (
    COLLECTOR_QUOTA_PROVIDERS.includes(quota.provider) &&
    isCollectorObservationInterrupted(quota.observed_at, nowMs)
  );
}

export function quotaTone(remaining: number | null): QuotaTone {
  if (remaining != null && remaining <= 10) return "destructive";
  if (remaining != null && remaining <= 20) return "warning";
  return "ok";
}

/** One window after reset inference and the pool rules. Times are unix
 *  seconds. */
export interface QuotaWindowState {
  name: string;
  group: string | null;
  windowMinutes: number | null;
  /** 100 once the reset has passed; null when the provider sent no
   *  percentage. */
  remainingPercent: number | null;
  /** The upcoming reset; null once it has passed or when unknown. */
  resetsAt: number | null;
  /** The passed reset that refilled the window; null otherwise. */
  resetPassedAt: number | null;
  /** Used up: blocks its pool until it resets. */
  exhausted: boolean;
  /** A used-up sibling keeps the pool blocked past this window's own reset,
   *  so this window's balance does not matter until the pool recovers. */
  notApplicable: boolean;
  tone: QuotaTone;
}

/** Windows sharing a quota pool: one per group, ungrouped windows form one. */
export interface QuotaPoolState {
  group: string | null;
  windows: QuotaWindowState[];
  limited: boolean;
  /** The binding window's remaining percent; null when limited or when no
   *  window carries a percentage. */
  remainingPercent: number | null;
  /** Limited: when the pool recovers, i.e. the latest reset among its
   *  used-up windows (null if one is unknown). Otherwise the binding
   *  window's reset. */
  resetsAt: number | null;
  tone: QuotaTone;
}

/** The tightest constraint across pools, for single-value surfaces. */
export interface QuotaSummary {
  limited: boolean;
  remainingPercent: number | null;
  resetsAt: number | null;
  tone: QuotaTone;
}

export interface PlanQuotaState {
  provider: string;
  source: string;
  observedAt: number;
  pools: QuotaPoolState[];
  /** Every window names its pool and no pool constrains another
   *  (antigravity's gemini and claude_gpt): summarize each pool on its own. */
  independentPools: boolean;
  summary: QuotaSummary;
  /** A collector stopped reporting: the last balance stays, flagged. */
  interrupted: boolean;
}

/**
 * Derive the display state of a snapshot. A passed reset refills its window
 * (100%, no next reset). Per pool, a used-up window limits the pool until
 * the latest reset among its used-up windows; siblings that reset before
 * then, or never report a reset, are not applicable meanwhile. A pool
 * without a used-up window is bound by its least remaining window, the
 * later reset winning a tie.
 */
export function evaluatePlanQuota(
  quota: RuntimePlanQuota,
  nowMs: number,
): PlanQuotaState {
  const nowSec = Math.floor(nowMs / 1000);
  const usedUp = usedUpAtObservation(quota);
  const pools = groupQuotaWindows(quota.windows).map(({ group, windows }) =>
    evaluateQuotaPool(group, windows, usedUp, nowSec),
  );
  return {
    provider: quota.provider,
    source: quota.source,
    observedAt: quota.observed_at,
    pools,
    independentPools:
      quota.windows.length > 0 &&
      quota.windows.every((window) => quotaWindowGroup(window) != null),
    summary: summarizeQuotaPools(pools),
    interrupted: isQuotaCollectionInterrupted(quota, nowMs),
  };
}

/** A raw `plan_quota` payload's display state; null when nothing usable was
 *  reported (missing, malformed or windowless). */
export function planQuotaState(raw: unknown, nowMs: number): PlanQuotaState | null {
  const quota = parsePlanQuota(raw);
  if (!quota || quota.windows.length === 0) return null;
  return evaluatePlanQuota(quota, nowMs);
}

// Windows that were used up when observed. A full window always counts. A
// limited snapshot without one still names its limit: by the windows that
// carry no percentage, failing that by the most used ones.
function usedUpAtObservation(
  quota: RuntimePlanQuota,
): Set<RuntimePlanQuotaWindow> {
  const full = quota.windows.filter(
    (window) => window.used_percent != null && window.used_percent >= 100,
  );
  if (full.length > 0 || quota.status !== "limited") return new Set(full);
  const unmeasured = quota.windows.filter((window) => window.used_percent == null);
  if (unmeasured.length > 0) return new Set(unmeasured);
  const mostUsed = Math.max(...quota.windows.map((window) => window.used_percent ?? 0));
  return new Set(quota.windows.filter((window) => window.used_percent === mostUsed));
}

function evaluateQuotaPool(
  group: string | null,
  windows: RuntimePlanQuotaWindow[],
  usedUp: Set<RuntimePlanQuotaWindow>,
  nowSec: number,
): QuotaPoolState {
  const observed = windows.map((window) => {
    const passed = window.resets_at != null && window.resets_at <= nowSec;
    return {
      window,
      passed,
      exhausted: !passed && usedUp.has(window),
      remaining: passed ? 100 : windowRemainingPercent(window),
      resetsAt: passed ? null : window.resets_at,
    };
  });
  const exhausted = observed.filter((entry) => entry.exhausted);
  const limited = exhausted.length > 0;
  const recoverAt = latestReset(exhausted.map((entry) => entry.resetsAt));
  const states = observed.map((entry): QuotaWindowState => {
    const notApplicable =
      limited &&
      !entry.exhausted &&
      (entry.resetsAt == null || (recoverAt != null && entry.resetsAt <= recoverAt));
    return {
      name: entry.window.name,
      group,
      windowMinutes: entry.window.window_minutes,
      remainingPercent: entry.remaining,
      resetsAt: entry.resetsAt,
      resetPassedAt: entry.passed ? entry.window.resets_at : null,
      exhausted: entry.exhausted,
      notApplicable,
      tone: entry.exhausted
        ? "destructive"
        : notApplicable
          ? "ok"
          : quotaTone(entry.remaining),
    };
  });
  if (limited) {
    return {
      group,
      windows: states,
      limited,
      remainingPercent: null,
      resetsAt: recoverAt,
      tone: "destructive",
    };
  }
  const binding = tightest(states);
  return {
    group,
    windows: states,
    limited,
    remainingPercent: binding?.remainingPercent ?? null,
    resetsAt: binding?.resetsAt ?? null,
    tone: quotaTone(binding?.remainingPercent ?? null),
  };
}

function summarizeQuotaPools(pools: QuotaPoolState[]): QuotaSummary {
  const limited = pools.filter((pool) => pool.limited);
  if (limited.length > 0) {
    return {
      limited: true,
      remainingPercent: null,
      resetsAt: latestReset(limited.map((pool) => pool.resetsAt)),
      tone: "destructive",
    };
  }
  const binding = tightest(pools);
  return {
    limited: false,
    remainingPercent: binding?.remainingPercent ?? null,
    resetsAt: binding?.resetsAt ?? null,
    tone: quotaTone(binding?.remainingPercent ?? null),
  };
}

// The latest of a set of resets; null when the set is empty or any one is
// unknown, since the last of them decides recovery.
function latestReset(resets: (number | null)[]): number | null {
  if (resets.length === 0 || resets.some((reset) => reset == null)) return null;
  return Math.max(...(resets as number[]));
}

// The entry with the least remaining percent; on a tie, the later reset binds
// longer (an unknown reset counts as latest). Entries without a percentage
// cannot be ranked.
function tightest<T extends { remainingPercent: number | null; resetsAt: number | null }>(
  entries: T[],
): T | null {
  let best: T | null = null;
  for (const entry of entries) {
    if (entry.remainingPercent == null) continue;
    if (
      best == null ||
      entry.remainingPercent < best.remainingPercent! ||
      (entry.remainingPercent === best.remainingPercent &&
        resetsLater(entry.resetsAt, best.resetsAt))
    ) {
      best = entry;
    }
  }
  return best;
}

function resetsLater(a: number | null, b: number | null): boolean {
  if (a == null) return b != null;
  return b != null && a > b;
}

/** Structured short label for a quota window: 300 → {unit:"hours",value:5}
 *  ("5h"), 10080 → {unit:"weekly"} ("wk"/"周"); generic fallback minutes /
 *  hours / days. Null when the window carries no duration — the caller falls
 *  back to the window's own name. Presentation-neutral: the views layer maps
 *  the descriptor to its i18n strings. */
export type QuotaWindowLabel =
  | { unit: "weekly" }
  | { unit: "minutes" | "hours" | "days"; value: number };

export function quotaWindowLabel(
  windowMinutes: number | null,
): QuotaWindowLabel | null {
  if (windowMinutes == null || windowMinutes <= 0) return null;
  if (windowMinutes === 10080) return { unit: "weekly" };
  if (windowMinutes % 1440 === 0) {
    return { unit: "days", value: windowMinutes / 1440 };
  }
  if (windowMinutes % 60 === 0) {
    return { unit: "hours", value: windowMinutes / 60 };
  }
  return { unit: "minutes", value: windowMinutes };
}

/** Compact duration for reset countdowns / snapshot ages: "2h 13m" at the
 *  hour scale, explicit units under an hour ("7m 2s", "45s"). */
export function formatCompactDuration(ms: number): string {
  const clamped = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}
