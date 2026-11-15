"use client";

import type { QuotaSourceBalance, WorkspaceQuotaSource } from "@multica/core/api";
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

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

// "¥48.50" for known currency codes, "CNY 48.50" for anything else. A null
// total renders an em dash (provider reported the bucket but no amount).
function formatBalanceAmount(balance: QuotaSourceBalance): string {
  const symbol = CURRENCY_SYMBOLS[balance.currency.toUpperCase()] ?? `${balance.currency} `;
  const amount = balance.total_balance == null ? "—" : balance.total_balance.toFixed(2);
  return `${symbol}${amount}`;
}

function balanceExhausted(
  quota: WorkspaceQuotaSource["quota"],
  balance: QuotaSourceBalance,
): boolean {
  if (quota?.available === false || quota?.status === "limited") return true;
  return balance.total_balance != null && balance.total_balance <= 0;
}


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
  const quota = source.quota ?? null;
  const balances = quota?.balances ?? [];
  const probe = quota?.probe ?? null;
  const observedAt = quota?.observed_at ?? 0;
  const interrupted = observedAt > 0 && isCollectorObservationInterrupted(observedAt, now);
  const muted = interrupted || (!!source.last_error && balances.length === 0 && !probe);
  const shared = source.visibility === "shared";
  // The free-channel monitor shows its own colored state pill instead of
  // the muted treatment when polling fails.
  const lastPolledMs = source.last_polled_at ? Date.parse(source.last_polled_at) : NaN;

  const observedLine = (
    <div className="text-muted-foreground">
      {interrupted
        ? quotaInterruptedText(observedAt, now, tQuota, formatTime)
        : observedAt > 0
          ? tQuota(($) => $.observed_ago, {
              time: formatCompactDuration(now - observedAt * 1000),
            })
          : null}
    </div>
  );

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
                  {observedAt > 0 && observedLine}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}

        {balances.map((balance, index) => {
          const exhausted = balanceExhausted(quota, balance);
          const amount = formatBalanceAmount(balance);
          const line = exhausted
            ? t(($) => $.quota_sources.cards.balance_exhausted)
            : t(($) => $.quota_sources.cards.balance_available, { amount });
          const breakdown = [
            balance.topped_up_balance != null
              ? t(($) => $.quota_sources.cards.topped_up, {
                  amount: `${CURRENCY_SYMBOLS[balance.currency.toUpperCase()] ?? `${balance.currency} `}${balance.topped_up_balance.toFixed(2)}`,
                })
              : null,
            balance.granted_balance != null
              ? t(($) => $.quota_sources.cards.granted, {
                  amount: `${CURRENCY_SYMBOLS[balance.currency.toUpperCase()] ?? `${balance.currency} `}${balance.granted_balance.toFixed(2)}`,
                })
              : null,
          ].filter(Boolean);
          return (
            <Tooltip key={`${balance.currency}-${index}`}>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    aria-label={[line, ...breakdown].filter(Boolean).join(" · ")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      muted ? "bg-muted text-muted-foreground" : CHIP_TONE_CLASS[exhausted ? "destructive" : "ok"],
                    )}
                  >
                    <span className="text-muted-foreground">{balance.currency}</span>
                    <span>{line}</span>
                  </span>
                }
              />
              <TooltipContent>
                <div className="space-y-0.5 text-caption">
                  <div>{line}</div>
                  {breakdown.map((entry) => (
                    <div key={entry}>{entry}</div>
                  ))}
                  {observedAt > 0 && observedLine}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}

        {windows.length === 0 && balances.length === 0 && probe && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption tabular-nums",
              probe.available === false
                ? CHIP_TONE_CLASS.destructive
                : source.last_error
                  ? CHIP_TONE_CLASS[source.last_error.code === "rate_limited" ? "warning" : "destructive"]
                  : interrupted
                    ? "bg-muted text-muted-foreground"
                    : CHIP_TONE_CLASS.ok,
            )}
          >
            {probe.available === false
              // A parsed unavailable probe (402 / Insufficient balance)
              // outranks last_error: never render "healthy" text with a
              // destructive style.
              ? source.kind === "jev_free"
                ? t(($) => $.quota_sources.cards.probe_abnormal)
                : t(($) => $.quota_sources.cards.balance_exhausted)
              : source.last_error
                ? t(($) => $.quota_sources.cards[source.last_error?.code === "rate_limited" ? "probe_rate_limited" : "probe_abnormal"])
                : source.kind === "jev_free"
                  ? t(($) => $.quota_sources.cards.probe_ok, { latency: probe.latency_ms })
                  : t(($) => $.quota_sources.cards.probe_account_ok, { latency: probe.latency_ms })}
          </span>
        )}

        {windows.length === 0 && balances.length === 0 && !probe && source.kind === "jev_free" && source.last_error && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption",
              CHIP_TONE_CLASS[source.last_error.code === "rate_limited" ? "warning" : "destructive"],
            )}
          >
            {source.last_error.code === "rate_limited"
              ? t(($) => $.quota_sources.cards.probe_rate_limited)
              : t(($) => $.quota_sources.cards.probe_abnormal)}
          </span>
        )}

        {source.kind === "jev_free" && source.last_error && Number.isFinite(lastPolledMs) && (
          <span className="text-micro tabular-nums text-faint-foreground">
            {tQuota(($) => $.observed_ago, {
              time: formatCompactDuration(now - lastPolledMs),
            })}
          </span>
        )}

        {windows.length === 0 && balances.length === 0 && !probe && !source.last_error && source.kind !== "jev_free" && (
          <span className="text-caption text-muted-foreground">
            {t(($) => $.quota_sources.cards.waiting)}
          </span>
        )}
        {observedAt > 0 && !interrupted && source.kind !== "jev_free" && (
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
