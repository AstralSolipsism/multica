"use client";

import type { WorkspaceQuotaSource } from "@multica/core/api";
import {
  formatCompactDuration,
  isCollectorObservationInterrupted,
  planQuotaState,
  quotaTone,
  type QuotaTone,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import { AlertCircle, Globe, Lock } from "@multica/ui/icons";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { useQuotaTimeFormatter } from "./quota-time";
import {
  formatQuotaWindowLabel,
  quotaInterruptedText,
  quotaWindowResetText,
} from "./runtime-quota-cell";
import {
  QuotaSourceIcon,
  quotaSourceErrorLabel,
  quotaSourceKindLabel,
} from "./quota-source-shared";

type QuotaT = ReturnType<typeof useT<"quota">>["t"];
type RuntimesT = ReturnType<typeof useT<"runtimes">>["t"];

const CHIP_TONE_CLASS: Record<QuotaTone, string> = {
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export function subscriptionQuotaWindows(
  source: Pick<WorkspaceQuotaSource, "quota">,
  now: number,
): QuotaWindowState[] {
  const state = planQuotaState(source.quota, now);
  if (!state) return [];
  return state.pools.flatMap((pool) => pool.windows).sort((a, b) =>
    (a.remainingPercent ?? 101) - (b.remainingPercent ?? 101)
  );
}

export function subscriptionWindowLabel(
  window: QuotaWindowState,
  t: QuotaT,
  tRuntimes: RuntimesT,
): string {
  const period = formatQuotaWindowLabel(window.windowMinutes, t);
  const group = window.group ?? window.name.split("_")[0] ?? "";
  switch (group) {
    case "tokens":
      if (window.windowMinutes === 300) return t(($) => $.glm_window_tokens);
      if (window.windowMinutes === 10080) return t(($) => $.glm_window_tokens_weekly);
      return period
        ? tRuntimes(($) => $.quota_sources.cards.tokens_period, { period })
        : t(($) => $.glm_window_tokens_generic);
    case "credits":
      if (window.windowMinutes === 300) return t(($) => $.glm_window_credit);
      if (window.windowMinutes === 10080) return t(($) => $.glm_window_credit_weekly);
      return period
        ? tRuntimes(($) => $.quota_sources.cards.credits_period, { period })
        : t(($) => $.glm_window_credit_generic);
    case "tools":
      return period
        ? tRuntimes(($) => $.quota_sources.cards.tools_period, { period })
        : t(($) => $.glm_window_time);
    case "zenmux":
      return period
        ? tRuntimes(($) => $.quota_sources.cards.subscription_period, { period })
        : tRuntimes(($) => $.quota_sources.cards.subscription_window);
    default:
      return window.name || period || tRuntimes(($) => $.quota_sources.cards.generic_window);
  }
}

export function SubscriptionQuotaCards({
  sources,
  now,
}: {
  sources: WorkspaceQuotaSource[] | undefined;
  now: number;
}) {
  const { t } = useT("runtimes");
  if (!sources?.length) return null;
  return (
    <section aria-label={t(($) => $.quota_sources.cards.region)} className="flex flex-col gap-2">
      {sources.map((source) => (
        <SubscriptionQuotaCard key={source.id} source={source} now={now} />
      ))}
    </section>
  );
}

function SubscriptionQuotaCard({
  source,
  now,
}: {
  source: WorkspaceQuotaSource;
  now: number;
}) {
  const { t } = useT("runtimes");
  const { t: tQuota } = useT("quota");
  const formatTime = useQuotaTimeFormatter();
  const windows = subscriptionQuotaWindows(source, now);
  const observedAt = source.quota?.observed_at ?? 0;
  const interrupted = observedAt > 0 && isCollectorObservationInterrupted(observedAt, now);
  const muted = interrupted || !!source.last_error;
  const shared = source.visibility === "shared";

  return (
    <article className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <QuotaSourceIcon kind={source.kind} />
        <span className="max-w-64 truncate text-body font-medium">{source.name}</span>
        <span className="text-caption text-muted-foreground">
          {quotaSourceKindLabel(source.kind, t)}
        </span>
        <Badge variant="secondary" className="gap-1 font-normal">
          {shared ? <Globe aria-hidden="true" /> : <Lock aria-hidden="true" />}
          {shared
            ? t(($) => $.quota_sources.visibility.shared)
            : t(($) => $.quota_sources.visibility.private)}
        </Badge>
        {source.last_error && (
          <Badge variant="destructive" className="gap-1 font-normal">
            <AlertCircle aria-hidden="true" />
            {quotaSourceErrorLabel(source.last_error.code, t)}
          </Badge>
        )}
        {interrupted && (
          <span className="text-caption tabular-nums text-muted-foreground">
            {quotaInterruptedText(observedAt, now, tQuota, formatTime)}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5">
        {windows.map((window, index) => {
          const label = subscriptionWindowLabel(window, tQuota, t);
          const reset = quotaWindowResetText(window, now, tQuota, formatTime);
          const tone = quotaTone(window.remainingPercent);
          const remaining = window.remainingPercent == null
            ? tQuota(($) => $.unknown)
            : tQuota(($) => $.remaining, { percent: Math.max(0, Math.round(window.remainingPercent)) });
          return (
            <Tooltip key={`${window.name}-${window.windowMinutes ?? "unknown"}-${index}`}>
              <TooltipTrigger
                render={
                  <span
                    aria-label={[label, remaining, reset].filter(Boolean).join(" · ")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption",
                      muted ? "bg-muted text-muted-foreground" : CHIP_TONE_CLASS[tone],
                    )}
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span className="tabular-nums">{remaining}</span>
                  </span>
                }
              />
              <TooltipContent>
                <div className="space-y-0.5 text-caption">
                  <div>{label} · {remaining}</div>
                  {reset && <div>{reset}</div>}
                  {observedAt > 0 && (
                    <div className="text-muted-foreground">
                      {interrupted
                        ? quotaInterruptedText(observedAt, now, tQuota, formatTime)
                        : tQuota(($) => $.observed_ago, {
                            time: formatCompactDuration(now - observedAt * 1000),
                          })}
                    </div>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
        {windows.length === 0 && !source.last_error && (
          <span className="text-caption text-muted-foreground">
            {t(($) => $.quota_sources.cards.waiting)}
          </span>
        )}
        {observedAt > 0 && !interrupted && (
          <span className="text-micro tabular-nums text-faint-foreground">
            {tQuota(($) => $.observed_ago, {
              time: formatCompactDuration(now - observedAt * 1000),
            })}
          </span>
        )}
      </div>
    </article>
  );
}
