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
  type QuotaAccountPoolState,
  type QuotaAccountState,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import type { Agent, AgentRuntime } from "@multica/core/types";
import { useT } from "../../i18n";
import { useQuotaTimeFormatter } from "./quota-time";
import { ProviderLogo } from "./provider-logo";
import {
  accountPoolNeedsRelogin,
  accountPoolProviderLabel,
  partitionAccountPools,
  type AccountPoolPartition,
} from "./account-pool-filter";
import { runtimeRowLabel } from "./runtime-machines";
import {
  accountPoolRecoveryText,
  displayRemainingPercent,
  evaluateRuntimeAccountPools,
  formatQuotaWindowLabel,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
  quotaInterruptedText,
  quotaValueClass,
  quotaWindowResetText,
  quotaWindowValueText,
  type QuotaT,
} from "./runtime-quota-utils";
import { MiniMeterBar, QuotaWindowRow } from "./runtime-quota-window";

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

function AccountPoolTooltipWindow({
  window,
  now,
  interrupted,
  showReset = true,
}: {
  window: QuotaWindowState;
  now: number;
  interrupted: boolean;
  /** False for a multi-account pool's aggregated row: one merged reset would
   *  read as the pool's own reset. Each account's resets live in its table
   *  row instead. */
  showReset?: boolean;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  const reset = quotaWindowResetText(window, now, t, formatTime);
  const value = window.exhausted
    ? t(($) => $.window_exhausted)
    : window.notApplicable || window.remainingPercent == null
      ? quotaWindowValueText(window, t) ?? "--"
      : `${displayRemainingPercent(window.remainingPercent)}%`;
  return (
    <span
      data-pool-window
      className="grid grid-cols-[minmax(1.75rem,auto)_minmax(3rem,1fr)_auto] items-center gap-1.5"
    >
      <span className="min-w-0 max-w-20 truncate whitespace-nowrap text-muted-foreground">{label}</span>
      <AccountPoolBar window={window} interrupted={interrupted} label={label} />
      <span className="flex flex-wrap items-center justify-end gap-x-2 text-right">
        <span
          className={cn(
            "whitespace-nowrap tabular-nums",
            window.notApplicable || (window.remainingPercent == null && !window.exhausted)
              ? "text-muted-foreground"
              : quotaValueClass(window.tone, interrupted),
          )}
        >
          {value}
        </span>
        {showReset && reset && (
          <span className="whitespace-nowrap text-micro text-muted-foreground">{reset}</span>
        )}
      </span>
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
  now,
  limit,
}: {
  pool: QuotaAccountPoolState;
  interrupted: boolean;
  now: number;
  limit?: number;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const accounts = limit == null ? pool.accounts : pool.accounts.slice(0, limit);
  const hidden = pool.accounts.length - accounts.length;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-caption">
          <thead className="text-micro text-faint-foreground">
            <tr>
              <th className="py-1 pr-2 font-normal">{t(($) => $.account_pools.account)}</th>
              {pool.windows.map((window, index) => (
                <th key={`${window.name}-${index}`} className="min-w-12 whitespace-nowrap px-2 py-1 text-right font-normal">
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
                  <td className="max-w-0 min-w-24 py-1.5 pr-2">
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
                      const reset = window == null
                        ? null
                        : quotaWindowResetText(window, now, t, formatTime);
                      return (
                        <td
                          key={`${template.name}-${windowIndex}`}
                          className="px-2 py-1.5 text-right align-top tabular-nums"
                        >
                          <span
                            className={cn(
                              "block whitespace-nowrap",
                              window?.remainingPercent != null
                                ? quotaValueClass(window.tone, interrupted)
                                : "text-faint-foreground",
                            )}
                          >
                            {window?.remainingPercent == null
                              ? "--"
                              : `${displayRemainingPercent(window.remainingPercent)}%`}
                          </span>
                          {reset && (
                            <span className="mt-0.5 block whitespace-nowrap text-micro text-faint-foreground">
                              {reset}
                            </span>
                          )}
                        </td>
                      );
                    })
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
  agents = [],
  trigger,
}: {
  runtime: AgentRuntime;
  machineName?: string;
  now: number;
  agents?: Agent[];
  trigger: ReactElement;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={120} closeDelay={140} render={trigger} />
      <HoverCardContent align="start" className="w-96 max-w-[calc(100vw-1rem)] p-3">
        <QuotaHoverCardBody
          runtime={runtime}
          machineName={machineName}
          now={now}
          agents={agents}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

function QuotaHoverCardBody({
  runtime,
  machineName,
  now,
  agents,
}: {
  runtime: AgentRuntime;
  machineName?: string;
  now: number;
  agents: Agent[];
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  const accountPools = evaluateRuntimeAccountPools(runtime, now);
  const partition = accountPools
    ? partitionAccountPools(accountPools.pools, agents, runtime.id)
    : null;
  const runtimeLabel = runtimeRowLabel(runtime, machineName ?? "");
  const interrupted = state?.interrupted ?? false;
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

  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <ProviderLogo
            provider={state?.provider || runtime.provider}
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
      {!state ? null : accountPools && partition ? (
        <div className="-mx-3 flex flex-col gap-3 border-t border-border px-3 pt-2.5">
          {partition.serving.map((pool) => {
            const relogin = accountPoolNeedsRelogin(pool);
            const recovery = accountPoolRecoveryText(pool, now, t, formatTime);
            return (
              <section key={pool.id} data-hover-account-pool={pool.id} className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="text-body font-medium">{accountPoolProviderLabel(pool.id)}</h4>
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {t(($) => $.account_pools.accounts_available, {
                      available: pool.availableAccounts,
                      total: pool.totalAccounts,
                    })}
                  </span>
                </div>
                {relogin ? (
                  <p className="text-caption text-warning">{t(($) => $.account_pools.all_relogin)}</p>
                ) : pool.windows.length === 0 ? (
                  <p className="text-caption text-destructive">{t(($) => $.exhausted)}</p>
                ) : (
                  <>
                    <div className="flex flex-col gap-2 text-caption">
                      {pool.windows.map((window, index) => (
                        <AccountPoolTooltipWindow
                          key={`${window.name}-${index}`}
                          window={window}
                          now={now}
                          interrupted={interrupted}
                          showReset={pool.accounts.length <= 1}
                        />
                      ))}
                    </div>
                    {recovery && (
                      <p className={cn("text-micro tabular-nums", interrupted ? "text-faint-foreground" : "text-destructive")}>
                        {recovery}
                      </p>
                    )}
                    {pool.accounts.length > 0 && (
                      <AccountPoolAccountsTable
                        pool={pool}
                        interrupted={interrupted}
                        now={now}
                        limit={4}
                      />
                    )}
                  </>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="-mx-3 flex flex-col gap-3 border-t border-border px-3 pt-2.5">
          {state.pools.map((pool) => (
            <section key={pool.group ?? "ungrouped"} data-hover-quota-group={pool.group ?? "ungrouped"}>
              {pool.group != null && (
                <h4 className="mb-2 text-body font-medium">{quotaGroupLabel(pool.group, t)}</h4>
              )}
              <div className="flex flex-col gap-2 text-caption">
                {pool.windows.map((window, index) => (
                  <AccountPoolTooltipWindow
                    key={`${window.name}-${index}`}
                    window={window}
                    now={now}
                    interrupted={interrupted}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function AccountPoolQuotaList({
  partition,
  interrupted,
}: {
  partition: AccountPoolPartition;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  return (
    <>
      {partition.serving.map((pool) => (
        <span
          key={pool.id}
          data-account-pool={pool.id}
          aria-label={accountPoolAriaLabel(pool, t)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1"
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
            <span className="text-micro text-destructive">
              {t(($) => $.exhausted)}
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
      ))}
    </>
  );
}
