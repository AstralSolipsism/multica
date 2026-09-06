// Pure helpers for the machine-level host metrics sample
// (`RuntimeDevice.system_stats` — optional, older backends omit it). Every
// function degrades to "no data" (null) instead of throwing or inventing
// numbers; the UI layers the fresh / stale / not-reported states on top of
// these primitives.

import type { AgentRuntime, RuntimeSystemStats } from "../types";
import { RuntimeSystemStatsSchema } from "../api/schemas";
import type { QuotaTone } from "./plan-quota";

/**
 * Sanitize a raw `system_stats` payload. A malformed snapshot returns null
 * (caller renders the not-reported state). Never throws.
 */
export function parseSystemStats(raw: unknown): RuntimeSystemStats | null {
  if (raw == null) return null;
  const parsed = RuntimeSystemStatsSchema.safeParse(raw);
  if (!parsed.success) return null;
  // A sample with no usable timestamp cannot be ranked or freshness-judged.
  if (parsed.data.captured_at <= 0) return null;
  return parsed.data;
}

/** Machine-level CPU/memory: the freshest sample among the machine's online
 *  runtimes, falling back to all runtimes when none of the online ones carry
 *  a sample. Null when no runtime ever reported — never a fabricated 0. */
export function pickMachineSystemStats(
  runtimes: AgentRuntime[],
): RuntimeSystemStats | null {
  const online = runtimes.filter((runtime) => runtime.status === "online");
  return latestSystemStats(online) ?? latestSystemStats(runtimes);
}

function latestSystemStats(runtimes: AgentRuntime[]): RuntimeSystemStats | null {
  let best: RuntimeSystemStats | null = null;
  for (const runtime of runtimes) {
    const stats = parseSystemStats(runtime.system_stats);
    if (!stats) continue;
    if (!best || stats.captured_at > best.captured_at) best = stats;
  }
  return best;
}

/** Host metric usage tone: >=80% warning, >=90% destructive (the inverse
 *  direction of quotaTone, whose input is REMAINING percentage). */
export function metricsTone(percent: number | null): QuotaTone {
  if (percent == null) return "ok";
  if (percent >= 90) return "destructive";
  if (percent >= 80) return "warning";
  return "ok";
}

/** Freshness SLA for online host metrics: the daemon samples every 15s, so
 *  30s covers one missed cycle. Mirrors the server's hostMetricsFreshnessSLA —
 *  the server's `stale` flag at response time is the authoritative signal. */
export const SYSTEM_STATS_STALE_MS = 30_000;

/** Bounded freshness re-sync: while an open runtime list view holds at least
 *  one system_stats sample, refetch the list at this cadence so the server's
 *  authoritative freshness (stale flag / dropped field after TTL expiry)
 *  keeps reaching the page even though unchanged content deliberately
 *  broadcasts nothing. */
export const SYSTEM_STATS_REFRESH_MS = 30_000;

/** Slower recovery cadence while NO runtime carries a sample: the bounded
 *  path back to live data after samples vanished (Redis TTL expiry during a
 *  sampler pause, a transient read failure) — the server announces a resumed
 *  machine via the telemetry event too, but the poll does not depend on it. */
export const SYSTEM_STATS_RECOVERY_MS = 60_000;

/** True when any runtime in the list currently carries a host metrics
 *  sample — the condition under which the bounded freshness poll runs. */
export function runtimeListHasSystemStats(
  runtimes: AgentRuntime[] | undefined,
): boolean {
  return runtimes?.some((runtime) => runtime.system_stats != null) === true;
}

/** Client-side staleness backstop BETWEEN the bounded refetches: the local
 *  threshold is deliberately 2× the server SLA so a healthy daemon (the
 *  server refreshes captured_at every cycle and the poll delivers it within
 *  30s) never flickers stale, while a page that somehow misses its polls
 *  still ages out on its ticking clock. Server-flagged stale is always
 *  honored. Skew note: captured_at is the daemon's clock; the server already
 *  rejects samples more than 2min ahead of its own clock, and a
 *  modestly-behind daemon clock only ages the local backstop slightly
 *  early — the honest failure mode. */
export function isSystemStatsStale(
  stats: RuntimeSystemStats,
  nowMs: number,
): boolean {
  return (
    stats.stale ||
    nowMs - stats.captured_at * 1000 > 2 * SYSTEM_STATS_STALE_MS
  );
}
