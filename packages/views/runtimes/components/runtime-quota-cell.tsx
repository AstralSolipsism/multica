"use client";

import { planQuotaState } from "@multica/core/runtimes";
import type { Agent, AgentRuntime } from "@multica/core/types";
import { useT } from "../../i18n";
import { useQuotaTimeFormatter } from "./quota-time";
import {
  AccountPoolQuotaList,
  QuotaHoverCard,
} from "./runtime-quota-account-pools";
import {
  evaluateRuntimeAccountPools,
  quotaGroupLabel,
  quotaInterruptedText,
} from "./runtime-quota-utils";
import { QuotaWindowRow } from "./runtime-quota-window";

export {
  accountPoolAriaLabel,
  AccountPoolMachineChip,
  QuotaHoverCard,
} from "./runtime-quota-account-pools";
export {
  RuntimeQuotaCard,
  ThinkingAdaptQuotaCard,
  ThinkingAdaptQuotaRow,
} from "./runtime-quota-card";
export {
  displayRemainingPercent,
  evaluateRuntimeAccountPools,
  formatQuotaWindowLabel,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
  quotaInterruptedText,
  quotaStatusText,
  quotaWindowResetText,
  quotaWindowValueText,
  TONE_BAR_CLASS,
  TONE_TEXT_CLASS,
} from "./runtime-quota-utils";
export { MiniMeterBar } from "./runtime-quota-window";

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
