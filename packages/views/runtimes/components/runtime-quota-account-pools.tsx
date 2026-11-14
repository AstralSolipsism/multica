"use client";

import type { ReactElement } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@multica/ui/components/ui/hover-card";
import { cn } from "@multica/ui/lib/utils";
import {
  formatCompactDuration,
  planQuotaState,
  type PlanQuotaPoolsSummary,
  type QuotaAccountPoolState,
  type QuotaAccountState,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import type { Agent, AgentRuntime } from "@multica/core/types";
import { useT } from "../../i18n";
import { useQuotaTimeFormatter } from "./quota-time";
import { ProviderLogo } from "./provider-logo";
import {
  accountPoolLogoProvider,
  accountPoolNeedsRelogin,
  accountPoolProviderLabel,
  partitionAccountPools,
} from "./account-pool-filter";
import { runtimeRowLabel } from "./runtime-machines";
import {
  displayRemainingPercent,
  formatQuotaWindowLabel,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
  quotaInterruptedText,
  quotaValueClass,
  quotaWindowValueText,
  type QuotaT,
} from "./runtime-quota-utils";
import { MiniMeterBar, QuotaWindowRow } from "./runtime-quota-window";

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

export function AccountPoolAccountsTable({
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

export function AccountPoolQuotaList({
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
