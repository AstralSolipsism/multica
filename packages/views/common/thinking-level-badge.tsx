"use client";

import { useMemo, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import type {
  TaskMessagePayload,
  TaskMessageThinkingMetadata,
} from "@multica/core/types/events";
import {
  currentThinkingLevel,
  summarizeThinkingRun,
  thinkingLevelRank,
  type ThinkingRunSummary,
  type ThinkingSample,
  type ThinkingTrend,
} from "@multica/core/chat/thinking-level";
import { useT } from "../i18n";

// Contract: docs/engineering/labrastro-thinking-adapt.md §7/§9 — the badge
// sits at the agent-status surfaces (chat pill, run card, transcript header),
// reads the raw message stream, and never renders per-line.

interface BadgeProps {
  /** Raw task messages of the run (never the merged timeline). */
  messages: readonly TaskMessagePayload[];
  className?: string;
  /** Rendered in front of the chip when the badge is visible (e.g. a " · "). */
  leading?: ReactNode;
}

/** Source display names: localized where the contract names one, raw otherwise. */
export function thinkingSourceDisplayName(source: string, selfHostedLabel: string): string {
  if (source === "self-hosted") return selfHostedLabel;
  if (source === "opencode" || source === "opencode-free") return "OpenCode Zen";
  return source;
}

function useFallbackReason(fallback: TaskMessageThinkingMetadata["fallback"]): string {
  const { t } = useT("thinking");
  switch (fallback) {
    case "timeout": return t(($) => $.tooltip.reason_timeout);
    case "error": return t(($) => $.tooltip.reason_error);
    case "invalid": return t(($) => $.tooltip.reason_invalid);
    case "breaker": return t(($) => $.tooltip.reason_breaker);
    case "disabled": return t(($) => $.tooltip.reason_disabled);
    case "no_candidates": return t(($) => $.tooltip.reason_no_candidates);
    default: return t(($) => $.tooltip.reason_unknown);
  }
}

function probabilityRows(probabilities: Record<string, number>): [string, number][] {
  return Object.entries(probabilities).sort((a, b) => {
    const ra = thinkingLevelRank(a[0]);
    const rb = thinkingLevelRank(b[0]);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a[0].localeCompare(b[0]);
  });
}

function BadgeShell({
  tooltip,
  leading,
  className,
  children,
}: {
  tooltip: ReactNode;
  leading?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      {leading}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "inline-flex shrink-0 cursor-default items-center gap-0.5 rounded-full border bg-muted/60 px-1.5 py-px font-mono text-micro leading-4 text-muted-foreground",
                className,
              )}
            >
              {children}
            </span>
          }
        />
        <TooltipContent className="flex-col items-start gap-1 font-sans">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </>
  );
}

function AdaptTooltipContent({ metadata }: { metadata: TaskMessageThinkingMetadata }) {
  const { t } = useT("thinking");
  const parts = [t(($) => $.tooltip.decision_line, { level: metadata.level })];
  if (metadata.confidence !== undefined) {
    parts.push(t(($) => $.tooltip.confidence, { value: Math.round(metadata.confidence * 100) }));
  }
  if (metadata.latency_ms !== undefined) {
    parts.push(t(($) => $.tooltip.latency, { ms: Math.round(metadata.latency_ms) }));
  }
  if (metadata.source) {
    parts.push(t(($) => $.tooltip.source, {
      name: thinkingSourceDisplayName(metadata.source, t(($) => $.source_self_hosted)),
    }));
  }
  const rows = metadata.probabilities ? probabilityRows(metadata.probabilities) : [];
  return (
    <>
      <span>{parts.join(" · ")}</span>
      {rows.length > 0 && (
        <span className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t(($) => $.tooltip.probabilities)}</span>
          {rows.map(([level, probability]) => (
            <span key={level} className="tabular-nums">
              {level} {Math.round(probability * 100)}%
            </span>
          ))}
        </span>
      )}
    </>
  );
}

function FallbackTooltipContent({ metadata }: { metadata: TaskMessageThinkingMetadata }) {
  const { t } = useT("thinking");
  const reason = useFallbackReason(metadata.fallback);
  return <span>{t(($) => $.tooltip.fell_back, { reason })}</span>;
}

// Step-level fallback (OL-1000): the decision failed, so the step explicitly
// carried the previous step's level over — show that level, say why.
function CarriedOverTooltipContent({ metadata }: { metadata: TaskMessageThinkingMetadata }) {
  const { t } = useT("thinking");
  const reason = useFallbackReason(metadata.fallback);
  return <span>{t(($) => $.tooltip.carried_over, { reason })}</span>;
}

