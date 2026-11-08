"use client";

import type React from "react";
import type { Agent } from "@multica/core/types";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@multica/ui/components/ui/hover-card";
import { runtimeRowLabel, type MachineQuotaChip, type RuntimeMachine } from "./runtime-machines";
import {
  AccountPoolMachineChip,
  QuotaHoverCard,
  TONE_TEXT_CLASS,
  accountPoolAriaLabel,
  displayRemainingPercent,
  evaluateRuntimeAccountPools,
  MiniMeterBar,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
} from "./runtime-quota-cell";
import { accountPoolProviderLabel } from "./account-pool-filter";
import { ProviderLogo } from "./provider-logo";
import { useT } from "../../i18n";
import { partitionAccountPools, type AccountPoolPartition } from "./account-pool-filter";

const CHIP_TONE_CLASS = {
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
} as const;

const MAX_VISIBLE_CHIPS = 8;

// Keep the machine's runtime order so quota changes never reshuffle the row.
// Eight chips wrap naturally; only additional subjects collapse into "+N".
export function MachineQuotaChips({
  machine,
  now,
  agents = [],
}: {
  machine: RuntimeMachine;
  now: number;
  agents?: Agent[];
}) {
  const partitions = new Map<string, AccountPoolPartition>();
  for (const runtime of machine.runtimes) {
    const summary = evaluateRuntimeAccountPools(runtime, now);
    if (summary) {
      partitions.set(runtime.id, partitionAccountPools(summary.pools, agents, runtime.id));
    }
  }
  const runtimeChips = machine.quotaChips.filter((chip) => {
    if (chip.accountPoolId == null) return true;
    const partition = partitions.get(chip.runtimeId);
    return partition != null && (
      !partition.filtered || partition.serving.some((pool) => pool.id === chip.accountPoolId)
    );
  });
  if (runtimeChips.length === 0) return null;

  const visibleChips = runtimeChips.slice(0, MAX_VISIBLE_CHIPS);
  const hiddenChips = runtimeChips.slice(MAX_VISIBLE_CHIPS);

  return (
    <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
      {visibleChips.map((chip) => (
        <QuotaChip key={chip.key} chip={chip} machine={machine} now={now} />
      ))}
      {hiddenChips.length > 0 && (
        <QuotaOverflowHoverCard chips={hiddenChips} machine={machine} now={now} />
      )}
    </span>
  );
}

function OverflowPill({
  count,
  className,
  ...rest
}: { count: number } & React.ComponentProps<"span">) {
  return (
    <span
      {...rest}
      className={`inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-micro font-medium tabular-nums text-muted-foreground ring-1 ring-inset ring-border ${className ?? ""}`}
    >
      +{count}
    </span>
  );
}

