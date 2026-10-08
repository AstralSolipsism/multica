"use client";

import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  formatCompactDuration,
  planQuotaState,
  type QuotaTone,
} from "@multica/core/runtimes";
import type { AgentRuntime } from "@multica/core/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { runtimeRowLabel, type MachineQuotaChip, type RuntimeMachine } from "./runtime-machines";
import {
  displayRemainingPercent,
  formatQuotaWindowLabel,
  MiniMeterBar,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
  quotaInterruptedText,
  quotaWindowResetText,
  quotaWindowValueText,
} from "./runtime-quota-cell";
import { ProviderLogo } from "./provider-logo";
import { useQuotaTimeFormatter } from "./quota-time";
import { useT } from "../../i18n";

const CHIP_TONE_CLASS: Record<QuotaTone, string> = {
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

// The gap between pills, kept in sync with the flex row's `gap-1.5`.
const CHIP_GAP_PX = 6;

// The machine row shows one pill per runtime carrying a quota snapshot (one
// per pool for independent pools). Pills that do not fit collapse into a "+N"
// tooltip with their full breakdown.
export function MachineQuotaChips({
  machine,
  now,
}: {
  machine: RuntimeMachine;
  now: number;
}) {
  const runtimeChips = machine.quotaChips;
  const { containerRef, ghostRef, visibleCount } = useChipFlow(runtimeChips.length);
  if (runtimeChips.length === 0) return null;

  // Keep the machine's runtime order so quota changes never reshuffle the row.
  const hiddenChips = runtimeChips.slice(visibleCount);
  const hiddenCount = hiddenChips.length;

  return (
    <span
      ref={containerRef}
      className="relative flex w-full min-w-0 items-center gap-1.5"
    >
      {/* Measuring row: the same pills, never painted. The "+99" placeholder
          keeps the overflow pill's measured width stable against digit
          count, so collapsing cannot re-trigger its own layout. */}
      <span
        ref={ghostRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap"
      >
        {runtimeChips.map((chip) => (
          <QuotaChip
            key={`ghost-${chip.key}`}
            chip={chip}
            machine={machine}
            now={now}
            interactive={false}
          />
        ))}
        <OverflowPill count={99} />
      </span>
      {runtimeChips.slice(0, visibleCount).map((chip) => (
        <QuotaChip key={chip.key} chip={chip} machine={machine} now={now} />
      ))}
      {hiddenCount > 0 && (
        <Tooltip>
          <TooltipTrigger render={<OverflowPill count={hiddenCount} />} />
          <TooltipContent>
            <span className="flex flex-col items-start gap-2">
              {chipsByRuntime(hiddenChips).map(({ runtimeId, chips }) => {
                const runtime = machine.runtimes.find((r) => r.id === runtimeId);
                const label = runtime
                  ? runtimeRowLabel(runtime, machine.title)
                  : chips[0]!.provider;
                return (
                  <span
                    key={`hidden-${runtimeId}`}
                    className="flex flex-col items-start gap-1"
                  >
                    <span className="flex flex-wrap items-center gap-1">
                      {chips.map((chip) => (
                        <QuotaChip
                          key={chip.key}
                          chip={chip}
                          machine={machine}
                          now={now}
                          interactive={false}
                        />
                      ))}
                    </span>
                    <span className="text-xs">
                      <QuotaChipTooltip runtime={runtime} label={label} now={now} />
                    </span>
                  </span>
                );
              })}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

// Hidden pills grouped by runtime, so a runtime split into pool pills lists
// its windows once.
function chipsByRuntime(
  chips: MachineQuotaChip[],
): { runtimeId: string; chips: MachineQuotaChip[] }[] {
  const groups: { runtimeId: string; chips: MachineQuotaChip[] }[] = [];
  for (const chip of chips) {
    const last = groups[groups.length - 1];
    if (last?.runtimeId === chip.runtimeId) last.chips.push(chip);
    else groups.push({ runtimeId: chip.runtimeId, chips: [chip] });
  }
  return groups;
}

// Measures real widths and decides how many pills fit. The initial state
// shows everything; useLayoutEffect corrects before first paint on the
// client, so there is no visible flicker and SSR stays simple.
// The container span is w-full on purpose: its width must track the quota
// COLUMN, never the collapsed content — otherwise every collapse shrinks
// the container, the observer refires on the smaller budget, and the row
// spirals down to "+N"-only.
function useChipFlow(itemCount: number) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const ghostRef = useRef<HTMLSpanElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(itemCount);

  useLayoutEffect(() => {
    const compute = () => {
      const container = containerRef.current;
      const ghost = ghostRef.current;
      if (!container || !ghost) return;
      const kids = Array.from(ghost.children) as HTMLElement[];
      const overflowGhost = kids[kids.length - 1];
      if (kids.length === 0 || !overflowGhost) return;
      const widths = kids.slice(0, -1).map((k) => k.getBoundingClientRect().width);
      const pillCost = overflowGhost.getBoundingClientRect().width + CHIP_GAP_PX;
      setVisibleCount(
        fitChipCount(container.clientWidth, widths, CHIP_GAP_PX, pillCost),
      );
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (containerRef.current) ro.observe(containerRef.current);
    // Freshness text can change width without changing the number of chips.
    if (ghostRef.current) ro.observe(ghostRef.current);
    return () => ro.disconnect();
  }, [itemCount]);

  return { containerRef, ghostRef, visibleCount };
}

// Pure fit decision: the largest k whose first k pills (plus the overflow
// pill whenever anything is hidden) stay within `available`. Zero is a
// valid answer — a very narrow column shows only the "+N" pill.
export function fitChipCount(
  available: number,
  widths: number[],
  gap: number,
  pillCost: number,
): number {
  for (let k = widths.length; k > 0; k--) {
    const used =
      widths.slice(0, k).reduce((sum, w) => sum + w, 0) + gap * (k - 1);
    const overflow = k < widths.length ? pillCost : 0;
    if (used + overflow <= available) return k;
  }
  return 0;
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

function QuotaChip({
  chip,
  machine,
  now,
  interactive = true,
}: {
  chip: MachineQuotaChip;
  machine: RuntimeMachine;
  now: number;
  /** false renders the bare pill (ghost measuring row, "+N" popover). */
  interactive?: boolean;
}) {
  const { t } = useT("quota");
  const runtime = machine.runtimes.find((r) => r.id === chip.runtimeId);
  const label = runtime ? runtimeRowLabel(runtime, machine.title) : chip.provider;
  const poolLabel = chip.group != null ? quotaGroupLabel(chip.group, t) : null;
  // The chip reads as [logo] [pool] [remaining bar] [remaining %]: the bar
  // fills with what is LEFT of the tightest constraint (fill drains as the
  // quota drains), and the tone colors both bar and number. An interrupted
  // collection keeps its last balance in neutral gray, flagged in words.
  // The aria-label follows the SAME precedence as the visible text: a
  // limited runtime that still reports a percentage reads as rate-limited
  // to screen readers too, not as "0% left".
  const state = quotaChipState(chip);
  const text =
    state.kind === "limited"
      ? t(($) => $.exhausted)
      : state.kind === "unknown"
        ? t(($) => $.unknown)
        : `${displayRemainingPercent(state.percent)}%`;
  const ariaValue =
    state.kind === "percent"
      ? t(($) => $.remaining, { percent: displayRemainingPercent(state.percent) })
      : text;
  const interruptedText = chip.interrupted ? t(($) => $.collection_interrupted) : null;
  const ariaLabel = `${poolLabel != null ? `${label} · ${poolLabel}` : label}: ${ariaValue}${
    interruptedText != null ? ` · ${interruptedText}` : ""
  }`;
  const pill = (
    <span
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro font-medium tabular-nums ${chip.interrupted ? "bg-muted text-muted-foreground" : CHIP_TONE_CLASS[chip.tone]}`}
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
  if (!interactive) return pill;
  return (
    <Tooltip>
      <TooltipTrigger render={pill} />
      <TooltipContent>
        <QuotaChipTooltip runtime={runtime} label={label} now={now} />
      </TooltipContent>
    </Tooltip>
  );
}

function QuotaChipTooltip({
  runtime,
  label,
  now,
}: {
  runtime: AgentRuntime | undefined;
  label: string;
  now: number;
}) {
  const { t } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const state = runtime ? planQuotaState(runtime.plan_quota, now) : null;
  if (!state) return null;
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="font-medium">{label}</span>
      {state.pools.flatMap((pool) => pool.windows).map((window, index) => {
        const windowLabel =
          formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
        const value =
          quotaWindowValueText(window, t) ??
          `${displayRemainingPercent(window.remainingPercent ?? 0)}%`;
        const reset = quotaWindowResetText(window, now, t, formatTime);
        // Reporters with several quota pools (antigravity) label each row so
        // the four buckets don't read as two duplicated window pairs.
        return (
          <span
            key={`${window.name}-${index}`}
            className="flex items-center gap-2 whitespace-nowrap"
          >
            <span className="text-muted-foreground">
              {window.group != null
                ? `${quotaGroupLabel(window.group, t)} · ${windowLabel}`
                : windowLabel}
            </span>
            <span className="tabular-nums">{value}</span>
            {reset != null && (
              <span className="tabular-nums text-faint-foreground">{reset}</span>
            )}
          </span>
        );
      })}
      <span className="text-faint-foreground">
        {state.source === "external"
          ? t(($) => $.source_external)
          : t(($) => $.source_daemon)}
        {" · "}
        {state.interrupted
          ? quotaInterruptedText(state.observedAt, now, t, formatTime)
          : t(($) => $.observed_ago, {
              time: formatCompactDuration(now - state.observedAt * 1000),
            })}
      </span>
    </span>
  );
}