function TrendMark({ trend }: { trend: ThinkingTrend }) {
  const { t } = useT("thinking");
  if (trend === "flat") return null;
  return (
    <>
      <span aria-hidden>{trend === "up" ? "↑" : "↓"}</span>
      <span className="sr-only">{t(($) => (trend === "up" ? $.trend_up : $.trend_down))}</span>
    </>
  );
}

function CurrentChip({
  current,
  trend,
}: {
  current: ThinkingSample;
  trend?: ThinkingTrend;
}) {
  const { t } = useT("thinking");
  const metadata = current.metadata;
  if (metadata.level === "") {
    return <>{t(($) => $.badge_fallback)}</>;
  }
  return (
    <>
      {metadata.level}
      {metadata.mode === "adapt" && trend && <TrendMark trend={trend} />}
    </>
  );
}

/** The run's current level, shown for the whole run — tool calls included. */
export function ThinkingLevelBadge({ messages, className, leading }: BadgeProps) {
  const { t } = useT("thinking");
  const state = useMemo(() => currentThinkingLevel(messages), [messages]);
  if (!state) return null;
  const metadata = state.current.metadata;
  // "Default" is shown exactly when the level is empty (run-level fallback) —
  // never keyed on `fallback` alone, since a step-level fallback carries the
  // previous level and shows that instead.
  const tooltip = metadata.level === "" ? (
    <FallbackTooltipContent metadata={metadata} />
  ) : metadata.fallback !== undefined ? (
    <CarriedOverTooltipContent metadata={metadata} />
  ) : metadata.mode === "fixed" ? (
    t(($) => $.tooltip.fixed)
  ) : (
    <AdaptTooltipContent metadata={metadata} />
  );
  return (
    <BadgeShell tooltip={tooltip} leading={leading} className={className}>
      <CurrentChip current={state.current} trend={state.trend} />
    </BadgeShell>
  );
}

function SummaryChipLabel({ summary }: { summary: ThinkingRunSummary }) {
  const { t } = useT("thinking");
  if (summary.mode === "fixed") {
    const level =
      summary.peak ??
      summary.samples.findLast((s) => s.metadata.level !== "")?.metadata.level ??
      "";
    return <span className="font-sans">{t(($) => $.summary_fixed, { level })}</span>;
  }
  const parts = [
    t(($) => $.mode_adapt),
    t(($) => $.step_count, { count: summary.steps }),
  ];
  if (summary.peak) parts.push(t(($) => $.peak_level, { level: summary.peak }));
  return <span className="font-sans">{parts.join(" · ")}</span>;
}

function SummaryStepLine({ sample, index }: { sample: ThinkingSample; index: number }) {
  const { t } = useT("thinking");
  const reason = useFallbackReason(
    sample.metadata.level === "" || sample.metadata.fallback !== undefined
      ? sample.metadata.fallback
      : undefined,
  );
  const step = sample.metadata.step ?? index + 1;
  const level =
    sample.metadata.level === ""
      ? `${t(($) => $.tooltip.step_default)} · ${reason}`
      : sample.metadata.fallback !== undefined
        ? `${sample.metadata.level} · ${t(($) => $.tooltip.step_carried)} · ${reason}`
        : sample.metadata.level;
  return (
    <span className="tabular-nums">
      #{step} {level}
    </span>
  );
}

function SummaryTooltipContent({ summary }: { summary: ThinkingRunSummary }) {
  const { t } = useT("thinking");
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{t(($) => $.tooltip.sequence)}</span>
      {summary.samples.map((sample, index) => (
        <SummaryStepLine key={sample.seq} sample={sample} index={index} />
      ))}
      {summary.fallbacks > 0 && (
        <span className="pt-0.5 text-muted-foreground">
          {t(($) => $.tooltip.fallback_count, { count: summary.fallbacks })}
        </span>
      )}
    </span>
  );
}

/** The post-run rollup kept in the transcript dialog header. */
export function ThinkingRunSummaryBadge({ messages, className, leading }: BadgeProps) {
  const summary = useMemo(() => summarizeThinkingRun(messages), [messages]);
  if (!summary) return null;
  return (
    <BadgeShell tooltip={<SummaryTooltipContent summary={summary} />} leading={leading} className={className}>
      <SummaryChipLabel summary={summary} />
    </BadgeShell>
  );
}
