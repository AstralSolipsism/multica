"use client";

import { metricsTone, type QuotaTone } from "@multica/core/runtimes";
import { MiniMeterBar, TONE_TEXT_CLASS } from "./runtime-quota-cell";
import { useT } from "../../i18n";

// The machine-row CPU / memory pair: micro label + percent above a thin
// track. Three states per metric, deliberately distinct: a fresh sample
// renders a tone-colored fill; a stale one (server-flagged, past the 30s
// freshness SLA) renders the last value muted with a gray fill and a stale
// hint; no data renders "--" and no track — never a fabricated 0.
export function HostMetricsBars({
  cpuPercent,
  memoryPercent,
  stale,
}: {
  cpuPercent: number | null;
  memoryPercent: number | null;
  stale: boolean;
}) {
  const { t } = useT("runtimes");
  return (
    <span className="flex w-full items-center gap-4">
      <MetricBar
        label={t(($) => $.machine.metrics.cpu)}
        percent={cpuPercent}
        stale={stale}
      />
      <MetricBar
        label={t(($) => $.machine.metrics.memory)}
        percent={memoryPercent}
        stale={stale}
      />
    </span>
  );
}

function MetricBar({
  label,
  percent,
  stale,
}: {
  label: string;
  percent: number | null;
  stale: boolean;
}) {
  const { t } = useT("runtimes");
  const tone = metricsTone(percent);
  const staleLabel = t(($) => $.machine.metrics.stale);
  return (
    <span
      className="flex min-w-0 flex-1 flex-col gap-1"
      title={stale && percent != null ? staleLabel : undefined}
    >
      <span className="flex items-baseline justify-between gap-1">
        <span className="text-micro text-muted-foreground">{label}</span>
        {percent == null ? (
          <span className="text-micro text-faint-foreground">
            {t(($) => $.machine.metrics.unavailable)}
          </span>
        ) : stale ? (
          <span
            aria-label={`${label}: ${Math.round(percent)}% (${staleLabel})`}
            className="text-micro tabular-nums text-faint-foreground"
          >
            {Math.round(percent)}%
          </span>
        ) : (
          <span className={`text-micro tabular-nums ${TONE_TEXT_CLASS[tone]}`}>
            {Math.round(percent)}%
          </span>
        )}
      </span>
      {percent != null && (
        <MiniMeterBar
          percent={percent}
          tone={tone}
          ariaLabel={label}
          className={stale ? "opacity-40" : undefined}
          barClassName={stale ? "bg-muted-foreground/50" : undefined}
        />
      )}
    </span>
  );
}

// Inline variant for the machine detail header meta row ("CPU ▬ 42%").
// Metrics with no data are omitted entirely — the header already carries
// the machine's offline state. A stale sample keeps its last value muted
// with the stale hint appended.
export function HostMetricsInline({
  cpuPercent,
  memoryPercent,
  stale,
}: {
  cpuPercent: number | null;
  memoryPercent: number | null;
  stale: boolean;
}) {
  const { t } = useT("runtimes");
  return (
    <>
      {cpuPercent != null && (
        <MetricInline
          label={t(($) => $.machine.metrics.cpu)}
          percent={cpuPercent}
          stale={stale}
          staleLabel={t(($) => $.machine.metrics.stale)}
        />
      )}
      {memoryPercent != null && (
        <MetricInline
          label={t(($) => $.machine.metrics.memory)}
          percent={memoryPercent}
          stale={stale}
          staleLabel={t(($) => $.machine.metrics.stale)}
        />
      )}
    </>
  );
}

function MetricInline({
  label,
  percent,
  stale,
  staleLabel,
}: {
  label: string;
  percent: number;
  stale: boolean;
  staleLabel: string;
}) {
  const tone: QuotaTone = metricsTone(percent);
  return (
    <span
      className="flex items-center gap-1.5"
      title={stale ? staleLabel : undefined}
    >
      <span className="text-muted-foreground">{label}</span>
      <MiniMeterBar
        percent={percent}
        tone={tone}
        ariaLabel={label}
        className={stale ? "w-8 shrink-0 opacity-40" : "w-8 shrink-0"}
        barClassName={stale ? "bg-muted-foreground/50" : undefined}
      />
      <span
        className={`tabular-nums ${stale ? "text-faint-foreground" : TONE_TEXT_CLASS[tone]}`}
      >
        {Math.round(percent)}%
      </span>
      {stale && (
        <span className="text-micro text-faint-foreground">{staleLabel}</span>
      )}
    </span>
  );
}
