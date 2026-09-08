"use client";

import { useQuery } from "@tanstack/react-query";
import { quotaTone, type QuotaTone } from "@multica/core/runtimes";
import { glmQuotaOptions } from "@multica/core/runtimes/queries";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { useT, useTimeAgo } from "../../i18n";
import zhipuLogo from "./zhipu-logo.svg";

// Next.js exposes static imports as objects while Vite exposes URL strings;
// normalize so the shared card works in web and desktop (same helper as
// provider-logo.tsx, kept local because that one is not exported).
function staticAssetSrc(asset: string | { src: string }): string {
  return typeof asset === "string" ? asset : asset.src;
}

// The fixed, account-level GLM (Zhipu) Coding Plan balance card for the
// runtimes page. Unlike the per-runtime quota chips, this allowance belongs
// to the provider key shared by every GLM-backed runtime (claude/hermes),
// so it is shown exactly once, above the machine list — never per runtime.

const CHIP_TONE_CLASS: Record<QuotaTone, string> = {
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export type GlmQuotaWindow = {
  type: string;
  used_percent?: number;
  usage?: number;
  current_value?: number;
  remaining?: number;
  resets_at?: number;
};

export type GlmQuotaStatusResponse = {
  enabled: boolean;
  quota?: {
    level?: string;
    windows: GlmQuotaWindow[];
    observed_at: number;
  } | null;
  stale?: boolean;
  last_error?: string;
};

// Remaining percent per window: the provider's percentage is *used*, and
// credit windows may omit it while carrying remaining/usage — compute from
// whichever pair exists. Null means "not derivable" (chip shows unknown).
export function glmWindowRemainingPercent(w: GlmQuotaWindow): number | null {
  if (w.used_percent != null) return Math.max(0, 100 - w.used_percent);
  if (w.remaining != null && w.usage != null && w.usage > 0) {
    return Math.max(0, Math.min(100, Math.round((w.remaining / w.usage) * 100)));
  }
  return null;
}

// Worst window first: the lowest remaining percent leads, so the card's
// first chip is the one a viewer would act on.
export function glmWorstFirst(windows: GlmQuotaWindow[]): GlmQuotaWindow[] {
  return [...windows].sort(
    (a, b) =>
      (glmWindowRemainingPercent(a) ?? 101) - (glmWindowRemainingPercent(b) ?? 101),
  );
}

// Compact "1h23m" style countdown for reset tooltips; locale-agnostic
// digits keep it terse next to the existing resets_in phrasing.
export function glmFormatResetIn(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h${rem}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// The compact in-row pill for the anchored machine: same visual language as
// the per-runtime MachineQuotaChips pills, so the account-level GLM balance
// reads as "one more quota on this server" rather than a detached banner.
export function GlmQuotaChip({
  data,
  now,
  interactive = true,
}: {
  data: GlmQuotaStatusResponse;
  now: number;
  /** false renders the bare pill (ghost measuring row, "+N" popover). */
  interactive?: boolean;
}) {
  const { t } = useT("runtimes");
  if (!data.enabled || !data.quota) return null;
  const windows = glmWorstFirst(data.quota.windows ?? []);
  const worst = windows[0];
  if (!worst) return null;
  const remaining = glmWindowRemainingPercent(worst);
  const tone = quotaTone(remaining, "ok");
  const pill = (
    <span
      aria-label={`GLM: ${t(($) => $.quota.glm_title)}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-micro font-medium tabular-nums ${CHIP_TONE_CLASS[tone]}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={staticAssetSrc(zhipuLogo)} alt="" className="h-3.5 w-3.5" />
      {remaining != null
        ? t(($) => $.quota.remaining, { percent: remaining })
        : t(($) => $.quota.glm_unknown)}
    </span>
  );
  if (!interactive) return pill;
  return (
    <Tooltip>
      <TooltipTrigger render={pill} />
      <TooltipContent>
        <GlmQuotaDetail data={data} now={now} />
      </TooltipContent>
    </Tooltip>
  );
}

// The GLM balance breakdown: every window with its remaining percent,
// reset countdown, and observation age. Rendered as the chip's tooltip and
// again inside the machine row's "+N" popover when the chip is collapsed.
export function GlmQuotaDetail({
  data,
  now,
}: {
  data: GlmQuotaStatusResponse;
  now: number;
}) {
  const { t } = useT("runtimes");
  const timeAgo = useTimeAgo();
  if (!data.enabled || !data.quota) return null;
  const windows = glmWorstFirst(data.quota.windows ?? []);
  return (
    <div className="space-y-0.5 text-xs">
      <div className="font-medium">{t(($) => $.quota.glm_title)}</div>
      {windows.map((w, i) => {
        const rem = glmWindowRemainingPercent(w);
        const label =
          w.type === "TOKENS_LIMIT"
            ? t(($) => $.quota.glm_window_tokens)
            : w.type === "TIME_LIMIT"
              ? t(($) => $.quota.glm_window_time)
              : w.type === "CREDIT_LIMIT"
                ? t(($) => $.quota.glm_window_credit)
                : t(($) => $.quota.glm_window_fallback, { type: w.type });
        const reset =
          w.resets_at && w.resets_at > now
            ? ` · ${t(($) => $.quota.resets_in, { time: glmFormatResetIn(w.resets_at - now) })}`
            : "";
        return (
          <div key={`${w.type}-${i}`}>
            {label}:{" "}
            {rem != null
              ? t(($) => $.quota.remaining, { percent: rem })
              : t(($) => $.quota.glm_unknown)}
            {reset}
          </div>
        );
      })}
      <div className="text-muted-foreground">
        {t(($) => $.quota.observed_ago, {
          time: timeAgo(new Date(data.quota.observed_at * 1000).toISOString()),
        })}
        {data.stale ? ` · ${t(($) => $.quota.stale)}` : ""}
      </div>
    </div>
  );
}

export function GlmQuotaCard({ now }: { now: number }) {
  const { t } = useT("runtimes");
  const timeAgo = useTimeAgo();
  const { data } = useQuery(glmQuotaOptions());

  // Unconfigured (no server key) hides the card entirely — the surface is
  // opt-in per deployment.
  if (!data || !data.enabled || !data.quota) return null;

  const windows = glmWorstFirst(data.quota.windows ?? []);
  if (windows.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-2">
      <span className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={staticAssetSrc(zhipuLogo)} alt="Zhipu" className="h-4 w-4" />
        <span className="text-sm font-medium">{t(($) => $.quota.glm_title)}</span>
        {data.quota.level ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {data.quota.level}
          </span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {windows.map((w, i) => {
          const remaining = glmWindowRemainingPercent(w);
          const tone = quotaTone(remaining, "ok");
          const label =
            w.type === "TOKENS_LIMIT"
              ? t(($) => $.quota.glm_window_tokens)
              : w.type === "TIME_LIMIT"
                ? t(($) => $.quota.glm_window_time)
                : w.type === "CREDIT_LIMIT"
                  ? t(($) => $.quota.glm_window_credit)
                  : t(($) => $.quota.glm_window_fallback, { type: w.type });
          const reset =
            w.resets_at && w.resets_at > now
              ? t(($) => $.quota.resets_in, {
                  time: glmFormatResetIn(w.resets_at - now),
                })
              : null;
          return (
            <Tooltip key={`${w.type}-${i}`}>
              <TooltipTrigger
                render={
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${CHIP_TONE_CLASS[tone]}`}
                  >
                    <span className="text-muted-foreground">{label}</span>
                    {remaining != null ? (
                      <span>{t(($) => $.quota.remaining, { percent: remaining })}</span>
                    ) : (
                      <span>{t(($) => $.quota.glm_unknown)}</span>
                    )}
                  </span>
                }
              />
              <TooltipContent>
                <div className="space-y-0.5 text-xs">
                  {w.remaining != null && w.usage != null ? (
                    <div>
                      {w.current_value ?? 0} / {w.usage}
                    </div>
                  ) : null}
                  {reset ? <div>{reset}</div> : null}
                  <div className="text-muted-foreground">
                    {t(($) => $.quota.observed_ago, {
                      time: timeAgo(new Date(data.quota!.observed_at * 1000).toISOString()),
                    })}
                    {data.stale ? ` · ${t(($) => $.quota.stale)}` : ""}
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </span>
    </div>
  );
}
