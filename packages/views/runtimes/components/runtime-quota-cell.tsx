"use client";

import type { ReactElement } from "react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import {
  ProgressIndicator,
  ProgressTrack,
} from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@multica/ui/components/ui/hover-card";
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
  servingAccountPoolProviders,
} from "./account-pool-filter";
import { runtimeRowLabel } from "./runtime-machines";

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

function quotaValueClass(tone: QuotaTone, interrupted: boolean): string {
  if (interrupted) return "text-faint-foreground";
  return tone === "ok" ? "text-foreground" : TONE_TEXT_CLASS[tone];
}

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
  trackClassName,
}: {
  percent: number;
  tone: QuotaTone;
  ariaLabel: string;
  className?: string;
  barClassName?: string;
  trackClassName?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <ProgressPrimitive.Root
      value={value}
      aria-label={ariaLabel}
      className={cn("block", className)}
    >
      <ProgressTrack className={cn("h-1", trackClassName)}>
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

function QuotaWindowRow({
  window,
  interrupted,
}: {
  window: QuotaWindowState;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  let label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  if (window.group != null && (label === window.group || label === quotaGroupLabel(window.group, t))) {
    label = "";
  }
  const valueText = window.exhausted
    ? t(($) => $.window_exhausted)
    : quotaWindowValueText(window, t);
  const showBar = window.remainingPercent != null && !window.notApplicable;
  return (
    <span className="flex items-center gap-1.5">
      {label !== "" && (
        <span className="w-6 shrink-0 truncate text-micro text-muted-foreground">
          {label}
        </span>
      )}
      {showBar && window.remainingPercent != null && (
        <MiniMeterBar
          percent={window.remainingPercent}
          tone={window.tone}
          ariaLabel={label}
          className="w-8 shrink-0"
          barClassName={interrupted ? MUTED_BAR_CLASS : undefined}
        />
      )}
      <span
        className={cn(
          "text-micro tabular-nums",
          window.notApplicable || (window.remainingPercent == null && !window.exhausted)
            ? "text-faint-foreground"
            : quotaValueClass(window.tone, interrupted),
        )}
      >
        {valueText ?? `${displayRemainingPercent(window.remainingPercent ?? 0)}%`}
      </span>
    </span>
  );
}

// The RuntimeList quota column cell: one quota subject per row, with all of
// its windows flowing horizontally. The whole subject opens the shared card.
export function RuntimeQuotaCell({
  runtime,
  now,
  agents = [],
  machineName,
}: {
  runtime: AgentRuntime;
  now: number;
  agents?: Agent[];
  machineName?: string;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  const accountPools = evaluateRuntimeAccountPools(runtime, now);

  if (!state) {
    return (
      <span className="text-caption text-faint-foreground">
        {t(($) => $.no_snapshot)}
      </span>
    );
  }
  if (accountPools) {
    return (
      <div className="flex w-full flex-col gap-1.5 leading-tight">
        <AccountPoolQuotaList
          summary={accountPools}
          agents={agents}
          runtime={runtime}
          machineName={machineName}
          now={now}
          interrupted={state.interrupted}
        />
        {state.interrupted && (
          <span className="text-micro tabular-nums text-faint-foreground">
            {quotaInterruptedText(state.observedAt, now, t, formatTime)}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-1.5 leading-tight">
      {state.pools.map((pool) => (
        <QuotaHoverCard
          key={pool.group ?? "ungrouped"}
          runtime={runtime}
          machineName={machineName}
          now={now}
          group={pool.group}
          trigger={
            <span
              tabIndex={0}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {pool.group != null && (
                <span className="text-micro text-muted-foreground">
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
            </span>
          }
        />
      ))}
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

function AccountPoolBadge({ pool }: { pool: QuotaAccountPoolState }) {
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
      {pool.availableAccounts}/{pool.totalAccounts}
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
  const reset = window.resetsAt == null
    ? null
    : window.exhausted
      ? t(($) => $.account_pools.recovers_in, {
          time: formatCompactDuration(window.resetsAt * 1000 - now),
        })
      : accountWindowResetCountdown(window, now, t);
  const value = window.exhausted
    ? t(($) => $.window_exhausted)
    : window.notApplicable || window.remainingPercent == null
      ? quotaWindowValueText(window, t) ?? "--"
      : `${displayRemainingPercent(window.remainingPercent)}%`;
  return (
    <span className="grid grid-cols-[1.25rem_minmax(3rem,1fr)_2.25rem_auto] items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <AccountPoolBar window={window} interrupted={interrupted} label={label} />
      <span
        className={cn(
          "text-right tabular-nums",
          window.notApplicable || (window.remainingPercent == null && !window.exhausted)
            ? "text-muted-foreground"
            : quotaValueClass(window.tone, interrupted),
        )}
      >
        {value}
      </span>
      {reset && <span className="text-right text-micro text-muted-foreground">{reset}</span>}
    </span>
  );
}

function accountWindowFor(
  account: QuotaAccountState,
  template: QuotaWindowState,
): QuotaWindowState | null {
  return account.windows.find((window) =>
    template.windowMinutes != null
      ? window.windowMinutes === template.windowMinutes
      : window.name === template.name
  ) ?? null;
}

function AccountPoolAccountsTable({
  pool,
  interrupted,
  limit,
}: {
  pool: QuotaAccountPoolState;
  interrupted: boolean;
  limit?: number;
}) {
  const { t } = useT("quota");
  const accounts = limit == null ? pool.accounts : pool.accounts.slice(0, limit);
  const hidden = pool.accounts.length - accounts.length;
  return (
    <>
      <table className="w-full text-left text-caption">
        <thead className="text-micro text-faint-foreground">
          <tr>
            <th className="py-1 pr-2 font-normal">{t(($) => $.account_pools.account)}</th>
            {pool.windows.map((window, index) => (
              <th key={`${window.name}-${index}`} className="w-12 px-2 py-1 text-right font-normal">
                {formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {accounts.map((account, index) => {
            const disabled = account.status === "disabled";
            return (
              <tr key={`${account.label}-${index}`} className="border-t border-border/60">
                <td className="max-w-0 py-1.5 pr-2">
                  <span className="flex min-w-0 items-center truncate tabular-nums">
                    <span className="truncate">#{index + 1} ({account.label})</span>
                    {account.status === "reserve" && (
                      <span className="shrink-0 text-faint-foreground">
                        {" · "}{t(($) => $.account_pools.idle)}
                      </span>
                    )}
                  </span>
                </td>
                {disabled ? (
                  <td
                    colSpan={Math.max(pool.windows.length, 1)}
                    className="px-2 py-1.5 text-right text-warning"
                  >
                    {t(($) => $.account_pools.account_relogin)}
                  </td>
                ) : (
                  pool.windows.map((template, windowIndex) => {
                    const window = accountWindowFor(account, template);
                    return (
                      <td
                        key={`${template.name}-${windowIndex}`}
                        className={cn(
                          "px-2 py-1.5 text-right tabular-nums",
                          window?.remainingPercent != null
                            ? quotaValueClass(window.tone, interrupted)
                            : "text-faint-foreground",
                        )}
                      >
                        {window?.remainingPercent == null
                          ? "--"
                          : `${displayRemainingPercent(window.remainingPercent)}%`}
                      </td>
                    );
                  })
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {hidden > 0 && (
        <p className="pt-1.5 text-micro text-faint-foreground">
          {t(($) => $.account_pools.more_accounts, { count: hidden })}
        </p>
      )}
    </>
  );
}

export function QuotaHoverCard({
  runtime,
  machineName,
  now,
  group = null,
  pool = null,
  trigger,
}: {
  runtime: AgentRuntime;
  machineName?: string;
  now: number;
  group?: string | null;
  pool?: QuotaAccountPoolState | null;
  trigger: ReactElement;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={120} closeDelay={140} render={trigger} />
      <HoverCardContent align="start" className="w-85 max-w-[calc(100vw-1rem)] p-3">
        <QuotaHoverCardBody
          runtime={runtime}
          machineName={machineName}
          now={now}
          group={group}
          pool={pool}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

function QuotaHoverCardBody({
  runtime,
  machineName,
  now,
  group,
  pool,
}: {
  runtime: AgentRuntime;
  machineName?: string;
  now: number;
  group: string | null;
  pool: QuotaAccountPoolState | null;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  const runtimeLabel = runtimeRowLabel(runtime, machineName ?? "");
  const interrupted = state?.interrupted ?? false;
  const pools = group == null
    ? state?.pools ?? []
    : state?.pools.filter((item) => item.group === group) ?? [];
  const windows = pool?.windows ?? pools.flatMap((item) => item.windows);
  const title = pool
    ? `${accountPoolProviderLabel(pool.id)} ${t(($) => $.account_pools.pool_suffix)}`
    : group != null
      ? `${runtimeLabel} / ${quotaGroupLabel(group, t)}`
      : runtimeLabel;
  const source = state?.source === "external"
    ? t(($) => $.source_external)
    : t(($) => $.source_daemon);
  const freshness = state == null
    ? null
    : interrupted
      ? quotaInterruptedText(state.observedAt, now, t, formatTime)
      : `${source} · ${t(($) => $.observed_ago, {
          time: formatCompactDuration(now - state.observedAt * 1000),
        })}`;
  const relogin = pool != null && accountPoolNeedsRelogin(pool);

  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <ProviderLogo
            provider={pool ? accountPoolLogoProvider(pool.id) : state?.provider || runtime.provider}
            className="size-3.5 shrink-0"
          />
          <span className="truncate">
            {runtimeLabel}{machineName ? ` · ${machineName}` : ""}
          </span>
        </span>
        {freshness && (
          <span className={cn("shrink-0", interrupted && "text-warning")}>{freshness}</span>
        )}
      </div>
      <div className="flex items-baseline gap-2 text-body font-medium">
        <span className="min-w-0 truncate">{title}</span>
        {pool && !relogin && (
          <span className="shrink-0 text-caption font-normal text-muted-foreground">
            {t(($) => $.account_pools.accounts_available, {
              available: pool.availableAccounts,
              total: pool.totalAccounts,
            })}
          </span>
        )}
      </div>
      {relogin ? (
        <div className="-mx-3 border-t border-border px-3 pt-2.5 text-caption text-warning">
          {t(($) => $.account_pools.all_relogin)}
        </div>
      ) : !state || windows.length === 0 ? (
        <p className="text-caption text-faint-foreground">{t(($) => $.no_snapshot)}</p>
      ) : (
        <>
          <div className="-mx-3 border-t border-border px-3 pt-2.5">
            <div className="flex flex-col gap-2 text-caption">
              {windows.map((window, index) => (
                <AccountPoolTooltipWindow
                  key={`${window.name}-${index}`}
                  window={window}
                  now={now}
                  interrupted={interrupted}
                />
              ))}
            </div>
          </div>
          {pool && pool.accounts.length > 0 && (
            <div className="-mx-3 border-t border-border px-3 pt-2">
              <AccountPoolAccountsTable pool={pool} interrupted={interrupted} limit={4} />
            </div>
          )}
        </>
      )}
    </div>
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
    : pool.windows.length === 0
      ? t(($) => $.no_snapshot_chip)
      : pool.exhausted
        ? t(($) => $.exhausted)
        : primary?.remainingPercent == null
          ? t(($) => $.unknown)
          : `${displayRemainingPercent(primary.remainingPercent)}%`;
  const toneClass = interrupted
    ? "bg-muted text-muted-foreground"
    : relogin
      ? "bg-warning/10 text-warning"
      : pool.windows.length === 0
        ? "bg-muted text-muted-foreground"
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
  runtime,
  machineName,
  now,
  interrupted,
}: {
  summary: PlanQuotaPoolsSummary;
  agents: Agent[];
  runtime: AgentRuntime;
  machineName?: string;
  now: number;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  const partition = partitionAccountPools(summary.pools, agents, runtime.id);
  return (
    <>
      {partition.serving.map((pool) => (
        <QuotaHoverCard
          key={pool.id}
          runtime={runtime}
          machineName={machineName}
          now={now}
          pool={pool}
          trigger={
            <span
              tabIndex={0}
              data-account-pool={pool.id}
              aria-label={accountPoolAriaLabel(pool, t)}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="shrink-0 text-micro text-muted-foreground">
                {accountPoolProviderLabel(pool.id)}{" "}
                <span className="text-faint-foreground">
                  {pool.availableAccounts}/{pool.totalAccounts}
                </span>
              </span>
              {accountPoolNeedsRelogin(pool) ? (
                <span className="text-micro text-warning">
                  {t(($) => $.account_pools.pool_needs_relogin)}
                </span>
              ) : pool.windows.length === 0 ? (
                <span className="text-caption text-faint-foreground">
                  {t(($) => $.no_snapshot)}
                </span>
              ) : (
                pool.windows.map((window, windowIndex) => (
                  <QuotaWindowRow
                    key={`${window.name}-${windowIndex}`}
                    window={window}
                    interrupted={interrupted}
                  />
                ))
              )}
            </span>
          }
        />
      ))}
    </>
  );
}

function AccountPoolQuotaSubject({
  pool,
  now,
  interrupted,
  serving,
}: {
  pool: QuotaAccountPoolState;
  now: number;
  interrupted: boolean;
  serving: boolean;
}) {
  const { t } = useT("quota");
  const recovery = accountPoolRecoveryText(pool, now, t);
  const relogin = accountPoolNeedsRelogin(pool);
  return (
    <div data-account-pool-matrix={pool.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-caption font-medium">
          {accountPoolProviderLabel(pool.id)}
          {!serving && (
            <span className="font-normal text-faint-foreground">
              {" · "}{t(($) => $.account_pools.unused)}
            </span>
          )}
        </p>
        <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
          {t(($) => $.account_pools.accounts_available, {
            available: pool.availableAccounts,
            total: pool.totalAccounts,
          })}
        </span>
      </div>
      {relogin ? (
        <p className="text-caption text-warning">{t(($) => $.account_pools.all_relogin)}</p>
      ) : pool.windows.length === 0 ? (
        <p className="text-caption text-faint-foreground">{t(($) => $.no_snapshot)}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            {pool.windows.map((window, index) => (
              <QuotaCardWindow
                key={`${window.name}-${index}`}
                window={window}
                now={now}
                interrupted={interrupted}
              />
            ))}
          </div>
          {recovery && (
            <p className={cn("text-micro tabular-nums", interrupted ? "text-faint-foreground" : "text-destructive")}>
              {recovery}
            </p>
          )}
          {pool.accounts.length > 0 && pool.windows.length > 0 && (
            <AccountPoolAccountsTable pool={pool} interrupted={interrupted} />
          )}
        </>
      )}
    </div>
  );
}

// The runtime settings page's full quota card, between the hero card and
// the usage section. CLI and account-pool subjects share the same sections,
// two-column window grid, resets, and snapshot footer.
export function RuntimeQuotaCard({
  runtime,
  now,
  agents = [],
}: {
  runtime: AgentRuntime;
  now: number;
  agents?: Agent[];
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  const accountPools = evaluateRuntimeAccountPools(runtime, now);
  const partition = accountPools
    ? partitionAccountPools(accountPools.pools, agents, runtime.id)
    : null;
  const servingProviders = accountPools
    ? servingAccountPoolProviders(agents, runtime.id)
    : null;

  return (
    <section className="rounded-lg border bg-card">
      <h3 className="border-b px-4 py-2.5 text-caption font-semibold">
        {t(($) => $.title)}
      </h3>
      <div className="p-4">
        {!state ? (
          <p className="text-caption text-faint-foreground">{t(($) => $.no_snapshot)}</p>
        ) : (
          <>
            <div className="divide-y divide-border">
              {accountPools && partition
                ? partition.all.map((pool) => (
                    <AccountPoolQuotaSubject
                      key={pool.id}
                      pool={pool}
                      now={now}
                      interrupted={state.interrupted}
                      serving={servingProviders?.has(pool.id) ?? false}
                    />
                  ))
                : state.pools.map((pool) => (
                    <div key={pool.group ?? "ungrouped"} className="py-4 first:pt-0 last:pb-0">
                      <div className="grid grid-cols-2 gap-x-8 gap-y-3">
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
                  ))}
            </div>
            {state.unattributedLimit && (
              <p
                className={cn(
                  "pt-3 text-micro tabular-nums",
                  state.interrupted ? "text-faint-foreground" : "text-destructive",
                )}
              >
                {quotaStatusText(state.summary, now, t, formatTime)}
              </p>
            )}
            <p className="pt-3 text-micro tabular-nums text-faint-foreground">
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

export function ThinkingAdaptQuotaCard({ snapshot }: { snapshot: RuntimeThinkingAdapt }) {
  const { t } = useT("quota");
  const { t: tf } = useT("fork-ui");
  return (
    <section className="rounded-lg border bg-card">
      <h3 className="border-b px-4 py-2.5 text-caption font-semibold">
        {tf(($) => $.agents.thinking_adapt.label)}
      </h3>
      <div className="space-y-2 p-4">
        <ThinkingAdaptQuotaRow snapshot={snapshot} />
        <p className="text-micro text-faint-foreground">
          {t(($) => $.thinking_adapt.counts, {
            success: snapshot.decisions_ok ?? 0,
            fallback: snapshot.decisions_fallback ?? 0,
          })}
        </p>
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
  const windowLabel = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  const label = window.group != null
    ? `${quotaGroupLabel(window.group, t)} · ${windowLabel}`
    : windowLabel;
  const valueText = window.exhausted
    ? t(($) => $.window_exhausted)
    : quotaWindowValueText(window, t);
  const reset = window.resetsAt != null && window.exhausted
    ? t(($) => $.account_pools.recovers_in, {
        time: formatCompactDuration(window.resetsAt * 1000 - now),
      })
    : quotaWindowResetText(window, now, t, formatTime);
  const showBar = window.remainingPercent != null && !window.notApplicable;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption text-muted-foreground">
          {t(($) => $.window_label, { label })}
        </span>
        <span
          className={cn(
            "text-caption tabular-nums",
            window.notApplicable || (window.remainingPercent == null && !window.exhausted)
              ? "text-faint-foreground"
              : quotaValueClass(window.tone, interrupted),
          )}
        >
          {valueText ?? `${displayRemainingPercent(window.remainingPercent ?? 0)}%`}
        </span>
      </div>
      {showBar && window.remainingPercent != null && (
        <MiniMeterBar
          percent={window.remainingPercent}
          tone={window.tone}
          ariaLabel={label}
          trackClassName="h-1.5"
          barClassName={interrupted ? MUTED_BAR_CLASS : undefined}
        />
      )}
      {reset != null && (
        <p className="text-micro tabular-nums text-faint-foreground">{reset}</p>
      )}
    </div>
  );
}
