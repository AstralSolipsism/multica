"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import {
  ProgressIndicator,
  ProgressTrack,
} from "@multica/ui/components/ui/progress";
import { cn } from "@multica/ui/lib/utils";
import { metricsTone, type QuotaTone } from "@multica/core/runtimes";
import { useT } from "../../i18n";

// Tone → semantic classes, shared by the host metric bars and the quota
// bars (both render a small fill meter + a tone-colored percent).
export const TONE_BAR_CLASS: Record<QuotaTone, string> = {
  ok: "bg-foreground/70",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export const TONE_TEXT_CLASS: Record<QuotaTone, string> = {
  ok: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

// Thin fill meter used for CPU/memory and quota-remaining bars. The caller
// owns the null state ("--" / omit) — the bar itself never renders one.
export function MiniMeterBar({
  percent,
  tone,
  ariaLabel,
  className,
}: {
  percent: number;
  tone: QuotaTone;
  ariaLabel: string;
  className?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <ProgressPrimitive.Root
      value={value}
      aria-label={ariaLabel}
      className={cn("block", className)}
    >
      <ProgressTrack className="h-1">
        <ProgressIndicator className={TONE_BAR_CLASS[tone]} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

// The machine-row CPU / memory pair: micro label + percent above a thin
// track. Missing data renders "--" (an offline machine never shows a
// fabricated 0).
export function HostMetricsBars({
  cpuPercent,
  memoryPercent,
}: {
  cpuPercent: number | null;
  memoryPercent: number | null;
}) {
  const { t } = useT("runtimes");
  return (
    <span className="flex w-full items-center gap-4">
      <MetricBar label={t(($) => $.machine.metrics.cpu)} percent={cpuPercent} />
      <MetricBar
        label={t(($) => $.machine.metrics.memory)}
        percent={memoryPercent}
      />
    </span>
  );
}

function MetricBar({
  label,
  percent,
}: {
  label: string;
  percent: number | null;
}) {
  const { t } = useT("runtimes");
  const tone = metricsTone(percent);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-baseline justify-between gap-1">
        <span className="text-micro text-muted-foreground">{label}</span>
        {percent == null ? (
          <span className="text-micro text-faint-foreground">
            {t(($) => $.machine.metrics.unavailable)}
          </span>
        ) : (
          <span className={`text-micro tabular-nums ${TONE_TEXT_CLASS[tone]}`}>
            {Math.round(percent)}%
          </span>
        )}
      </span>
      {percent != null && (
        <MiniMeterBar percent={percent} tone={tone} ariaLabel={label} />
      )}
    </span>
  );
}

// Inline variant for the machine detail header meta row ("CPU ▬ 42%").
// Metrics with no data are omitted entirely — the header already carries
// the machine's offline state.
export function HostMetricsInline({
  cpuPercent,
  memoryPercent,
}: {
  cpuPercent: number | null;
  memoryPercent: number | null;
}) {
  const { t } = useT("runtimes");
  return (
    <>
      {cpuPercent != null && (
        <MetricInline label={t(($) => $.machine.metrics.cpu)} percent={cpuPercent} />
      )}
      {memoryPercent != null && (
        <MetricInline
          label={t(($) => $.machine.metrics.memory)}
          percent={memoryPercent}
        />
      )}
    </>
  );
}

function MetricInline({ label, percent }: { label: string; percent: number }) {
  const tone = metricsTone(percent);
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <MiniMeterBar
        percent={percent}
        tone={tone}
        ariaLabel={label}
        className="w-8 shrink-0"
      />
      <span className={`tabular-nums ${TONE_TEXT_CLASS[tone]}`}>
        {Math.round(percent)}%
      </span>
    </span>
  );
}
