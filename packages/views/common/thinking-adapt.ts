import { useT } from "../i18n";

export interface ThinkingAdaptViewSnapshot {
  status: string;
  active_source?: string | null;
  last_latency_ms?: number | null;
  decisions_ok?: number;
  decisions_fallback?: number;
}

type QuotaT = ReturnType<typeof useT<"quota">>["t"];

export function thinkingAdaptSourceLabel(source: string, t: QuotaT): string {
  switch (source) {
    case "opencode-free":
      return t(($) => $.thinking_adapt.source_opencode_free);
    case "opencode":
      return t(($) => $.thinking_adapt.source_opencode);
    case "dashscope":
      return t(($) => $.thinking_adapt.source_dashscope);
    case "self-hosted":
      return t(($) => $.thinking_adapt.source_self_hosted);
    default:
      return source;
  }
}

export function thinkingAdaptStatusLabel(
  snapshot: ThinkingAdaptViewSnapshot | null | undefined,
  t: QuotaT,
): string {
  switch (snapshot?.status) {
    case "available":
      return t(($) => $.thinking_adapt.available);
    case "degraded":
      return t(($) => $.thinking_adapt.degraded);
    case "idle":
      return t(($) => $.thinking_adapt.idle);
    default:
      return t(($) => $.thinking_adapt.unavailable);
  }
}

export function thinkingAdaptSubtitle(
  snapshot: ThinkingAdaptViewSnapshot | null | undefined,
  t: QuotaT,
): string {
  const parts = [thinkingAdaptStatusLabel(snapshot, t)];
  if (snapshot?.status === "available" && snapshot.active_source) {
    parts.push(thinkingAdaptSourceLabel(snapshot.active_source, t));
  }
  if (
    snapshot?.status === "available" &&
    snapshot.last_latency_ms != null
  ) {
    parts.push(`${snapshot.last_latency_ms}ms`);
  }
  return parts.join(" · ");
}
