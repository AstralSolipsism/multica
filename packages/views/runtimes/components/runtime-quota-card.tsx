"use client";

import { useState } from "react";
import { ChevronDown } from "@multica/ui/icons";
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
  accountPoolRecoveryText,
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
} from "./runtime-quota-utils";
import { MiniMeterBar } from "./runtime-quota-window";

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
  const formatTime = useQuotaTimeFormatter();
  const recovery = accountPoolRecoveryText(pool, now, t, formatTime);
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
        <p className="text-caption text-destructive">{t(($) => $.exhausted)}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            {pool.windows.map((window, index) => (
              <QuotaCardWindow
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
          {pool.accounts.length > 0 && pool.windows.length > 0 && (
            <AccountPoolAccountsTable pool={pool} interrupted={interrupted} now={now} />
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
  const [idlePoolsOpen, setIdlePoolsOpen] = useState(false);
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

  if (!state || (accountPools && partition?.all.length === 0)) return null;

  return (
    <section className="rounded-lg border bg-card">
      <h3 className="border-b px-4 py-2.5 text-caption font-semibold">
        {t(($) => $.title)}
      </h3>
      <div className="p-4">
        <>
            {(!accountPools || !partition || partition.serving.length > 0) && (
            <div className="divide-y divide-border">
              {accountPools && partition
                ? partition.serving.map((pool) => (
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
                    <div
                      key={pool.group ?? "ungrouped"}
                      data-quota-group={pool.group ?? "ungrouped"}
                      className="py-4 first:pt-0 last:pb-0"
                    >
                      {pool.group != null && (
                        <h4 className="mb-3 text-caption font-medium">
                          {quotaGroupLabel(pool.group, t)}
                        </h4>
                      )}
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
            )}
            {accountPools && partition && partition.idle.length > 0 && (
              <div className={cn(partition.serving.length > 0 && "mt-4 border-t border-border pt-3")}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-left text-caption font-medium text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-expanded={idlePoolsOpen}
                  aria-controls={`runtime-quota-idle-${runtime.id}`}
                  onClick={() => setIdlePoolsOpen((open) => !open)}
                >
                  {t(($) => $.account_pools.idle_pools, { count: partition.idle.length })}
                  <ChevronDown
                    className={cn("size-4 shrink-0 transition-transform", idlePoolsOpen && "rotate-180")}
                  />
                </button>
                {idlePoolsOpen && (
                  <div id={`runtime-quota-idle-${runtime.id}`} className="divide-y divide-border">
                    {partition.idle.map((pool) => (
                      <AccountPoolQuotaSubject
                        key={pool.id}
                        pool={pool}
                        now={now}
                        interrupted={state.interrupted}
                        serving={!canIdentifyUnusedPools}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
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
      </div>
    </section>
  );
}

function QuotaCardWindow({
  window,
  now,
  interrupted,
  showReset = true,
}: {
  window: QuotaWindowState;
  now: number;
  interrupted: boolean;
  /** False for a multi-account pool: its aggregate reset is a merge of
   *  independent accounts, not a pool reset. Account rows show their own. */
  showReset?: boolean;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const windowLabel = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  const label = windowLabel;
  const valueText = window.exhausted
    ? t(($) => $.window_exhausted)
    : quotaWindowValueText(window, t);
  const reset = quotaWindowResetText(window, now, t, formatTime);
  const showBar = window.remainingPercent != null && !window.notApplicable;
  return (
    <div data-pool-window className="space-y-1">
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
      {showReset && reset != null && (
        <p className="text-micro tabular-nums text-faint-foreground">{reset}</p>
      )}
    </div>
  );
}
