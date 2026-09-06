"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import {
  ProgressIndicator,
  ProgressTrack,
} from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import {
  activeQuotaWindows,
  formatCompactDuration,
  isQuotaStale,
  parsePlanQuota,
  quotaTone,
  quotaWindowLabel,
  windowRemainingPercent,
  type QuotaTone,
} from "@multica/core/runtimes";
import type { AgentRuntime } from "@multica/core/types";
import { useT } from "../../i18n";

type RuntimesT = ReturnType<typeof useT<"runtimes">>["t"];

// A window's short translated label ("5h" / "wk"): maps the core
// descriptor onto this namespace's strings. Null when the window carries no
// duration — the caller falls back to the window's own name.
export function formatQuotaWindowLabel(
  windowMinutes: number | null,
  t: RuntimesT,
): string | null {
  const descriptor = quotaWindowLabel(windowMinutes);
  if (descriptor == null) return null;
  if (descriptor.unit === "weekly") return t(($) => $.quota.window_weekly);
  if (descriptor.unit === "days") {
    return t(($) => $.quota.window_short_days, { value: descriptor.value });
  }
  if (descriptor.unit === "hours") {
    return t(($) => $.quota.window_short_hours, { value: descriptor.value });
  }
  return t(($) => $.quota.window_short_minutes, { value: descriptor.value });
}

