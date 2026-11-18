"use client";

import type React from "react";
import { planQuotaState, type PlanQuotaPoolsSummary } from "@multica/core/runtimes";
import type { Agent } from "@multica/core/types";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@multica/ui/components/ui/hover-card";
import { runtimeRowLabel, type MachineQuotaChip, type RuntimeMachine } from "./runtime-machines";
import {
  QuotaHoverCard,
  TONE_TEXT_CLASS,
  accountPoolAriaLabel,
  displayRemainingPercent,
  evaluateRuntimeAccountPools,
  MiniMeterBar,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
} from "./runtime-quota-cell";
import {
  accountPoolHasQuotaContent,
  accountPoolNeedsRelogin,
  accountPoolProviderLabel,
  partitionAccountPools,
  type AccountPoolPartition,
} from "./account-pool-filter";
import { ProviderLogo } from "./provider-logo";
import { useT } from "../../i18n";

interface AccountPoolView {
  summary: PlanQuotaPoolsSummary;
  partition: AccountPoolPartition;
}

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
  const accountPoolViews = new Map<string, AccountPoolView>();
  for (const runtime of machine.runtimes) {
    const summary = evaluateRuntimeAccountPools(runtime, now);
    if (summary) {
      accountPoolViews.set(runtime.id, {
        summary,
        partition: partitionAccountPools(summary.pools, agents, runtime.id),
      });
    }
  }
  const runtimeChips = machine.quotaChips;
  if (runtimeChips.length === 0) return null;

  const visibleChips = runtimeChips.slice(0, MAX_VISIBLE_CHIPS);
  const hiddenChips = runtimeChips.slice(MAX_VISIBLE_CHIPS);

  return (
    <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
      {visibleChips.map((chip) => (
        <QuotaChip
          key={chip.key}
          chip={chip}
          machine={machine}
          now={now}
          agents={agents}
          accountPoolView={accountPoolViews.get(chip.runtimeId)}
        />
      ))}
      {hiddenChips.length > 0 && (
        <QuotaOverflowHoverCard
          chips={hiddenChips}
          machine={machine}
          now={now}
          accountPoolViews={accountPoolViews}
        />
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
  accountPoolViews,
}: {
  chips: MachineQuotaChip[];
  machine: RuntimeMachine;
  now: number;
  accountPoolViews: Map<string, AccountPoolView>;
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
      <HoverCardContent align="start" className="w-max max-w-[calc(100vw-1rem)] p-3">
        <p className="text-body font-medium">{title}</p>
        <div className="-mx-3 mt-2 border-t border-border px-3 pt-2.5">
          <div className="flex flex-col items-start gap-2">
            {chips.map((chip) => (
              <QuotaChipFace
                key={chip.key}
                chip={chip}
                machine={machine}
                now={now}
                accountPoolView={accountPoolViews.get(chip.runtimeId)}
              />
            ))}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// The single precedence decision behind a chip's visible text AND its
// aria-label: a limit outranks any percentage the snapshot still carries.
export function quotaChipState(chip: MachineQuotaChip):
  | { kind: "limited" }
  | { kind: "unknown" }
  | { kind: "percent"; percent: number } {
  if (chip.limited) return { kind: "limited" };
  if (chip.remainingPercent == null) return { kind: "unknown" };
  return { kind: "percent", percent: chip.remainingPercent };
}

interface ChipSummary {
  key: string;
  label: string | null;
  value: string;
  percent: number | null;
  tone: MachineQuotaChip["tone"];
  aria: string;
  muted?: boolean;
  relogin?: boolean;
}

function QuotaChipFace({
  chip,
  machine,
  now,
  accountPoolView,
  interactive = false,
  ...rest
}: {
  chip: MachineQuotaChip;
  machine: RuntimeMachine;
  now: number;
  accountPoolView?: AccountPoolView;
  interactive?: boolean;
} & React.ComponentProps<"span">) {
  const { t } = useT("quota");
  const runtime = machine.runtimes.find((item) => item.id === chip.runtimeId);
  const label = runtime ? runtimeRowLabel(runtime, machine.title) : chip.provider;
  const state = runtime ? planQuotaState(runtime.plan_quota, now) : null;
  const interruptedText = chip.interrupted ? t(($) => $.collection_interrupted) : null;

  let summaries: ChipSummary[];
  if (accountPoolView) {
    const pools = accountPoolView.partition.serving.filter(accountPoolHasQuotaContent);
    if (pools.length === 0) return null;
    summaries = pools.map((pool) => {
      const relogin = accountPoolNeedsRelogin(pool);
      const percent = !relogin && !pool.exhausted && pool.windows.length > 0
        ? pool.remainingPercent
        : null;
      const value = relogin
        ? t(($) => $.account_pools.pool_needs_relogin)
        : pool.exhausted
          ? t(($) => $.exhausted)
          : percent == null
            ? t(($) => $.unknown)
            : `${displayRemainingPercent(percent)}%`;
      return {
        key: pool.id,
        label: accountPoolProviderLabel(pool.id),
        value,
        percent,
        tone: pool.tone,
        aria: accountPoolAriaLabel(pool, t),
        muted: !relogin && !pool.exhausted && percent == null,
        relogin,
      };
    });
  } else if (state?.independentPools) {
    summaries = state.pools.map((pool) => {
      const poolLabel = pool.group == null ? label : quotaGroupLabel(pool.group, t);
      const value = pool.limited
        ? t(($) => $.exhausted)
        : pool.remainingPercent == null
          ? t(($) => $.unknown)
          : `${displayRemainingPercent(pool.remainingPercent)}%`;
      return {
        key: pool.group ?? "ungrouped",
        label: poolLabel,
        value,
        percent: pool.limited ? null : pool.remainingPercent,
        tone: pool.tone,
        aria: `${poolLabel}: ${pool.limited || pool.remainingPercent == null
          ? value
          : t(($) => $.remaining, { percent: displayRemainingPercent(pool.remainingPercent) })}`,
        muted: !pool.limited && pool.remainingPercent == null,
      };
    });
  } else {
    const summary = quotaChipState(chip);
    const value = summary.kind === "limited"
      ? t(($) => $.exhausted)
      : summary.kind === "unknown"
        ? t(($) => $.unknown)
        : `${displayRemainingPercent(summary.percent)}%`;
    summaries = [{
      key: "runtime",
      label: null,
      value,
      percent: summary.kind === "percent" ? summary.percent : null,
      tone: chip.tone,
      aria: summary.kind === "percent"
        ? t(($) => $.remaining, { percent: displayRemainingPercent(summary.percent) })
        : value,
      muted: summary.kind === "unknown",
    }];
  }

  const ariaLabel = `${label}: ${summaries.map((summary) => summary.aria).join(" · ")}${
    interruptedText ? ` · ${interruptedText}` : ""
  }`;
  return (
    <span
      {...rest}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      className={`inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-border/70 px-1.5 py-1 text-micro font-medium tabular-nums ${
        chip.interrupted ? "bg-muted" : "bg-card"
      } ${interactive ? "outline-none focus-visible:ring-2 focus-visible:ring-ring" : ""} ${rest.className ?? ""}`}
    >
      <span aria-hidden="true" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="flex shrink-0 items-center gap-1">
          <ProviderLogo provider={chip.provider} className="h-3.5 w-3.5" />
          <span>{label}</span>
        </span>
        <span className="h-3 w-px shrink-0 bg-border" />
        {summaries.map((summary, index) => (
          <span key={summary.key} className="flex items-center gap-1.5">
            {index > 0 && <span className="text-faint-foreground">·</span>}
            {summary.label != null && <span className="text-muted-foreground">{summary.label}</span>}
            {summary.percent != null && (
              <MiniMeterBar
                percent={summary.percent}
                tone={summary.tone}
                ariaLabel={`${label} ${summary.label ?? ""}`}
                className="w-6 shrink-0"
                barClassName={chip.interrupted ? MUTED_BAR_CLASS : undefined}
              />
            )}
            <span
              className={chip.interrupted || summary.muted
                ? "text-faint-foreground"
                : summary.relogin
                  ? "text-warning"
                  : summary.tone === "ok"
                    ? "text-foreground"
                    : TONE_TEXT_CLASS[summary.tone]}
            >
              {summary.value}
            </span>
          </span>
        ))}
        {interruptedText != null && (
          <span className="font-normal text-faint-foreground">· {interruptedText}</span>
        )}
      </span>
    </span>
  );
}

function QuotaChip({
  chip,
  machine,
  now,
  agents,
  accountPoolView,
}: {
  chip: MachineQuotaChip;
  machine: RuntimeMachine;
  now: number;
  agents: Agent[];
  accountPoolView?: AccountPoolView;
}) {
  const runtime = machine.runtimes.find((item) => item.id === chip.runtimeId);
  const pill = (
    <QuotaChipFace
      chip={chip}
      machine={machine}
      now={now}
      accountPoolView={accountPoolView}
      interactive
    />
  );
  if (!runtime) return pill;
  return (
    <QuotaHoverCard
      runtime={runtime}
      machineName={machine.title}
      now={now}
      agents={agents}
      trigger={pill}
    />
  );
}
