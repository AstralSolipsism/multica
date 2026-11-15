"use client";

import { cn } from "@multica/ui/lib/utils";
import {
  formatCompactDuration,
  planQuotaState,
  type QuotaAccountPoolState,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import type { Agent, AgentRuntime } from "@multica/core/types";
import { useT } from "../../i18n";
import { useQuotaTimeFormatter } from "./quota-time";
import {
  accountPoolNeedsRelogin,
  accountPoolProviderLabel,
  partitionAccountPools,
} from "./account-pool-filter";
import { AccountPoolAccountsTable } from "./runtime-quota-account-pools";
import {
  displayRemainingPercent,
  evaluateRuntimeAccountPools,
  formatQuotaWindowLabel,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
  quotaInterruptedText,
  quotaStatusText,
  quotaValueClass,
  quotaWindowResetText,
  quotaWindowValueText,
  type QuotaT,
} from "./runtime-quota-utils";
import { MiniMeterBar } from "./runtime-quota-window";

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
  agentsPending = false,
}: {
  runtime: AgentRuntime;
  now: number;
  agents?: Agent[];
  agentsPending?: boolean;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = planQuotaState(runtime.plan_quota, now);
  const accountPools = evaluateRuntimeAccountPools(runtime, now);
  const partition = accountPools
    ? partitionAccountPools(accountPools.pools, agents, runtime.id)
    : null;
  const hasActiveAgents = agents.some(
    (agent) => agent.runtime_id === runtime.id && !agent.archived_at,
  );
  // The all-pools fallback is a display policy, not evidence of usage. Only
  // an agent-less Runtime marks every pool unused; pending queries mark none.
  const canIdentifyUnusedPools = partition != null && !agentsPending &&
    (!hasActiveAgents || partition.filtered);

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
                      serving={
                        !canIdentifyUnusedPools ||
                        (hasActiveAgents && partition.serving.some((item) => item.id === pool.id))
                      }
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
