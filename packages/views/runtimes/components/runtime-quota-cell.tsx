"use client";

import { useState } from "react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import {
  ProgressIndicator,
  ProgressTrack,
} from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import { AlertTriangle, ChevronRight } from "@multica/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import {
  evaluatePlanQuotaPools,
  formatCompactDuration,
  parsePlanQuota,
  planQuotaState,
  quotaWindowLabel,
  type PlanQuotaPoolsSummary,
  type QuotaAccountPoolState,
  type QuotaAccountState,
  type QuotaPoolState,
  type QuotaSummary,
  type QuotaTone,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import type {
  Agent,
  AgentRuntime,
  RuntimeThinkingAdapt,
} from "@multica/core/types";
import { useT } from "../../i18n";
import {
  thinkingAdaptSourceLabel,
  thinkingAdaptStatusLabel,
} from "../../common/thinking-adapt";
import { useQuotaTimeFormatter } from "./quota-time";
import { ProviderLogo } from "./provider-logo";
import {
  accountPoolLogoProvider,
  accountPoolNeedsRelogin,
  accountPoolProviderLabel,
  partitionAccountPools,
} from "./account-pool-filter";

type QuotaT = ReturnType<typeof useT<"quota">>["t"];
type FormatQuotaTime = (epochSec: number, nowMs: number) => string | null;

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

