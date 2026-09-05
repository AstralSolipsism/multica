// Pure helpers for the runtime plan-quota snapshot (`RuntimeDevice.plan_quota`
// — optional, older backends omit it). Every function degrades to "no data"
// (null / empty) instead of throwing or inventing numbers; the UI layers the
// not-reported / stale / limited states on top of these primitives.

import type {
  RuntimePlanQuota,
  RuntimePlanQuotaWindow,
} from "../types";
import {
  RuntimePlanQuotaSchema,
  RuntimePlanQuotaWindowSchema,
} from "../api/schemas";

export type QuotaTone = "ok" | "warning" | "destructive";

const QUOTA_STALE_MS = 24 * 3600 * 1000;

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
    if (result.success) windows.push(result.data);
  }
  return {
    provider: parsed.data.provider,
    status: parsed.data.status === "limited" ? "limited" : "ok",
    windows,
    observed_at: parsed.data.observed_at,
    source: parsed.data.source,
  };
}

/** Remaining percentage of a quota window; null when the provider only
 *  signals exhaustion without a percentage. */
export function windowRemainingPercent(
  window: RuntimePlanQuotaWindow,
): number | null {
  if (window.used_percent == null) return null;
  return 100 - window.used_percent;
}

/** Snapshots older than 24h are stale: the daemon is no longer feeding them,
 *  so the numbers can silently mislead. */
export function isQuotaStale(quota: RuntimePlanQuota, nowMs: number): boolean {
  return nowMs - quota.observed_at * 1000 > QUOTA_STALE_MS;
}

/** Windows whose reset time already passed carry no meaning anymore — the
 *  provider has reset the counter but we have no fresh snapshot. */
export function activeQuotaWindows(
  quota: RuntimePlanQuota,
  nowSec: number,
): RuntimePlanQuotaWindow[] {
  return quota.windows.filter(
    (window) => window.resets_at == null || window.resets_at > nowSec,
  );
}

/** The active window with the lowest remaining percentage — the one that
 *  throttles first. Windows without a percentage can't be ranked; if none
 *  carry one, returns null. */
export function worstQuotaWindow(
  quota: RuntimePlanQuota,
  nowSec: number,
): RuntimePlanQuotaWindow | null {
  let worst: RuntimePlanQuotaWindow | null = null;
  let worstRemaining = Infinity;
  for (const window of activeQuotaWindows(quota, nowSec)) {
    const remaining = windowRemainingPercent(window);
    if (remaining == null) continue;
    if (remaining < worstRemaining) {
      worstRemaining = remaining;
      worst = window;
    }
  }
  return worst;
}

export function quotaTone(
  remaining: number | null,
  status: RuntimePlanQuota["status"],
): QuotaTone {
  if (status === "limited") return "destructive";
  if (remaining != null && remaining <= 10) return "destructive";
  if (remaining != null && remaining <= 20) return "warning";
  return "ok";
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

/** Compact duration for reset countdowns / snapshot ages: "2h13m" at the
 *  hour scale, mm:ss under an hour ("01:50"). */
export function formatCompactDuration(ms: number): string {
  const clamped = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
