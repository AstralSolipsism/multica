"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import {
  formatCompactDuration,
  planQuotaState,
  type QuotaAccountPoolState,
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
