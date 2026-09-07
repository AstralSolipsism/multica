"use client";

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
import { useT } from "../../i18n";

const CHIP_TONE_CLASS: Record<QuotaTone, string> = {
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

// Two chips plus the "+N" overflow pill fit the machine row's chip column
// (w-56) in every locale; more would clip mid-pill.
const MAX_VISIBLE_CHIPS = 2;

// The machine row's per-runtime quota string: one pill per runtime carrying
// a fresh plan-quota snapshot, then a "+N" overflow pill. Each pill shows
// the worst active window's remaining percent (or the limited state) and
// hovers into the per-window breakdown. Chips render in the machine's
// runtime order (creation order from the API), so a percentage change never
// reshuffles the row.
export function MachineQuotaChips({
  machine,
  now,
}: {
  machine: RuntimeMachine;
  now: number;
}) {
  const chips = machine.quotaChips;
  if (chips.length === 0) return null;
  const visible = chips.slice(0, MAX_VISIBLE_CHIPS);
  const extra = chips.length - visible.length;
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {visible.map((chip) => (
        <QuotaChip key={chip.runtimeId} chip={chip} machine={machine} now={now} />
      ))}
      {extra > 0 && (
        <span className="inline-flex shrink-0 items-center rounded bg-muted px-1 py-0.5 text-micro font-medium text-muted-foreground">
          +{extra}
        </span>
      )}
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
}: {
  chip: MachineQuotaChip;
  machine: RuntimeMachine;
  now: number;
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={
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
        }
      />
      <TooltipContent>
        <QuotaChipTooltip runtime={runtime} label={label} now={now} />
      </TooltipContent>
    </Tooltip>
  );
}

// Chip tooltip: the runtime's name, its per-window breakdown (short window
// label + remaining percent + reset countdown), then provenance — where the
// snapshot came from and how old it is. Two runtimes of the same provider
// on one machine are told apart by the name row.
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
