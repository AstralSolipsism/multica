import {
  evaluatePlanQuotaPools,
  parsePlanQuota,
  quotaWindowLabel,
  type PlanQuotaPoolsSummary,
  type QuotaPoolState,
  type QuotaSummary,
  type QuotaTone,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import type { AgentRuntime } from "@multica/core/types";
import type { useT } from "../../i18n";

export type QuotaT = ReturnType<typeof useT<"quota">>["t"];
export type FormatQuotaTime = (epochSec: number, nowMs: number) => string | null;

export function evaluateRuntimeAccountPools(
  runtime: AgentRuntime,
  now: number,
): PlanQuotaPoolsSummary | null {
  if (runtime.provider !== "omp" && runtime.plan_quota?.provider !== "omp") return null;
  const quota = parsePlanQuota(runtime.plan_quota);
  return quota ? evaluatePlanQuotaPools(quota, now) : null;
}

// A window's short translated label ("5h" / "7d"): maps the core
// descriptor onto this namespace's strings. Null when the window carries no
// duration — the caller falls back to the window's own name.
export function formatQuotaWindowLabel(
  windowMinutes: number | null,
  t: QuotaT,
): string | null {
  const descriptor = quotaWindowLabel(windowMinutes);
  if (descriptor == null) return null;
  if (descriptor.unit === "weekly") return t(($) => $.window_weekly);
  if (descriptor.unit === "days") {
    return t(($) => $.window_short_days, { value: descriptor.value });
  }
  if (descriptor.unit === "hours") {
    return t(($) => $.window_short_hours, { value: descriptor.value });
  }
  return t(($) => $.window_short_minutes, { value: descriptor.value });
}

// Tone → semantic classes for the quota bars (a small fill meter + a
// tone-colored percent). Shared with the host-metrics bars.
export const TONE_BAR_CLASS: Record<QuotaTone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export const TONE_TEXT_CLASS: Record<QuotaTone, string> = {
  ok: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

// An interrupted collection keeps its last fill without a health color.
export const MUTED_BAR_CLASS = "bg-muted-foreground/50";

export function quotaValueClass(tone: QuotaTone, interrupted: boolean): string {
  if (interrupted) return "text-faint-foreground";
  return tone === "ok" ? "text-foreground" : TONE_TEXT_CLASS[tone];
}

// The translated label for a quota pool ("Gemini" / "Claude + GPT"). Pools
// the i18n layer has no translation for fall back to the raw group key so a
// future third pool stays readable instead of disappearing.
export function quotaGroupLabel(group: string, t: QuotaT): string {
  if (group === "gemini") return t(($) => $.group_gemini);
  if (group === "claude_gpt") return t(($) => $.group_claude_gpt);
  if (group === "claude_models") return t(($) => $.group_claude_models);
  return group;
}

// "Rate limited · resets at 17:06" for a limited pool or summary, otherwise
// the binding window's reset. Null when there is nothing to say.
export function quotaStatusText(
  status: QuotaPoolState | QuotaSummary,
  now: number,
  t: QuotaT,
  formatTime: FormatQuotaTime,
): string | null {
  const time = status.resetsAt != null ? formatTime(status.resetsAt, now) : null;
  const reset = time != null ? t(($) => $.resets_at, { time }) : null;
  if (!status.limited) return reset;
  return reset ? `${t(($) => $.exhausted)} · ${reset}` : t(($) => $.exhausted);
}

// "Collection interrupted · last updated Oct 7, 13:20".
export function quotaInterruptedText(
  observedAt: number,
  now: number,
  t: QuotaT,
  formatTime: FormatQuotaTime,
): string {
  const interrupted = t(($) => $.collection_interrupted);
  const time = formatTime(observedAt, now);
  return time != null ? `${interrupted} · ${t(($) => $.last_updated, { time })}` : interrupted;
}

// A window's own reset: the upcoming one, or the passed reset that refilled
// it. A window set aside by its limited pool shows neither.
export function quotaWindowResetText(
  window: QuotaWindowState,
  now: number,
  t: QuotaT,
  formatTime: FormatQuotaTime,
): string | null {
  if (window.notApplicable) return null;
  const reset = window.resetsAt ?? window.resetPassedAt;
  const time = reset != null ? formatTime(reset, now) : null;
  if (time == null) return null;
  return window.resetsAt != null
    ? t(($) => $.resets_at, { time })
    : t(($) => $.reset_passed, { time });
}

// The value of a window that shows no meter: set aside by its pool, used up
// without a reported percentage, or simply unmeasured. Null when the window
// has a percentage to show.
export function quotaWindowValueText(window: QuotaWindowState, t: QuotaT): string | null {
  if (window.notApplicable) return t(($) => $.not_applicable);
  if (window.remainingPercent != null) return null;
  return window.exhausted ? t(($) => $.exhausted) : t(($) => $.unknown);
}

// Providers may report more than 100% used.
export function displayRemainingPercent(remaining: number): number {
  return Math.max(0, Math.round(remaining));
}