// Tone → semantic classes for the quota bars (a small fill meter + a
// tone-colored percent).
const TONE_BAR_CLASS: Record<QuotaTone, string> = {
  ok: "bg-foreground/70",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const TONE_TEXT_CLASS: Record<QuotaTone, string> = {
  ok: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

// Thin fill meter for the quota-remaining bars. The caller owns the null
// state ("--" / omit) — the bar itself never renders one.
function MiniMeterBar({
  percent,
  tone,
  ariaLabel,
  className,
}: {
  percent: number;
  tone: QuotaTone;
  ariaLabel: string;
  className?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <ProgressPrimitive.Root
      value={value}
      aria-label={ariaLabel}
      className={cn("block", className)}
    >
      <ProgressTrack className="h-1">
        <ProgressIndicator className={TONE_BAR_CLASS[tone]} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

export interface QuotaWindowView {
  name: string;
  windowMinutes: number | null;
  remainingPercent: number | null;
  tone: QuotaTone;
  resetInMs: number | null;
}

export type RuntimeQuotaView =
  | { kind: "not_reported" }
  | { kind: "stale"; ageMs: number }
  | { kind: "limited"; windows: QuotaWindowView[]; resetInMs: number | null }
  | {
      kind: "ok";
      windows: QuotaWindowView[];
      resetInMs: number | null;
      observedAgeMs: number;
    };

// Derive everything the quota cell / card renders from a runtime's raw
// plan_quota snapshot. State precedence mirrors the product rules: a
// missing or malformed snapshot and one whose windows all expired read as
// "not reported"; a snapshot older than 24h reads as stale; "limited" with
// no percentage data is the claude-style exhausted state (never a
// fabricated percent).
export function buildRuntimeQuotaView(
  runtime: AgentRuntime,
  now: number,
): RuntimeQuotaView {
  const quota = parsePlanQuota(runtime.plan_quota);
  if (!quota) return { kind: "not_reported" };
  if (isQuotaStale(quota, now)) {
    return { kind: "stale", ageMs: now - quota.observed_at * 1000 };
  }
  const nowSec = Math.floor(now / 1000);
  const active = activeQuotaWindows(quota, nowSec);
  if (active.length === 0) return { kind: "not_reported" };
  const windows: QuotaWindowView[] = active.map((window) => {
    const remaining = windowRemainingPercent(window);
    return {
      name: window.name,
      windowMinutes: window.window_minutes,
      remainingPercent: remaining,
      tone: quotaTone(remaining, quota.status),
      resetInMs:
        window.resets_at != null ? window.resets_at * 1000 - now : null,
    };
  });
  const resetInMs = soonestResetMs(windows);
  if (
    quota.status === "limited" &&
    windows.every((window) => window.remainingPercent == null)
  ) {
    return { kind: "limited", windows, resetInMs };
  }
  return {
    kind: "ok",
    windows,
    resetInMs,
    observedAgeMs: now - quota.observed_at * 1000,
  };
}

function soonestResetMs(windows: QuotaWindowView[]): number | null {
  let best: number | null = null;
  for (const window of windows) {
    if (window.resetInMs == null || window.resetInMs <= 0) continue;
    if (best == null || window.resetInMs < best) best = window.resetInMs;
  }
  return best;
}

// The RuntimeList quota column cell: one row per active window (short
// label + remaining-based mini bar + remaining percent) plus the soonest
// reset countdown, or one of the degraded states.
export function RuntimeQuotaCell({
  runtime,
  now,
}: {
  runtime: AgentRuntime;
  now: number;
}) {
  const { t } = useT("runtimes");
  const view = buildRuntimeQuotaView(runtime, now);

  if (view.kind === "not_reported") {
    return (
      <span className="text-caption text-faint-foreground">
        {t(($) => $.quota.not_reported)}
      </span>
    );
  }
  if (view.kind === "stale") {
    return (
      <div className="flex w-full flex-col leading-tight">
        <span className="text-caption text-faint-foreground">
          {t(($) => $.quota.stale)}
        </span>
        <span className="text-micro tabular-nums text-faint-foreground">
          {t(($) => $.quota.stale_hint, {
            time: formatCompactDuration(view.ageMs),
          })}
        </span>
      </div>
    );
  }
  if (view.kind === "limited") {
    return (
      <div className="flex w-full flex-col leading-tight">
        <span className="text-caption text-destructive">
          {t(($) => $.quota.exhausted)}
        </span>
        {view.resetInMs != null && (
          <span className="text-micro tabular-nums text-faint-foreground">
            {t(($) => $.quota.resets_in, {
              time: formatCompactDuration(view.resetInMs),
            })}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-0.5 leading-tight">
      {view.windows.map((window, index) => (
        <QuotaWindowRow key={`${window.name}-${index}`} window={window} />
      ))}
      {view.resetInMs != null && (
        <span className="text-micro tabular-nums text-faint-foreground">
          {t(($) => $.quota.resets_in, {
            time: formatCompactDuration(view.resetInMs),
          })}
        </span>
      )}
    </div>
  );
}

function QuotaWindowRow({ window }: { window: QuotaWindowView }) {
  const { t } = useT("runtimes");
  const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-6 shrink-0 truncate text-micro text-muted-foreground">
        {label}
      </span>
      {window.remainingPercent == null ? (
        <span className="text-micro text-faint-foreground">
          {t(($) => $.machine.metrics.unavailable)}
        </span>
      ) : (
        <>
          <MiniMeterBar
            percent={window.remainingPercent}
            tone={window.tone}
            ariaLabel={label}
            className="w-8 shrink-0"
          />
          <span
            className={`text-micro tabular-nums ${TONE_TEXT_CLASS[window.tone]}`}
          >
            {Math.round(window.remainingPercent)}%
          </span>
        </>
      )}
    </span>
  );
}

// The runtime settings page's full quota card, between the hero card and
// the usage section. Same states as the list cell, plus the snapshot age
// in the footer.
export function RuntimeQuotaCard({
  runtime,
  now,
}: {
  runtime: AgentRuntime;
  now: number;
}) {
  const { t } = useT("runtimes");
  const view = buildRuntimeQuotaView(runtime, now);
  return (
    <section className="rounded-lg border bg-card">
      <h3 className="border-b px-4 py-2.5 text-caption font-semibold">
        {t(($) => $.quota.title)}
      </h3>
      <div className="space-y-3 p-4">
        {view.kind === "not_reported" && (
          <p className="text-caption text-faint-foreground">
            {t(($) => $.quota.not_reported)}
          </p>
        )}
        {view.kind === "stale" && (
          <div>
            <p className="text-caption text-faint-foreground">
              {t(($) => $.quota.stale)}
            </p>
            <p className="mt-1 text-micro tabular-nums text-faint-foreground">
              {t(($) => $.quota.stale_hint, {
                time: formatCompactDuration(view.ageMs),
              })}
            </p>
          </div>
        )}
        {view.kind === "limited" && (
          <div>
            <p className="text-caption font-medium text-destructive">
              {t(($) => $.quota.exhausted)}
            </p>
            {view.resetInMs != null && (
              <p className="mt-1 text-micro tabular-nums text-muted-foreground">
                {t(($) => $.quota.resets_in, {
                  time: formatCompactDuration(view.resetInMs),
                })}
              </p>
            )}
          </div>
        )}
        {view.kind === "ok" && (
          <>
            {view.windows.map((window, index) => (
              <QuotaCardWindow key={`${window.name}-${index}`} window={window} />
            ))}
            <p className="text-micro tabular-nums text-faint-foreground">
              {t(($) => $.quota.observed_ago, {
                time: formatCompactDuration(view.observedAgeMs),
              })}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function QuotaCardWindow({ window }: { window: QuotaWindowView }) {
  const { t } = useT("runtimes");
  const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption text-muted-foreground">{label}</span>
        {window.remainingPercent == null ? (
          <span className="text-caption text-faint-foreground">
            {t(($) => $.machine.metrics.unavailable)}
          </span>
        ) : (
          <span
            className={`text-caption tabular-nums ${TONE_TEXT_CLASS[window.tone]}`}
          >
            {t(($) => $.quota.remaining, {
              percent: Math.round(window.remainingPercent),
            })}
          </span>
        )}
      </div>
      {window.remainingPercent != null && (
        <MiniMeterBar
          percent={window.remainingPercent}
          tone={window.tone}
          ariaLabel={label}
        />
      )}
      {window.resetInMs != null && window.resetInMs > 0 && (
        <p className="text-micro tabular-nums text-faint-foreground">
          {t(($) => $.quota.resets_in, {
            time: formatCompactDuration(window.resetInMs),
          })}
        </p>
      )}
    </div>
  );
}