function QuotaOverflowHoverCard({
  chips,
  machine,
  now,
}: {
  chips: MachineQuotaChip[];
  machine: RuntimeMachine;
  now: number;
}) {
  const { t } = useT("quota");
  const title = t(($) => $.overflow_title, { count: chips.length });
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={120}
        closeDelay={140}
        render={
          <OverflowPill
            count={chips.length}
            tabIndex={0}
            aria-label={title}
            className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      />
      <HoverCardContent align="start" className="w-85 max-w-[calc(100vw-1rem)] p-3">
        <p className="text-body font-medium">{title}</p>
        <div className="-mx-3 mt-2 border-t border-border px-3 pt-2.5">
          <div className="flex flex-col gap-2">
            {chips.map((chip) => {
              const runtime = machine.runtimes.find((item) => item.id === chip.runtimeId);
              const runtimeLabel = runtime
                ? runtimeRowLabel(runtime, machine.title)
                : chip.provider;
              const accountPool = runtime && chip.accountPoolId != null
                ? evaluateRuntimeAccountPools(runtime, now)?.pools.find(
                    (pool) => pool.id === chip.accountPoolId,
                  )
                : null;
              const label = accountPool
                ? accountPoolProviderLabel(accountPool.id)
                : chip.group != null
                  ? `${runtimeLabel} / ${quotaGroupLabel(chip.group, t)}`
                  : runtimeLabel;
              const state = quotaChipState(chip);
              return (
                <span
                  key={chip.key}
                  className="grid grid-cols-[minmax(0,1fr)_2rem_auto] items-center gap-2 text-caption"
                >
                  <span className="min-w-0 truncate">
                    {label}
                    {accountPool && (
                      <span className="text-muted-foreground">
                        {" "}
                        {accountPool.availableAccounts}/{accountPool.totalAccounts}
                      </span>
                    )}
                  </span>
                  {state.kind === "percent" ? (
                    <MiniMeterBar
                      percent={state.percent}
                      tone={chip.tone}
                      ariaLabel={label}
                      className="w-8"
                      barClassName={chip.interrupted ? MUTED_BAR_CLASS : undefined}
                    />
                  ) : (
                    <span />
                  )}
                  <span
                    className={`text-right text-micro tabular-nums ${
                      chip.interrupted
                        ? "text-faint-foreground"
                        : chip.tone === "ok"
                          ? "text-foreground"
                          : TONE_TEXT_CLASS[chip.tone]
                    }`}
                  >
                    {state.kind === "empty"
                      ? t(($) => $.no_snapshot_chip)
                      : state.kind === "limited"
                        ? t(($) => $.exhausted)
                        : state.kind === "unknown"
                          ? t(($) => $.unknown)
                          : `${displayRemainingPercent(state.percent)}%`}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// The single precedence decision behind a chip's visible text AND its
// aria-label: a limit outranks any percentage the snapshot still carries.
export function quotaChipState(chip: MachineQuotaChip):
  | { kind: "empty" }
  | { kind: "limited" }
  | { kind: "unknown" }
  | { kind: "percent"; percent: number } {
  if (chip.empty) return { kind: "empty" };
  if (chip.limited) return { kind: "limited" };
  if (chip.remainingPercent == null) return { kind: "unknown" };
  return { kind: "percent", percent: chip.remainingPercent };
}

function QuotaChip({
  chip,
  machine,
  now,
}: {
  chip: MachineQuotaChip;
  machine: RuntimeMachine;
  now: number;
}) {
  const { t } = useT("quota");
  const runtime = machine.runtimes.find((item) => item.id === chip.runtimeId);
  const label = runtime ? runtimeRowLabel(runtime, machine.title) : chip.provider;
  const accountPools = runtime && chip.accountPoolId != null
    ? evaluateRuntimeAccountPools(runtime, now)
    : null;
  const accountPool = accountPools?.pools.find((pool) => pool.id === chip.accountPoolId);
  if (chip.accountPoolId != null && !accountPool) return null;
  const poolLabel = chip.group != null ? quotaGroupLabel(chip.group, t) : null;
  const state = quotaChipState(chip);
  const text =
    state.kind === "empty"
      ? t(($) => $.no_snapshot_chip)
      : state.kind === "limited"
        ? t(($) => $.exhausted)
        : state.kind === "unknown"
          ? t(($) => $.unknown)
          : `${displayRemainingPercent(state.percent)}%`;
  const ariaValue =
    state.kind === "percent"
      ? t(($) => $.remaining, { percent: displayRemainingPercent(state.percent) })
      : text;
  const interruptedText = chip.interrupted ? t(($) => $.collection_interrupted) : null;
  const ariaLabel = accountPool
    ? `${accountPoolAriaLabel(accountPool, t)}${interruptedText ? ` · ${interruptedText}` : ""}`
    : `${poolLabel != null ? `${label} · ${poolLabel}` : label}: ${ariaValue}${
        interruptedText != null ? ` · ${interruptedText}` : ""
      }`;
  const pill = accountPool ? (
    <span
      tabIndex={0}
      aria-label={ariaLabel}
      className="inline-flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AccountPoolMachineChip pool={accountPool} interrupted={chip.interrupted} />
    </span>
  ) : (
    <span
      tabIndex={0}
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring ${chip.empty || chip.interrupted ? "bg-muted text-muted-foreground" : CHIP_TONE_CLASS[chip.tone]}`}
    >
      <ProviderLogo provider={chip.provider} className="h-3.5 w-3.5" />
      {poolLabel != null && <span>{poolLabel}</span>}
      {state.kind === "percent" && (
        <MiniMeterBar
          percent={state.percent}
          tone={chip.tone}
          ariaLabel={label}
          className="w-6 shrink-0"
          barClassName={chip.interrupted ? MUTED_BAR_CLASS : undefined}
        />
      )}
      {text}
      {interruptedText != null && (
        <span className="font-normal">
          {" · "}
          {interruptedText}
        </span>
      )}
    </span>
  );
  if (!runtime) return pill;
  return (
    <QuotaHoverCard
      runtime={runtime}
      machineName={machine.title}
      now={now}
      group={chip.group}
      pool={accountPool}
      trigger={pill}
    />
  );
}
