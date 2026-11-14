"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import {
  ProgressIndicator,
  ProgressTrack,
} from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import type { QuotaTone, QuotaWindowState } from "@multica/core/runtimes";
import { useT } from "../../i18n";
import {
  displayRemainingPercent,
  formatQuotaWindowLabel,
  MUTED_BAR_CLASS,
  quotaGroupLabel,
  quotaValueClass,
  quotaWindowValueText,
  TONE_BAR_CLASS,
} from "./runtime-quota-utils";

// Thin fill meter for the quota-remaining and host-metrics bars. The caller
// owns the null state ("--" / omit) — the bar itself never renders one.
// barClassName overrides the tone's fill color for states that are not
// health judgments (e.g. a stale host-metrics sample must stay neutral
// gray even when its last value would tone "ok" — which is health-green).
export function MiniMeterBar({
  percent,
  tone,
  ariaLabel,
  className,
  barClassName,
  trackClassName,
}: {
  percent: number;
  tone: QuotaTone;
  ariaLabel: string;
  className?: string;
  barClassName?: string;
  trackClassName?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <ProgressPrimitive.Root
      value={value}
      aria-label={ariaLabel}
      className={cn("block", className)}
    >
      <ProgressTrack className={cn("h-1", trackClassName)}>
        <ProgressIndicator className={barClassName ?? TONE_BAR_CLASS[tone]} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

export function QuotaWindowRow({
  window,
  interrupted,
}: {
  window: QuotaWindowState;
  interrupted: boolean;
}) {
  const { t } = useT("quota");
  let label = formatQuotaWindowLabel(window.windowMinutes, t) ?? window.name;
  if (window.group != null && (label === window.group || label === quotaGroupLabel(window.group, t))) {
    label = "";
  }
  const valueText = window.exhausted
    ? t(($) => $.window_exhausted)
    : quotaWindowValueText(window, t);
  const showBar = window.remainingPercent != null && !window.notApplicable;
  return (
    <span className="flex items-center gap-1.5">
      {label !== "" && (
        <span className="w-6 shrink-0 truncate text-micro text-muted-foreground">
          {label}
        </span>
      )}
      {showBar && window.remainingPercent != null && (
        <MiniMeterBar
          percent={window.remainingPercent}
          tone={window.tone}
          ariaLabel={label}
          className="w-8 shrink-0"
          barClassName={interrupted ? MUTED_BAR_CLASS : undefined}
        />
      )}
      <span
        className={cn(
          "text-micro tabular-nums",
          window.notApplicable || (window.remainingPercent == null && !window.exhausted)
            ? "text-faint-foreground"
            : quotaValueClass(window.tone, interrupted),
        )}
      >
        {valueText ?? `${displayRemainingPercent(window.remainingPercent ?? 0)}%`}
      </span>
    </span>
  );
}