// The RuntimeList quota column cell: one row per reported window (short
// label + remaining-based mini bar + remaining percent), then the reset or
// limit of the tightest constraint — per pool when pools are independent.
export function RuntimeQuotaCell({
  runtime,
  now,
  agents = [],
  thinkingAdapt = runtime.thinking_adapt ?? null,
}: {
  runtime: AgentRuntime;
  now: number;
  agents?: Agent[];
  thinkingAdapt?: RuntimeThinkingAdapt | null;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  const accountPools = evaluateRuntimeAccountPools(runtime, now);

  if (!state) {
    if (thinkingAdapt) {
      return (
        <div className="flex w-full flex-col gap-0.5 leading-tight">
          <span className="text-caption text-faint-foreground">
            {t(($) => $.not_reported)}
          </span>
          <ThinkingAdaptQuotaRow snapshot={thinkingAdapt} />
        </div>
      );
    }
    return (
      <span className="text-caption text-faint-foreground">
        {t(($) => $.not_reported)}
      </span>
    );
  }
  if (accountPools) {
    return (
      <div className="flex w-full flex-col gap-1.5 leading-tight">
        <AccountPoolQuotaList
          summary={accountPools}
          agents={agents}
          runtimeId={runtime.id}
          now={now}
          interrupted={state.interrupted}
        />
        {thinkingAdapt && <ThinkingAdaptQuotaRow snapshot={thinkingAdapt} />}
        {state.interrupted && (
          <span className="text-micro tabular-nums text-faint-foreground">
            {quotaInterruptedText(state.observedAt, now, t, formatTime)}
          </span>
        )}
      </div>
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
      {thinkingAdapt && <ThinkingAdaptQuotaRow snapshot={thinkingAdapt} />}
      {state.interrupted && (
        <span className="text-micro tabular-nums text-faint-foreground">
          {quotaInterruptedText(state.observedAt, now, t, formatTime)}
        </span>
      )}
    </div>
  );
}

export function ThinkingAdaptQuotaRow({
  snapshot,
}: {
  snapshot: RuntimeThinkingAdapt;
}) {
  const { t } = useT("quota");
  const { t: tf } = useT("fork-ui");
  const available = snapshot.status === "available";
  const source = snapshot.active_source
    ? thinkingAdaptSourceLabel(snapshot.active_source, t)
    : null;
  const detail = available
    ? [
        source ?? thinkingAdaptStatusLabel(snapshot, t),
        snapshot.last_latency_ms != null
          ? `${snapshot.last_latency_ms}ms`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : thinkingAdaptStatusLabel(snapshot, t);
  const text = `${tf(($) => $.agents.thinking_adapt.label)} · ${detail}`;
  const counts = t(($) => $.thinking_adapt.counts, {
    success: snapshot.decisions_ok ?? 0,
    fallback: snapshot.decisions_fallback ?? 0,
  });
  const dotClass = available
    ? "bg-success"
    : snapshot.status === "degraded" || snapshot.status === "unavailable"
      ? "bg-warning"
      : "bg-muted-foreground/50";

  const row = (
    <span
      tabIndex={0}
      data-thinking-adapt-status={snapshot.status}
      aria-label={`${text}. ${counts}`}
      className="flex max-w-full items-center gap-1.5 rounded-sm text-micro text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)}
      />
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent>{counts}</TooltipContent>
    </Tooltip>
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

function accountPoolPrimaryWindow(
  pool: QuotaAccountPoolState,
): QuotaWindowState | null {
  return pool.windows.find((window) => window.windowMinutes === 300) ?? pool.windows[0] ?? null;
}

export function accountPoolAriaLabel(pool: QuotaAccountPoolState, t: QuotaT): string {
  const balances = pool.windows.map((window) => {
    const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
    const value = window.remainingPercent == null
      ? t(($) => $.unknown)
      : t(($) => $.remaining, { percent: displayRemainingPercent(window.remainingPercent) });
    return `${label} ${value}`;
  });
  const available = t(($) => $.account_pools.accounts_available_aria, {
    available: pool.availableAccounts,
    total: pool.totalAccounts,
  });
  return `${accountPoolProviderLabel(pool.id)}: ${available}${balances.length > 0 ? ` · ${balances.join(" · ")}` : ""}`;
}

function accountPoolRecoveryText(
  pool: QuotaAccountPoolState,
  now: number,
  t: QuotaT,
): string | null {
  if (!pool.exhausted || accountPoolNeedsRelogin(pool) || pool.resumesAt == null) return null;
  return t(($) => $.account_pools.earliest_recovery, {
    time: formatCompactDuration(pool.resumesAt * 1000 - now),
    account: (pool.resumesAccountIndex ?? 0) + 1,
  });
}

function accountStatusLabel(status: QuotaAccountState["status"], t: QuotaT): string {
  switch (status) {
    case "ok":
      return t(($) => $.account_pools.account_normal);
    case "warning":
      return t(($) => $.account_pools.account_warning);
    case "exhausted":
      return t(($) => $.account_pools.account_cooling);
    case "reserve":
      return t(($) => $.account_pools.account_reserve);
    case "disabled":
      return t(($) => $.account_pools.account_relogin);
    default:
      return t(($) => $.account_pools.account_unknown);
  }
}

function accountStatusClass(status: QuotaAccountState["status"]): string {
  switch (status) {
    case "ok":
      return "bg-success/10 text-success";
    case "exhausted":
      return "bg-destructive/10 text-destructive";
    case "warning":
    case "reserve":
    case "disabled":
      return "bg-warning/10 text-warning";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function AccountPoolBadge({
  pool,
  verbose = false,
}: {
  pool: QuotaAccountPoolState;
  verbose?: boolean;
}) {
  const { t } = useT("quota");
  const relogin = accountPoolNeedsRelogin(pool);
  const tone = relogin || pool.availableAccounts === 0
    ? pool.availableAccounts === 0 && !relogin
      ? "bg-destructive/10 text-destructive"
      : "bg-warning/10 text-warning"
    : pool.availableAccounts < pool.totalAccounts
      ? "bg-warning/10 text-warning"
      : "bg-muted text-muted-foreground";
  return (
    <span
      aria-label={t(($) => $.account_pools.accounts_available_aria, {
        available: pool.availableAccounts,
        total: pool.totalAccounts,
      })}
      className={cn("shrink-0 rounded-full px-1.5 text-micro tabular-nums", tone)}
    >
      {verbose
        ? t(($) => $.account_pools.accounts_available, {
            available: pool.availableAccounts,
            total: pool.totalAccounts,
          })
        : `${pool.availableAccounts}/${pool.totalAccounts}`}
    </span>
  );
}

function AccountPoolBar({
  window,
  interrupted,
  label,
  className,
}: {
  window: QuotaWindowState;
  interrupted: boolean;
  label: string;
  className?: string;
}) {
  if (window.remainingPercent == null) {
    return <span aria-hidden="true" className={cn("block h-1 rounded-full bg-muted", className)} />;
  }
  return (
    <MiniMeterBar
      percent={window.remainingPercent}
      tone={window.tone}
      ariaLabel={label}
      className={className}
      barClassName={interrupted ? MUTED_BAR_CLASS : undefined}
    />
  );
}

function AccountPoolCompactWindow({
  window,
  interrupted,
}: {
  window: QuotaWindowState;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  return (
    <span className="grid grid-cols-[1.25rem_minmax(0,1fr)_2rem] items-center gap-1.5">
      <span className="text-micro text-faint-foreground">{label}</span>
      <AccountPoolBar window={window} interrupted={interrupted} label={label} />
      <span
        className={cn(
          "text-right text-micro tabular-nums",
          interrupted || window.remainingPercent == null
            ? "text-faint-foreground"
            : TONE_TEXT_CLASS[window.tone],
        )}
      >
        {window.remainingPercent == null
          ? "--"
          : `${displayRemainingPercent(window.remainingPercent)}%`}
      </span>
    </span>
  );
}

function AccountPoolStatusLine({
  pool,
  now,
  interrupted,
}: {
  pool: QuotaAccountPoolState;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const recovery = accountPoolRecoveryText(pool, now, t);
  const relogin = pool.exhausted && accountPoolNeedsRelogin(pool);
  if (!recovery && !relogin) return null;
  return (
    <span
      className={cn(
        "text-micro tabular-nums",
        interrupted
          ? "text-faint-foreground"
          : relogin
            ? "text-warning"
            : "text-destructive",
      )}
    >
      {relogin ? t(($) => $.account_pools.pool_needs_relogin) : recovery}
    </span>
  );
}

function accountWindowResetCountdown(
  window: QuotaWindowState,
  now: number,
  t: QuotaT,
): string | null {
  if (window.resetsAt == null) return null;
  return t(($) => $.account_pools.resets_in, {
    time: formatCompactDuration(window.resetsAt * 1000 - now),
  });
}

function AccountPoolTooltipWindow({
  window,
  now,
  interrupted,
}: {
  window: QuotaWindowState;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  const reset = accountWindowResetCountdown(window, now, t);
  return (
    <span className="grid grid-cols-[1.25rem_minmax(3rem,1fr)_2rem_auto] items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <AccountPoolBar window={window} interrupted={interrupted} label={label} />
      <span
        className={cn(
          "text-right tabular-nums",
          interrupted || window.remainingPercent == null
            ? "text-muted-foreground"
            : TONE_TEXT_CLASS[window.tone],
        )}
      >
        {window.remainingPercent == null
          ? "--"
          : `${displayRemainingPercent(window.remainingPercent)}%`}
      </span>
      {reset && <span className="text-right text-micro text-muted-foreground">{reset}</span>}
    </span>
  );
}

function AccountDisabledNote({ account }: { account: QuotaAccountState }) {
  const { t } = useT("quota");
  return (
    <span className="flex items-start gap-1.5 text-micro text-warning">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
      <span>
        {account.note ? `${account.note} · ` : ""}
        {t(($) => $.account_pools.relogin_hint)}
      </span>
    </span>
  );
}

export function AccountPoolTooltip({
  pool,
  now,
  interrupted,
}: {
  pool: QuotaAccountPoolState;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const recovery = accountPoolRecoveryText(pool, now, t);
  return (
    <span className="flex w-full flex-col gap-1 text-left">
      <span className="flex items-center gap-2">
        <span className="font-medium">{accountPoolProviderLabel(pool.id)}</span>
        <span className="ml-auto"><AccountPoolBadge pool={pool} /></span>
      </span>
      <span className="text-micro text-muted-foreground">
        {recovery ?? pool.windows.map((window) => {
          const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
          const value = window.remainingPercent == null
            ? "--"
            : `${displayRemainingPercent(window.remainingPercent)}%`;
          return `${label} ${value}`;
        }).join(" · ")}
      </span>
      {pool.accounts.map((account, index) => (
        <span key={`${account.label}-${index}`} className="flex flex-col gap-1 border-t border-border pt-2">
          <span className="flex items-center gap-2">
            <span className="tabular-nums">#{index + 1} ({account.label})</span>
            <span className={cn("ml-auto rounded-full px-1.5 text-micro", accountStatusClass(account.status))}>
              {accountStatusLabel(account.status, t)}
            </span>
          </span>
          {account.status === "disabled" ? (
            <AccountDisabledNote account={account} />
          ) : (
            account.windows.map((window, windowIndex) => (
              <AccountPoolTooltipWindow
                key={`${window.name}-${windowIndex}`}
                window={window}
                now={now}
                interrupted={interrupted}
              />
            ))
          )}
        </span>
      ))}
    </span>
  );
}

export function IdleAccountPoolsTooltip({
  pools,
}: {
  pools: QuotaAccountPoolState[];
}) {
  const { t } = useT("quota");
  return (
    <span className="flex w-full flex-col gap-1 text-left">
      <span className="font-medium">{t(($) => $.account_pools.idle_title)}</span>
      <span className="text-micro text-muted-foreground">
        {t(($) => $.account_pools.idle_description)}
      </span>
      {pools.map((pool) => {
        const primary = accountPoolPrimaryWindow(pool);
        return (
          <span key={pool.id} className="flex items-center justify-between gap-4 border-t border-border pt-1">
            <span>{accountPoolProviderLabel(pool.id)}</span>
            <span className="text-micro tabular-nums text-muted-foreground">
              {t(($) => $.account_pools.accounts_available, {
                available: pool.availableAccounts,
                total: pool.totalAccounts,
              })}
              {primary?.remainingPercent != null &&
                ` · ${formatQuotaWindowLabel(primary.windowMinutes, t) ?? primary.name} ${displayRemainingPercent(primary.remainingPercent)}%`}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function AccountPoolMachineChip({
  pool,
  interrupted,
}: {
  pool: QuotaAccountPoolState;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const primary = accountPoolPrimaryWindow(pool);
  const relogin = accountPoolNeedsRelogin(pool);
  const value = relogin
    ? t(($) => $.account_pools.pool_needs_relogin)
    : pool.exhausted
      ? t(($) => $.exhausted)
      : primary?.remainingPercent == null
        ? t(($) => $.unknown)
        : `${displayRemainingPercent(primary.remainingPercent)}%`;
  const toneClass = interrupted
    ? "bg-muted text-muted-foreground"
    : relogin
      ? "bg-warning/10 text-warning"
      : pool.tone === "destructive"
        ? "bg-destructive/10 text-destructive"
        : pool.tone === "warning"
          ? "bg-warning/10 text-warning"
          : "bg-success/10 text-success";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-micro font-medium tabular-nums", toneClass)}>
      <ProviderLogo provider={accountPoolLogoProvider(pool.id)} className="size-3.5" />
      <span>{accountPoolProviderLabel(pool.id)}</span>
      <span>{value}</span>
      <AccountPoolBadge pool={pool} />
      {interrupted && <span className="font-normal"> · {t(($) => $.collection_interrupted)}</span>}
    </span>
  );
}

function AccountPoolQuotaList({
  summary,
  agents,
  runtimeId,
  now,
  interrupted,
}: {
  summary: PlanQuotaPoolsSummary;
  agents: Agent[];
  runtimeId: string;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const partition = partitionAccountPools(summary.pools, agents, runtimeId);
  return (
    <>
      {partition.serving.map((pool, index) => (
        <Tooltip key={pool.id}>
          <TooltipTrigger
            closeOnClick={false}
            render={
              <span
                tabIndex={0}
                data-account-pool={pool.id}
                aria-label={accountPoolAriaLabel(pool, t)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  index > 0 && "border-t border-border pt-1.5",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-micro font-medium">
                    {accountPoolProviderLabel(pool.id)}
                  </span>
                  <span className="ml-auto"><AccountPoolBadge pool={pool} /></span>
                </span>
                {pool.windows.map((window, windowIndex) => (
                  <AccountPoolCompactWindow
                    key={`${window.name}-${windowIndex}`}
                    window={window}
                    interrupted={interrupted}
                  />
                ))}
                <AccountPoolStatusLine pool={pool} now={now} interrupted={interrupted} />
              </span>
            }
          />
          <TooltipContent className="w-80 max-w-[calc(100vw-2rem)] p-3">
            <AccountPoolTooltip pool={pool} now={now} interrupted={interrupted} />
          </TooltipContent>
        </Tooltip>
      ))}
      {partition.idle.length > 0 && (
        <Tooltip>
          <TooltipTrigger
            closeOnClick={false}
            render={
              <span
                tabIndex={0}
                aria-label={t(($) => $.account_pools.idle_count, { count: partition.idle.length })}
                className="w-fit border-b border-dotted border-faint-foreground text-micro text-faint-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t(($) => $.account_pools.idle_count, { count: partition.idle.length })}
              </span>
            }
          />
          <TooltipContent className="w-72 max-w-[calc(100vw-2rem)] p-3">
            <IdleAccountPoolsTooltip pools={partition.idle} />
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function AccountPoolDetailWindow({
  window,
  now,
  interrupted,
}: {
  window: QuotaWindowState | null;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  if (!window) return <span className="text-faint-foreground">--</span>;
  const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  const reset = accountWindowResetCountdown(window, now, t);
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2">
        <AccountPoolBar window={window} interrupted={interrupted} label={label} className="min-w-0 flex-1" />
        <span
          className={cn(
            "w-9 shrink-0 text-right text-caption tabular-nums",
            interrupted || window.remainingPercent == null
              ? "text-faint-foreground"
              : TONE_TEXT_CLASS[window.tone],
          )}
        >
          {window.remainingPercent == null
            ? "--"
            : `${displayRemainingPercent(window.remainingPercent)}%`}
        </span>
      </span>
      {reset && <span className="text-micro tabular-nums text-faint-foreground">{reset}</span>}
    </span>
  );
}

function AccountPoolMatrixCard({
  pool,
  now,
  interrupted,
  serving,
  collapsible,
  open,
  onToggle,
}: {
  pool: QuotaAccountPoolState;
  now: number;
  interrupted: boolean;
  serving: boolean;
  collapsible: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useT("quota");
  const provider = accountPoolProviderLabel(pool.id);
  const recovery = accountPoolRecoveryText(pool, now, t);
  const relogin = accountPoolNeedsRelogin(pool);
  const primary = accountPoolPrimaryWindow(pool);
  const name = (
    <span className="flex min-w-0 items-center gap-2">
      <ProviderLogo provider={accountPoolLogoProvider(pool.id)} className="size-4 shrink-0" />
      <span className="truncate text-caption font-medium">{provider}</span>
    </span>
  );
  return (
    <div data-account-pool-matrix={pool.id} className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={t(($) => $.account_pools.toggle_pool, { provider })}
            onClick={onToggle}
            className="flex min-w-0 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
            {name}
          </button>
        ) : name}
        {serving && (
          <span className="rounded-full bg-success/10 px-1.5 text-micro text-success">
            {t(($) => $.account_pools.serving)}
          </span>
        )}
        {collapsible && (
          <span className="rounded-full bg-muted px-1.5 text-micro text-muted-foreground">
            {t(($) => $.account_pools.idle)}
          </span>
        )}
        <AccountPoolBadge pool={pool} verbose />
        {pool.disabledAccounts > 0 && (
          <span className="rounded-full bg-warning/10 px-1.5 text-micro text-warning">
            {t(($) => $.account_pools.pool_needs_relogin)}
          </span>
        )}
        {recovery && <span className="text-micro tabular-nums text-destructive">{recovery}</span>}
        <span className="ml-auto flex items-center gap-2 text-micro tabular-nums text-muted-foreground">
          {pool.windows.map((window, index) => (
            <span key={`${window.name}-${index}`}>
              {formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name}{" "}
              <span className={cn(interrupted ? "text-faint-foreground" : TONE_TEXT_CLASS[window.tone])}>
                {window.remainingPercent == null ? "--" : `${displayRemainingPercent(window.remainingPercent)}%`}
              </span>
            </span>
          ))}
          {primary?.remainingPercent != null && (
            <AccountPoolBar
              window={primary}
              interrupted={interrupted}
              label={provider}
              className="w-16 shrink-0"
            />
          )}
        </span>
      </div>
      {open && (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[30rem] text-left text-caption">
            <thead className="bg-muted/50 text-micro text-faint-foreground">
              <tr>
                <th className="px-3 py-1.5 font-normal">{t(($) => $.account_pools.account_redacted)}</th>
                <th className="px-3 py-1.5 font-normal">{t(($) => $.account_pools.status)}</th>
                <th className="px-3 py-1.5 font-normal">{t(($) => $.account_pools.window_5h)}</th>
                <th className="px-3 py-1.5 font-normal">{t(($) => $.account_pools.window_7d)}</th>
              </tr>
            </thead>
            <tbody>
              {pool.accounts.map((account, index) => {
                const disabled = account.status === "disabled";
                return (
                  <AccountPoolAccountRows
                    key={`${account.label}-${index}`}
                    account={account}
                    index={index}
                    now={now}
                    interrupted={interrupted}
                    disabled={disabled}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && pool.exhausted && !relogin && (
        <p className="flex items-start gap-1.5 border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-caption text-destructive">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t(($) => $.account_pools.pool_all_unavailable)}
        </p>
      )}
    </div>
  );
}

function AccountPoolAccountRows({
  account,
  index,
  now,
  interrupted,
  disabled,
}: {
  account: QuotaAccountState;
  index: number;
  now: number;
  interrupted: boolean;
  disabled: boolean;
}) {
  const { t } = useT("quota");
  const windowAt = (minutes: number) => account.windows.find((window) => window.windowMinutes === minutes) ?? null;
  return (
    <>
      <tr className="border-t border-border first:border-t-0">
        <td className="px-3 py-2 whitespace-nowrap tabular-nums">
          #{index + 1} <span className="text-muted-foreground">({account.label})</span>
        </td>
        <td className="px-3 py-2">
          <span className={cn("inline-flex rounded-full px-1.5 text-micro", accountStatusClass(account.status))}>
            {accountStatusLabel(account.status, t)}
          </span>
        </td>
        <td className="px-3 py-2">
          {disabled ? "--" : <AccountPoolDetailWindow window={windowAt(300)} now={now} interrupted={interrupted} />}
        </td>
        <td className="px-3 py-2">
          {disabled ? "--" : <AccountPoolDetailWindow window={windowAt(10080)} now={now} interrupted={interrupted} />}
        </td>
      </tr>
      {disabled && (
        <tr className="border-t border-warning/20 bg-warning/5">
          <td colSpan={4} className="px-3 py-2"><AccountDisabledNote account={account} /></td>
        </tr>
      )}
    </>
  );
}

function AccountPoolQuotaMatrix({
  summary,
  agents,
  runtimeId,
  now,
  interrupted,
}: {
  summary: PlanQuotaPoolsSummary;
  agents: Agent[];
  runtimeId: string;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const partition = partitionAccountPools(summary.pools, agents, runtimeId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandAll, setExpandAll] = useState(false);
  const toggle = (poolId: string) => {
    if (expandAll) {
      setExpandAll(false);
      setExpanded(new Set(partition.idle.filter((pool) => pool.id !== poolId).map((pool) => pool.id)));
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(poolId)) next.delete(poolId);
      else next.add(poolId);
      return next;
    });
  };
  return (
    <div className="space-y-2">
      {partition.serving.map((pool) => (
        <AccountPoolMatrixCard
          key={pool.id}
          pool={pool}
          now={now}
          interrupted={interrupted}
          serving={partition.filtered}
          collapsible={false}
          open
          onToggle={() => {}}
        />
      ))}
      {partition.idle.length > 0 && (
        <>
          <div className="flex items-center justify-between pt-2">
            <span className="text-caption text-muted-foreground">
              {t(($) => $.account_pools.idle_title)}
            </span>
            <button
              type="button"
              className="rounded-sm text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                if (expandAll) setExpanded(new Set());
                setExpandAll((current) => !current);
              }}
            >
              {expandAll
                ? t(($) => $.account_pools.collapse_all)
                : t(($) => $.account_pools.expand_all)}
            </button>
          </div>
          {partition.idle.map((pool) => (
            <AccountPoolMatrixCard
              key={pool.id}
              pool={pool}
              now={now}
              interrupted={interrupted}
              serving={false}
              collapsible
              open={expandAll || expanded.has(pool.id)}
              onToggle={() => toggle(pool.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

// The runtime settings page's full quota card, between the hero card and
// the usage section. Same rules as the list cell, with each window's own
// reset and the snapshot age in the footer.
export function RuntimeQuotaCard({
  runtime,
  now,
  agents = [],
  thinkingAdapt = runtime.thinking_adapt ?? null,
}: {
  runtime: AgentRuntime;
  now: number;
  agents?: Agent[];
  thinkingAdapt?: RuntimeThinkingAdapt | null;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  const accountPools = evaluateRuntimeAccountPools(runtime, now);
  if (state && accountPools) {
    return (
      <section className="rounded-lg border bg-card">
        <h3 className="border-b px-4 py-2.5 text-caption font-semibold">
          {t(($) => $.title)}
        </h3>
        <div className="space-y-3 p-4">
          <AccountPoolQuotaMatrix
            summary={accountPools}
            agents={agents}
            runtimeId={runtime.id}
            now={now}
            interrupted={state.interrupted}
          />
          {thinkingAdapt && <ThinkingAdaptQuotaRow snapshot={thinkingAdapt} />}
          <p className="text-micro tabular-nums text-faint-foreground">
            {state.interrupted
              ? quotaInterruptedText(state.observedAt, now, t, formatTime)
              : t(($) => $.observed_ago, {
                  time: formatCompactDuration(now - state.observedAt * 1000),
                })}
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="rounded-lg border bg-card">
      <h3 className="border-b px-4 py-2.5 text-caption font-semibold">
        {t(($) => $.title)}
      </h3>
      <div className="space-y-3 p-4">
        {state == null ? (
          thinkingAdapt ? (
            <>
              <p className="text-caption text-faint-foreground">
                {t(($) => $.not_reported)}
              </p>
              <ThinkingAdaptQuotaRow snapshot={thinkingAdapt} />
            </>
          ) : (
            <p className="text-caption text-faint-foreground">
              {t(($) => $.not_reported)}
            </p>
          )
        ) : (
          <>
            {/* A limit that names no window belongs to no pool. */}
            {state.unattributedLimit && (
              <p
                className={cn(
                  "text-micro tabular-nums",
                  state.interrupted ? "text-faint-foreground" : "text-destructive",
                )}
              >
                {quotaStatusText(state.summary, now, t, formatTime)}
              </p>
            )}
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
            {thinkingAdapt && <ThinkingAdaptQuotaRow snapshot={thinkingAdapt} />}
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
