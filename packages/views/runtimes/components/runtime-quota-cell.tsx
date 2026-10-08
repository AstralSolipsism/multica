"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import {
  ProgressIndicator,
  ProgressTrack,
} from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import {
  formatCompactDuration,
  planQuotaState,
  quotaWindowLabel,
  type QuotaPoolState,
  type QuotaSummary,
  type QuotaTone,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import type { AgentRuntime } from "@multica/core/types";
import { useT } from "../../i18n";
import { useQuotaTimeFormatter } from "./quota-time";

type QuotaT = ReturnType<typeof useT<"quota">>["t"];
type FormatQuotaTime = (epochSec: number, nowMs: number) => string;

// A window's short translated label ("5h" / "wk"): maps the core
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

// Thin fill meter for the quota-remaining and host-metrics bars. The caller
// owns the null state ("--" / omit) — the bar itself never renders one.
// barClassName overrides the tone's fill color for states that are not
// health judgments (e.g. a stale host-metrics sample must stay neutral
// gray even when its last value would tone "ok" — which is health-green).
export function MiniMeterBar({
  percent,
  tone,
  ariaLabel,
  className,
  barClassName,
}: {
  percent: number;
  tone: QuotaTone;
  ariaLabel: string;
  className?: string;
  barClassName?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <ProgressPrimitive.Root
      value={value}
      aria-label={ariaLabel}
      className={cn("block", className)}
    >
      <ProgressTrack className="h-1">
        <ProgressIndicator className={barClassName ?? TONE_BAR_CLASS[tone]} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
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
  const reset =
    status.resetsAt != null
      ? t(($) => $.resets_at, { time: formatTime(status.resetsAt, now) })
      : null;
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
  return `${t(($) => $.collection_interrupted)} · ${t(($) => $.last_updated, {
    time: formatTime(observedAt, now),
  })}`;
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
  if (window.resetsAt != null) {
    return t(($) => $.resets_at, { time: formatTime(window.resetsAt, now) });
  }
  if (window.resetPassedAt != null) {
    return t(($) => $.reset_passed, { time: formatTime(window.resetPassedAt, now) });
  }
  return null;
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

// The RuntimeList quota column cell: one row per reported window (short
// label + remaining-based mini bar + remaining percent), then the reset or
// limit of the tightest constraint — per pool when pools are independent.
export function RuntimeQuotaCell({
  runtime,
  now,
}: {
  runtime: AgentRuntime;
  now: number;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);

  if (!state) {
    return (
      <span className="text-caption text-faint-foreground">
        {t(($) => $.not_reported)}
      </span>
    );
  }
  const summaryStatus = state.independentPools
    ? null
    : quotaStatusText(state.summary, now, t, formatTime);
  return (
    <div className="flex w-full flex-col gap-0.5 leading-tight">
      {/* Grouped rendering kicks in only for reporters that label pools
          (antigravity's two quota groups); ungrouped snapshots fall into one
          unlabeled pool. */}
      {state.pools.map((pool) => {
        const poolStatus = state.independentPools
          ? quotaStatusText(pool, now, t, formatTime)
          : null;
        return (
          <span key={pool.group ?? "ungrouped"} className="flex flex-col gap-0.5">
            {pool.group != null && (
              <span className="truncate text-micro text-faint-foreground">
                {quotaGroupLabel(pool.group, t)}
              </span>
            )}
            {pool.windows.map((window, index) => (
              <QuotaWindowRow
                key={`${window.name}-${index}`}
                window={window}
                interrupted={state.interrupted}
              />
            ))}
            {poolStatus && (
              <QuotaStatusLine
                text={poolStatus}
                limited={pool.limited}
                interrupted={state.interrupted}
              />
            )}
          </span>
        );
      })}
      {summaryStatus && (
        <QuotaStatusLine
          text={summaryStatus}
          limited={state.summary.limited}
          interrupted={state.interrupted}
        />
      )}
      {state.interrupted && (
        <span className="text-micro tabular-nums text-faint-foreground">
          {quotaInterruptedText(state.observedAt, now, t, formatTime)}
        </span>
      )}
    </div>
  );
}

function QuotaStatusLine({
  text,
  limited,
  interrupted,
}: {
  text: string;
  limited: boolean;
  interrupted: boolean;
}) {
  return (
    <span
      className={cn(
        "text-micro tabular-nums",
        limited && !interrupted ? "text-destructive" : "text-faint-foreground",
      )}
    >
      {text}
    </span>
  );
}

function QuotaWindowRow({
  window,
  interrupted,
}: {
  window: QuotaWindowState;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  let label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  // In grouped rendering (antigravity pools), the group label above already
  // identifies the pool. Skip the row label when it would duplicate the
  // group name (the backend used to set Name = group ID).
  if (window.group != null && (label === window.group || label === quotaGroupLabel(window.group, t))) {
    label = "";
  }
  const valueText = quotaWindowValueText(window, t);
  return (
    <span className="flex items-center gap-1.5">
      {label !== "" && (
        <span className="w-6 shrink-0 truncate text-micro text-muted-foreground">
          {label}
        </span>
      )}
      {valueText != null || window.remainingPercent == null ? (
        <span className="text-micro text-faint-foreground">{valueText}</span>
      ) : (
        <>
          <MiniMeterBar
            percent={window.remainingPercent}
            tone={window.tone}
            ariaLabel={label}
            className="w-8 shrink-0"
            barClassName={interrupted ? MUTED_BAR_CLASS : undefined}
          />
          <span
            className={cn(
              "text-micro tabular-nums",
              interrupted ? "text-faint-foreground" : TONE_TEXT_CLASS[window.tone],
            )}
          >
            {displayRemainingPercent(window.remainingPercent)}%
          </span>
        </>
      )}
    </span>
  );
}

// The runtime settings page's full quota card, between the hero card and
// the usage section. Same rules as the list cell, with each window's own
// reset and the snapshot age in the footer.
export function RuntimeQuotaCard({
  runtime,
  now,
}: {
  runtime: AgentRuntime;
  now: number;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  return (
    <section className="rounded-lg border bg-card">
      <h3 className="border-b px-4 py-2.5 text-caption font-semibold">
        {t(($) => $.title)}
      </h3>
      <div className="space-y-3 p-4">
        {state == null ? (
          <p className="text-caption text-faint-foreground">
            {t(($) => $.not_reported)}
          </p>
        ) : (
          <>
            {/* Every pool gets its own section (the four antigravity
                buckets read as Gemini 5h/weekly and Claude + GPT 5h/weekly);
                a limited pool states when it recovers. */}
            {state.pools.map((pool) => {
              const status = pool.limited
                ? quotaStatusText(pool, now, t, formatTime)
                : null;
              return (
                <div key={pool.group ?? "ungrouped"} className="space-y-3">
                  {(pool.group != null || status != null) && (
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-micro font-medium text-muted-foreground">
                        {pool.group != null ? quotaGroupLabel(pool.group, t) : null}
                      </p>
                      {status != null && (
                        <p
                          className={cn(
                            "text-micro tabular-nums",
                            state.interrupted ? "text-faint-foreground" : "text-destructive",
                          )}
                        >
                          {status}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="space-y-3">
                    {pool.windows.map((window, index) => (
                      <QuotaCardWindow
                        key={`${window.name}-${index}`}
                        window={window}
                        now={now}
                        interrupted={state.interrupted}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            <p className="text-micro tabular-nums text-faint-foreground">
              {state.interrupted
                ? quotaInterruptedText(state.observedAt, now, t, formatTime)
                : t(($) => $.observed_ago, {
                    time: formatCompactDuration(now - state.observedAt * 1000),
                  })}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function QuotaCardWindow({
  window,
  now,
  interrupted,
}: {
  window: QuotaWindowState;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  const valueText = quotaWindowValueText(window, t);
  const reset = quotaWindowResetText(window, now, t, formatTime);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption text-muted-foreground">{label}</span>
        {valueText != null || window.remainingPercent == null ? (
          <span
            className={cn(
              "text-caption",
              window.exhausted && !window.notApplicable && !interrupted
                ? "text-destructive"
                : "text-faint-foreground",
            )}
          >
            {valueText}
          </span>
        ) : (
          <span
            className={cn(
              "text-caption tabular-nums",
              interrupted ? "text-faint-foreground" : TONE_TEXT_CLASS[window.tone],
            )}
          >
            {t(($) => $.remaining, {
              percent: displayRemainingPercent(window.remainingPercent),
            })}
          </span>
        )}
      </div>
      {valueText == null && window.remainingPercent != null && (
        <MiniMeterBar
          percent={window.remainingPercent}
          tone={window.tone}
          ariaLabel={label}
          barClassName={interrupted ? MUTED_BAR_CLASS : undefined}
        />
      )}
      {reset != null && (
        <p className="text-micro tabular-nums text-faint-foreground">{reset}</p>
      )}
    </div>
  );
}
