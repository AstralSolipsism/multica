import type {
  TaskMessagePayload,
  TaskMessageThinkingMetadata,
} from "../types/events";

// Contract: docs/engineering/labrastro-thinking-adapt.md §7, §9. The badge
// reads `metadata.thinking` straight off the raw message stream — never the
// merged timeline — so these helpers take `TaskMessagePayload[]`.

/** Known level tokens, cheapest first. Custom CLI values are not orderable. */
export const THINKING_LEVEL_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

/** Rank within the known ladder; `undefined` for custom (unorderable) values. */
export function thinkingLevelRank(level: string): number | undefined {
  const index = (THINKING_LEVEL_ORDER as readonly string[]).indexOf(level);
  return index >= 0 ? index : undefined;
}

/** One tagged step in a run: the thinking metadata plus where it was seen. */
export interface ThinkingSample {
  seq: number;
  metadata: TaskMessageThinkingMetadata;
}

function stepKey(metadata: TaskMessageThinkingMetadata): string {
  // Claude tags every message of a step with the same decision, so a defined
  // step number is the identity. Runtimes that do not number steps fall back
  // to content identity: consecutive duplicates still collapse into one
  // sample, while a changed level or fallback starts a new one.
  if (metadata.step !== undefined) return `step:${metadata.step}`;
  const m = metadata;
  return `content:${m.mode}:${m.level}:${m.fallback ?? ""}`;
}

/**
 * The run's tagged steps in seq order, deduplicated per step. Messages carry
 * no ordering guarantee from every writer, so the input is sorted by seq
 * first rather than trusted to arrive ordered.
 */
export function collectThinkingSamples(
  messages: readonly TaskMessagePayload[],
): ThinkingSample[] {
  const samples: ThinkingSample[] = [];
  for (const message of messages) {
    const thinking = message.metadata?.thinking;
    if (thinking) samples.push({ seq: message.seq, metadata: thinking });
  }
  samples.sort((a, b) => a.seq - b.seq);
  const out: ThinkingSample[] = [];
  for (const sample of samples) {
    const prev = out[out.length - 1];
    if (prev && stepKey(prev.metadata) === stepKey(sample.metadata)) {
      out[out.length - 1] = sample;
      continue;
    }
    out.push(sample);
  }
  return out;
}

export type ThinkingTrend = "up" | "down" | "flat";

export interface CurrentThinkingLevel {
  /** The latest tagged step — what the badge shows while the run is live. */
  current: ThinkingSample;
  /** Comparison against the previous step; absent when no arrow may be shown. */
  trend?: ThinkingTrend;
}

/**
 * The level in effect right now: the most recent message carrying
 * `metadata.thinking`, regardless of message type. Arrows compare it with the
 * previous tagged step and only exist when both levels sit on the known
 * ladder — a fallback step or a custom token has nothing to compare against.
 */
export function currentThinkingLevel(
  messages: readonly TaskMessagePayload[],
): CurrentThinkingLevel | undefined {
  const samples = collectThinkingSamples(messages);
  const current = samples[samples.length - 1];
  if (!current) return undefined;
  const previous = samples[samples.length - 2];
  let trend: ThinkingTrend | undefined;
  if (
    current.metadata.mode === "adapt" &&
    current.metadata.level !== "" &&
    previous &&
    previous.metadata.level !== ""
  ) {
    const now = thinkingLevelRank(current.metadata.level);
    const before = thinkingLevelRank(previous.metadata.level);
    if (now !== undefined && before !== undefined) {
      trend = now > before ? "up" : now < before ? "down" : "flat";
    }
  }
  return { current, trend };
}

export interface ThinkingRunSummary {
  mode: "adapt" | "fixed";
  /** Every tagged step in order — the per-step level sequence. */
  samples: ThinkingSample[];
  /** Adapt decisions that produced a level (fallbacks excluded). */
  decisions: number;
  /** Steps that fell back to the default level. */
  fallbacks: number;
  /** Highest known level reached; undefined when nothing was orderable. */
  peak?: string;
}

/** The post-run rollup shown in the transcript dialog header. */
export function summarizeThinkingRun(
  messages: readonly TaskMessagePayload[],
): ThinkingRunSummary | undefined {
  const samples = collectThinkingSamples(messages);
  const first = samples[0];
  if (!first) return undefined;
  let decisions = 0;
  let fallbacks = 0;
  let peak: string | undefined;
  let peakRank = -1;
  for (const sample of samples) {
    const { level, mode } = sample.metadata;
    if (level === "") {
      fallbacks += 1;
      continue;
    }
    if (mode === "adapt") decisions += 1;
    const rank = thinkingLevelRank(level);
    if (rank !== undefined && rank > peakRank) {
      peakRank = rank;
      peak = level;
    }
  }
  return { mode: first.metadata.mode, samples, decisions, fallbacks, peak };
}
