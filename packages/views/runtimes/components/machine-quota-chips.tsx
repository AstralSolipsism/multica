"use client";

import {
  activeQuotaWindows,
  formatCompactDuration,
  formatQuotaWindowLabel,
  parsePlanQuota,
  windowRemainingPercent,
  type QuotaTone,
} from "@multica/core/runtimes";
import type { AgentRuntime } from "@multica/core/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import type { MachineQuotaChip, RuntimeMachine } from "./runtime-machines";
import { ProviderLogo } from "./provider-logo";
import { useT } from "../../i18n";

const CHIP_TONE_CLASS: Record<QuotaTone, string> = {
  ok: "bg-muted text-foreground",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

const MAX_VISIBLE_CHIPS = 4;

// The machine row's per-runtime quota string: one pill per runtime carrying
// a fresh plan-quota snapshot, then a "+N" overflow pill. Each pill shows
// the worst active window's remaining percent (or the limited state) and
// hovers into the per-window breakdown.
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
    <span className="flex min-w-0 items-center gap-1.5">
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-micro font-medium tabular-nums ${CHIP_TONE_CLASS[chip.tone]}`}
          >
            <ProviderLogo provider={chip.provider} className="h-3.5 w-3.5" />
            {chip.status === "limited"
              ? t(($) => $.quota.exhausted)
              : chip.remainingPercent == null
                ? t(($) => $.machine.metrics.unavailable)
                : `${Math.round(chip.remainingPercent)}%`}
          </span>
        }
      />
      <TooltipContent>
        <QuotaChipWindows runtime={runtime} now={now} />
      </TooltipContent>
    </Tooltip>
  );
}

// Per-window breakdown inside the chip tooltip: short window label +
// remaining percent (+ reset countdown when the window carries one).
function QuotaChipWindows({
  runtime,
  now,
}: {
  runtime: AgentRuntime | undefined;
  now: number;
}) {
  const { t } = useT("runtimes");
  const quota = parsePlanQuota(runtime?.plan_quota);
  if (!quota) return null;
  const nowSec = Math.floor(now / 1000);
  const windows = activeQuotaWindows(quota, nowSec);
  if (windows.length === 0) return null;
  return (
    <span className="flex flex-col items-start gap-1">
      {windows.map((window, index) => {
        const remaining = windowRemainingPercent(window);
        const label =
          formatQuotaWindowLabel(window.window_minutes, t) ?? window.name;
        const resetsInMs =
          window.resets_at != null ? window.resets_at * 1000 - now : null;
        return (
          <span
            key={`${window.name}-${index}`}
            className="flex items-center gap-2 whitespace-nowrap"
          >
            <span className="text-muted-foreground">{label}</span>
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
    </span>
  );
}
