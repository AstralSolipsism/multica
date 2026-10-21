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
  // Tags without a step number belong to the run-level decision and count as
  // exactly one step (OL-1000 addendum): a runtime that tags every thinking
  // message of a run with that one decision still summarizes as a single
  // step. Claude tags every message of a step with the step's decision, so a
  // defined step number is the identity there.
  if (metadata.step !== undefined) return `step:${metadata.step}`;
  return "run";
}

/**
 * The run's tagged steps in seq order, one sample per step. Messages carry
 * no ordering guarantee from every writer, so the input is sorted by seq
 * first rather than trusted to arrive ordered. Grouping is by step, not by
 * adjacency: several tagged messages of one step (its first message plus its
 * thinking messages) collapse into that step's latest tag.
 */
export function collectThinkingSamples(
  messages: readonly TaskMessagePayload[],
): ThinkingSample[] {
  const tagged: ThinkingSample[] = [];
  for (const message of messages) {
    const thinking = message.metadata?.thinking;
    if (thinking) tagged.push({ seq: message.seq, metadata: thinking });
  }
  tagged.sort((a, b) => a.seq - b.seq);
  const byStep = new Map<string, ThinkingSample>();
  const order: string[] = [];
  for (const sample of tagged) {
    const key = stepKey(sample.metadata);
    if (!byStep.has(key)) order.push(key);
    byStep.set(key, sample);
  }
  return order.map((key) => byStep.get(key)!);
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
 * previous tagged STEP (not the previous tagged message) and only exist when
 * both levels sit on the known ladder. A step that fell back (`fallback`
 * set) never gets an arrow: a run-level fallback has no level to show, and a
 * step-level fallback merely carried the previous level over.
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
    current.metadata.fallback === undefined &&
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
  /** How many steps the run had — the "N 次" of the summary chip. */
  steps: number;
  /** Steps whose tag carries a `fallback` (run-level or step-level). */
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
  let fallbacks = 0;
  let peak: string | undefined;
  let peakRank = -1;
  for (const sample of samples) {
    const { level, fallback } = sample.metadata;
    if (fallback !== undefined) fallbacks += 1;
    if (level === "") continue;
    const rank = thinkingLevelRank(level);
    if (rank !== undefined && rank > peakRank) {
      peakRank = rank;
      peak = level;
    }
  }
  return { mode: first.metadata.mode, samples, steps: samples.length, fallbacks, peak };
}
