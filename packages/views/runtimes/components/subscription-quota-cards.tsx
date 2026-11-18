"use client";

import type { ReactNode } from "react";
import type { QuotaSourceBalance, WorkspaceQuotaSource } from "@multica/core/api";
import {
  formatCompactDuration,
  isCollectorObservationInterrupted,
  planQuotaState,
  quotaTone,
  type QuotaTone,
  type QuotaWindowState,
} from "@multica/core/runtimes";
import { AlertCircle } from "@multica/ui/icons";
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

function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency} `;
}

// "¥48.50" for known currency codes, "CNY 48.50" for anything else. A null
// total renders an em dash (provider reported the bucket but no amount).
// Exhausted balances clamp to zero on the card surface so a stale negative
// provider figure never reads as spendable money.
function formatBalanceAmount(balance: QuotaSourceBalance, exhausted = false): string {
  const symbol = currencySymbol(balance.currency);
  const amount = exhausted ? "0.00" : balance.total_balance == null ? "—" : balance.total_balance.toFixed(2);
  return `${symbol}${amount}`;
}

function formatRawBalanceAmount(balance: QuotaSourceBalance): string {
  const symbol = currencySymbol(balance.currency);
  return `${symbol}${balance.total_balance == null ? "—" : balance.total_balance.toFixed(2)}`;
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
    case "opencode":
      // Go windows: "5h" / "7d" / "30d" read better than the raw id.
      return period ?? tRuntimes(($) => $.quota_sources.cards.subscription_window);
    default:
      return window.name || period || tRuntimes(($) => $.quota_sources.cards.generic_window);
  }
}

// Short surface label for a compact window chip ("5h", "7d", "30d").
function compactWindowLabel(
  window: QuotaWindowState,
  t: QuotaT,
  tRuntimes: RuntimesT,
): string {
  return (
    formatQuotaWindowLabel(window.windowMinutes, t) ??
    subscriptionWindowLabel(window, t, tRuntimes)
  );
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
    <section
      aria-label={t(($) => $.quota_sources.cards.region)}
      className="flex flex-wrap items-center gap-2"
    >
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
  const errorLabel = source.last_error ? quotaSourceErrorLabel(source.last_error.code, t) : null;
  // A probe pill already states the failure; otherwise a compact "Error"
  // marker hints at it and the full reason stays in the tooltip.
  const errorConveyed = !!probe || (source.kind === "jev_free" && !!source.last_error);
  const surfaceError = errorLabel && !errorConveyed ? errorLabel : null;
  // A successful snapshot carries observed_at; before the first snapshot the
  // server still records when the probe ran, and "last checked" must not
  // disappear from the tooltip on that failure path.
  const lastPolledMs = source.last_polled_at ? Date.parse(source.last_polled_at) : NaN;
  const observedLabel = observedAt > 0
    ? interrupted
      ? quotaInterruptedText(observedAt, now, tQuota, formatTime)
      : tQuota(($) => $.observed_ago, {
          time: formatCompactDuration(now - observedAt * 1000),
        })
    : Number.isFinite(lastPolledMs)
      ? tQuota(($) => $.observed_ago, {
          time: formatCompactDuration(now - lastPolledMs),
        })
      : null;

  // Surface value: money balance, subscription windows, or a probe latency.
  // The last-updated time and the breakdown stay inside the tooltip.
  const surface: ReactNode[] = [];
  if (balances.length > 0) {
    for (const [index, balance] of balances.entries()) {
      const exhausted = balanceExhausted(quota, balance);
      surface.push(
        <span
          key={`${balance.currency}-${index}`}
          className={cn(
            "text-caption tabular-nums",
            muted
              ? "text-muted-foreground"
              : exhausted
                ? "text-destructive"
                : "text-success",
          )}
        >
          {exhausted
            ? t(($) => $.quota_sources.cards.balance_chip_exhausted, {
                amount: formatBalanceAmount(balance, true),
              })
            : formatBalanceAmount(balance)}
        </span>,
      );
    }
  } else if (windows.length > 0) {
    surface.push(
      <span key="windows" className="flex flex-wrap items-center gap-1">
        {windows.map((window, index) => {
          const label = compactWindowLabel(window, tQuota, t);
          const percent = window.remainingPercent == null
            ? "—"
            : `${Math.max(0, Math.round(window.remainingPercent))}%`;
          return (
            <span
              key={`${window.name}-${window.windowMinutes ?? "unknown"}-${index}`}
              className={cn(
                "rounded-full px-1.5 py-0.5 text-micro tabular-nums",
                muted ? "bg-muted text-muted-foreground" : CHIP_TONE_CLASS[quotaTone(window.remainingPercent)],
              )}
            >
              {t(($) => $.quota_sources.cards.window_chip, { label, percent })}
            </span>
          );
        })}
      </span>,
    );
  } else if (probe) {
    const tone = probe.available === false
      ? "destructive"
      : source.last_error
        ? source.last_error.code === "rate_limited" ? "warning" : "destructive"
        : interrupted
          ? null
          : "ok";
    surface.push(
      <span
        key="probe"
        className={cn(
          "rounded-full px-1.5 py-0.5 text-micro tabular-nums",
          tone ? CHIP_TONE_CLASS[tone] : "bg-muted text-muted-foreground",
        )}
      >
        {probe.available === false
          ? source.kind === "jev_free"
            ? t(($) => $.quota_sources.cards.probe_abnormal)
            : t(($) => $.quota_sources.cards.balance_exhausted)
          : source.last_error
            ? t(($) => $.quota_sources.cards[source.last_error?.code === "rate_limited" ? "probe_rate_limited" : "probe_abnormal"])
            : t(($) => $.quota_sources.cards.probe_latency, { latency: probe.latency_ms })}
      </span>,
    );
  } else if (source.kind === "jev_free" && source.last_error) {
    surface.push(
      <span
        key="probe-error"
        className={cn(
          "rounded-full px-1.5 py-0.5 text-micro",
          CHIP_TONE_CLASS[source.last_error.code === "rate_limited" ? "warning" : "destructive"],
        )}
      >
        {source.last_error.code === "rate_limited"
          ? t(($) => $.quota_sources.cards.probe_rate_limited)
          : t(($) => $.quota_sources.cards.probe_abnormal)}
      </span>,
    );
  } else {
    surface.push(
      <span key="waiting" className="text-caption text-muted-foreground">
        {t(($) => $.quota_sources.cards.waiting)}
      </span>,
    );
  }

  const details: ReactNode[] = [];
  for (const [index, balance] of balances.entries()) {
    const exhausted = balanceExhausted(quota, balance);
    details.push(
      <div key={`balance-${index}`} className="space-y-0.5">
        <div>
          {t(($) => $.quota_sources.cards.available_balance, {
            amount: formatRawBalanceAmount(balance),
          })}
        </div>
        {balance.spend_30d != null && (
          <div className="text-tooltip-foreground/80">
            {t(($) => $.quota_sources.cards.spend_30d, {
              amount: `${currencySymbol(balance.currency)}${balance.spend_30d.toFixed(2)}`,
            })}
          </div>
        )}
        {balance.topped_up_balance != null && (
          <div className="text-tooltip-foreground/80">
            {t(($) => $.quota_sources.cards.topped_up, {
              amount: `${currencySymbol(balance.currency)}${balance.topped_up_balance.toFixed(2)}`,
            })}
          </div>
        )}
        {balance.granted_balance != null && (
          <div className="text-tooltip-foreground/80">
            {t(($) => $.quota_sources.cards.granted, {
              amount: `${currencySymbol(balance.currency)}${balance.granted_balance.toFixed(2)}`,
            })}
          </div>
        )}
        {exhausted && (
          <div className="text-destructive">
            {t(($) => $.quota_sources.cards.balance_exhausted)}
          </div>
        )}
      </div>,
    );
  }
  for (const [index, window] of windows.entries()) {
    const label = subscriptionWindowLabel(window, tQuota, t);
    const remaining = window.remainingPercent == null
      ? tQuota(($) => $.unknown)
      : tQuota(($) => $.remaining, {
          percent: Math.max(0, Math.round(window.remainingPercent)),
        });
    const reset = quotaWindowResetText(window, now, tQuota, formatTime);
    details.push(
      <div key={`window-${window.name}-${index}`}>
        <div>{label} · {remaining}</div>
        {reset && <div className="text-tooltip-foreground/80">{reset}</div>}
      </div>,
    );
  }
  if (probe) {
    details.push(
      <div key="probe-detail">
        {probe.available === false
          ? t(($) => $.quota_sources.cards.probe_abnormal)
          : t(($) => $.quota_sources.cards.probe_status_ok)}
        {` · ${t(($) => $.quota_sources.cards.probe_latency, { latency: probe.latency_ms })}`}
      </div>,
    );
  }
  if (errorLabel) {
    details.push(
      <div key="error" className="text-destructive">
        {errorLabel}
      </div>,
    );
  }
  if (observedLabel) {
    details.push(
      <div key="observed" className="text-tooltip-foreground/80">
        {observedLabel}
      </div>,
    );
  }

  const ariaLabel = [
    source.name,
    ...balances.map((balance) => formatBalanceAmount(balance, balanceExhausted(quota, balance))),
    ...windows.map((window) => {
      const percent = window.remainingPercent == null ? "—" : `${Math.max(0, Math.round(window.remainingPercent))}%`;
      return `${compactWindowLabel(window, tQuota, t)} ${percent}`;
    }),
    probe ? `${probe.latency_ms}ms` : "",
    errorLabel ?? "",
  ].filter(Boolean).join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <article
            tabIndex={0}
            aria-label={ariaLabel}
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <QuotaSourceIcon kind={source.kind} className="size-4" />
            <span className="max-w-40 truncate text-caption font-medium">
              {source.name}
            </span>
            {surfaceError && (
              <span className="flex items-center gap-0.5 text-micro text-destructive">
                <AlertCircle aria-hidden="true" className="size-3" />
                {t(($) => $.quota_sources.cards.error_short)}
              </span>
            )}
            {interrupted && !surfaceError && (
              <span className="text-micro text-warning">
                {tQuota(($) => $.collection_interrupted)}
              </span>
            )}
            <span className="text-muted-foreground">·</span>
            <span className="flex min-w-0 items-center gap-1">{surface}</span>
          </article>
        }
      />
      <TooltipContent className="block max-w-sm">
        <div className="space-y-1 text-caption">
          <div className="font-medium">{source.name}</div>
          {details}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
