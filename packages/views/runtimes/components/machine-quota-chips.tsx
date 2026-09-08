"use client";

import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  activeQuotaWindows,
  formatCompactDuration,
  parsePlanQuota,
  quotaWindowGroup,
  windowRemainingPercent,
  type QuotaTone,
} from "@multica/core/runtimes";
import type { AgentRuntime } from "@multica/core/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { runtimeRowLabel, type MachineQuotaChip, type RuntimeMachine } from "./runtime-machines";
import { formatQuotaWindowLabel, MiniMeterBar, quotaGroupLabel } from "./runtime-quota-cell";
import { ProviderLogo } from "./provider-logo";
import { GlmQuotaChip, GlmQuotaDetail, type GlmQuotaStatusResponse } from "./glm-quota-card";
import { useT } from "../../i18n";

const CHIP_TONE_CLASS: Record<QuotaTone, string> = {
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

// The gap between pills, kept in sync with the flex row's `gap-1.5`.
const CHIP_GAP_PX = 6;

// The machine row's quota area: one pill per quota source — the anchored
// account-level GLM balance first, then one pill per runtime carrying a
// fresh plan-quota snapshot. How many fit is decided by MEASURED width,
// not a fixed count: whatever does not fit whole collapses into a "+N"
// pill whose hover lists every hidden pill with its full breakdown. The
// degradation unit is the whole pill — a progress bar or label is never
// clipped mid-content.
export function MachineQuotaChips({
  machine,
  now,
  glm,
}: {
  machine: RuntimeMachine;
  now: number;
  /** Anchored GLM balance; pass only when this machine is the anchor. */
  glm?: GlmQuotaStatusResponse;
}) {
  const anchorGlm = glm?.enabled && glm.quota ? glm : undefined;
  const runtimeChips = machine.quotaChips;
  const total = runtimeChips.length + (anchorGlm ? 1 : 0);
  const { containerRef, ghostRef, visibleCount } = useChipFlow(total);
  if (total === 0) return null;

  // GLM occupies the first slot; runtimes follow in the machine's runtime
  // order (creation order from the API), so a percentage change never
  // reshuffles the row.
  const glmVisible = anchorGlm ? Math.min(1, visibleCount) : 0;
  const runtimeVisible = Math.max(0, visibleCount - glmVisible);
  const hiddenRuntime = runtimeChips.slice(runtimeVisible);
  const glmHidden = Boolean(anchorGlm) && glmVisible === 0;
  const hiddenCount = hiddenRuntime.length + (glmHidden ? 1 : 0);

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
        {anchorGlm && (
          <GlmQuotaChip key="ghost-glm" data={anchorGlm} now={now} interactive={false} />
        )}
        {runtimeChips.map((chip) => (
          <QuotaChip
            key={`ghost-${chip.runtimeId}`}
            chip={chip}
            machine={machine}
            now={now}
            interactive={false}
          />
        ))}
        <OverflowPill count={99} />
      </span>
      {anchorGlm && glmVisible === 1 && (
        <GlmQuotaChip key="glm" data={anchorGlm} now={now} />
      )}
      {runtimeChips.slice(0, runtimeVisible).map((chip) => (
        <QuotaChip key={chip.runtimeId} chip={chip} machine={machine} now={now} />
      ))}
      {hiddenCount > 0 && (
        <Tooltip>
          <TooltipTrigger render={<OverflowPill count={hiddenCount} />} />
          <TooltipContent>
            <span className="flex flex-col items-start gap-2">
              {anchorGlm && glmHidden && (
                <span className="flex flex-col items-start gap-1">
                  <GlmQuotaChip data={anchorGlm} now={now} interactive={false} />
                  <span className="text-xs">
                    <GlmQuotaDetail data={anchorGlm} now={now} />
                  </span>
                </span>
              )}
              {hiddenRuntime.map((chip) => {
                const runtime = machine.runtimes.find((r) => r.id === chip.runtimeId);
                const label = runtime
                  ? runtimeRowLabel(runtime, machine.title)
                  : chip.provider;
                return (
                  <span
                    key={`hidden-${chip.runtimeId}`}
                    className="flex flex-col items-start gap-1"
                  >
                    <QuotaChip chip={chip} machine={machine} now={now} interactive={false} />
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
// aria-label: limited beats percent beats unavailable (a limited runtime
// can still carry a percentage — codex reports 100% used when limited).
export function quotaChipState(chip: MachineQuotaChip):
  | { kind: "limited" }
  | { kind: "unavailable" }
  | { kind: "percent"; percent: number } {
  if (chip.status === "limited") return { kind: "limited" };
  if (chip.remainingPercent == null) return { kind: "unavailable" };
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
  const { t } = useT("runtimes");
  const runtime = machine.runtimes.find((r) => r.id === chip.runtimeId);
  const label = runtime ? runtimeRowLabel(runtime, machine.title) : chip.provider;
  // The chip reads as [logo] [remaining bar] [remaining %]: the fixed-width
  // bar fills with what is LEFT of the worst active window (fill drains as
  // the quota drains), so the percent is unambiguous without a "left"
  // wordmark; the tone colors both bar and number (green/amber/red).
  // The aria-label follows the SAME precedence as the visible text: a
  // limited runtime that still reports a percentage reads as rate-limited
  // to screen readers too, not as "0% left".
  const state = quotaChipState(chip);
  const text =
    state.kind === "limited"
      ? t(($) => $.quota.exhausted)
      : state.kind === "unavailable"
        ? t(($) => $.machine.metrics.unavailable)
        : `${Math.round(state.percent)}%`;
  const ariaText =
    state.kind === "percent"
      ? t(($) => $.quota.remaining, { percent: Math.round(state.percent) })
      : text;
  const pill = (
    <span
      aria-label={`${label}: ${ariaText}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-micro font-medium tabular-nums ${CHIP_TONE_CLASS[chip.tone]}`}
    >
      <ProviderLogo provider={chip.provider} className="h-3.5 w-3.5" />
      {state.kind === "percent" && (
        <MiniMeterBar
          percent={state.percent}
          tone={chip.tone}
          ariaLabel={label}
          className="w-6 shrink-0"
        />
      )}
      {text}
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
  const { t } = useT("runtimes");
  const quota = parsePlanQuota(runtime?.plan_quota);
  if (!quota) return null;
  const nowSec = Math.floor(now / 1000);
  const windows = activeQuotaWindows(quota, nowSec);
  if (windows.length === 0) return null;
  const observedAgeMs = now - quota.observed_at * 1000;
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="font-medium">{label}</span>
      {windows.map((window, index) => {
        const remaining = windowRemainingPercent(window);
        const windowLabel =
          formatQuotaWindowLabel(window.window_minutes, t) ?? window.name;
        const resetsInMs =
          window.resets_at != null ? window.resets_at * 1000 - now : null;
        // Reporters with several quota pools (antigravity) label each row so
        // the four buckets don't read as two duplicated window pairs.
        const group = quotaWindowGroup(window);
        return (
          <span
            key={`${window.name}-${index}`}
            className="flex items-center gap-2 whitespace-nowrap"
          >
            <span className="text-muted-foreground">
              {group != null ? `${quotaGroupLabel(group, t)} · ${windowLabel}` : windowLabel}
            </span>
            <span className="tabular-nums">
              {remaining == null
                ? t(($) => $.machine.metrics.unavailable)
                : `${Math.round(remaining)}%`}
            </span>
            {resetsInMs != null && resetsInMs > 0 && (
              <span className="tabular-nums text-faint-foreground">
                {t(($) => $.quota.resets_in, {
                  time: formatCompactDuration(resetsInMs),
                })}
              </span>
            )}
          </span>
        );
      })}
      <span className="text-faint-foreground">
        {quota.source === "external"
          ? t(($) => $.quota.source_external)
          : t(($) => $.quota.source_daemon)}
        {" · "}
        {t(($) => $.quota.observed_ago, {
          time: formatCompactDuration(observedAgeMs),
        })}
      </span>
    </span>
  );
}
