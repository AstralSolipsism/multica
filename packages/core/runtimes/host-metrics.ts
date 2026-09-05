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
