import { isTipAnchorCandidate } from "./descriptor";
import type {
  SchedulableTip,
  TipAnchorLevel,
  TipPlacement,
  TipQueueEntry,
  TipSchedule,
  TipScheduleAnchor,
  TipScheduleInput,
} from "./types";

/** Bubble dwell time per tag (OL-187 §6). */
export const TIP_DWELL_MS: Record<SchedulableTip["tag"], number> = {
  you_should_know: 8_000,
  heads_up: 15_000,
};

/** Lower rank = more specific = wins the primary position. */
const LEVEL_RANK: Record<TipAnchorLevel, number> = {
  detail_header: 0,
  row: 1,
  summary: 2,
};

/** Heads-up tips rotate ahead of lightweight ones. */
const TAG_RANK: Record<SchedulableTip["tag"], number> = {
  heads_up: 0,
  you_should_know: 1,
};

interface Candidate {
  anchor: TipScheduleAnchor;
  /** Index in the input array — the final determinism tiebreak. */
  order: number;
}

/**
 * Sub-millisecond ordering key of an RFC3339Nano timestamp: fractional-second
 * digits 4–9 as an integer. `Date.parse` stops at milliseconds, but tips from
 * one report land ~0.2–0.4 ms apart inside a single millisecond (the server's
 * `clock_timestamp()` values, OL-345), so the microsecond digits decide their
 * order. Missing or millisecond-only fractions key as 0.
 */
function subMillisecondKey(timestamp: string): number {
  const fraction = /\d{2}:\d{2}:\d{2}\.(\d+)/.exec(timestamp)?.[1];
  if (!fraction) return 0;
  return Number(fraction.slice(3, 9).padEnd(6, "0"));
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const level = LEVEL_RANK[a.anchor.descriptor.level] - LEVEL_RANK[b.anchor.descriptor.level];
  if (level !== 0) return level;
  // Same level: the anchor higher up the page wins.
  const top = a.anchor.top - b.anchor.top;
  if (top !== 0) return top;
  return a.order - b.order;
}

function placementFor(
  tip: SchedulableTip,
  candidates: Candidate[],
): TipPlacement {
  const primary = candidates.slice().sort(compareCandidates)[0]!.anchor;
  return {
    tipId: tip.id,
    anchorId: primary.id,
    level: primary.descriptor.level,
    candidateAnchorIds: candidates.map((c) => c.anchor.id),
    issueIdentifier:
      primary.descriptor.level === "summary"
        ? (primary.descriptor.scope[tip.issue_id] ?? null)
        : null,
  };
}

/** Rule 1: each tip's primary position is its most specific visible
 *  candidate; same-level ties go to the anchor higher up the page. Tips
 *  without any visible candidate are unplaceable and drop out. */
function computePlacements(
  visibleAnchors: Candidate[],
  tips: readonly SchedulableTip[],
): { placement: TipPlacement; tip: SchedulableTip; top: number }[] {
  const topByAnchorId = new Map<string, number>();
  for (const { anchor } of visibleAnchors) topByAnchorId.set(anchor.id, anchor.top);

  const placed: { placement: TipPlacement; tip: SchedulableTip; top: number }[] = [];
  for (const tip of tips) {
    const candidates = visibleAnchors.filter(({ anchor }) =>
      isTipAnchorCandidate(anchor.descriptor, tip),
    );
    if (candidates.length === 0) continue;
    const placement = placementFor(tip, candidates);
    placed.push({ placement, tip, top: topByAnchorId.get(placement.anchorId)! });
  }
  return placed;
}

function compareQueueEntries(
  a: { tip: SchedulableTip; placement: TipPlacement; top: number },
  b: { tip: SchedulableTip; placement: TipPlacement; top: number },
): number {
  const tag = TAG_RANK[a.tip.tag] - TAG_RANK[b.tip.tag];
  if (tag !== 0) return tag;
  const level = LEVEL_RANK[a.placement.level] - LEVEL_RANK[b.placement.level];
  if (level !== 0) return level;
  const top = a.top - b.top;
  if (top !== 0) return top;
  // Oldest tip first: tips are consumed in the order they were generated.
  // Date.parse, not string compare: RFC3339Nano trims trailing zeros in the
  // fractional seconds, which breaks lexicographic ordering. Unparseable or
  // empty timestamps (the schema tolerates "") fall back to 0 so the
  // comparator stays deterministic instead of yielding NaN-as-equal.
  const created =
    (Date.parse(a.tip.created_at) || 0) - (Date.parse(b.tip.created_at) || 0);
  if (created !== 0) return created;
  // Same millisecond: keep comparing the fractional digits 4–9 — tips from one
  // report differ only there, and must not drop to the random-uuid tiebreak.
  const subMillis = subMillisecondKey(a.tip.created_at) - subMillisecondKey(b.tip.created_at);
  if (subMillis !== 0) return subMillis;
  return a.tip.id.localeCompare(b.tip.id);
}

/** Rule 4: one page-wide queue — heads-up first, then primary level, page
 *  position, creation time. Rule 6: a still-valid current tip keeps the head
 *  (with its freshly computed placement, so the bubble follows when a more
 *  specific anchor appears — the tip itself is what must not be interrupted). */
function buildQueue(
  placed: { placement: TipPlacement; tip: SchedulableTip; top: number }[],
  current: { tipId: string } | null | undefined,
): TipQueueEntry[] {
  const ordered = placed.slice().sort(compareQueueEntries);
  const pinned = current
    ? ordered.find((entry) => entry.tip.id === current.tipId)
    : undefined;
  return (pinned
    ? [pinned, ...ordered.filter((entry) => entry !== pinned)]
    : ordered
  ).map((entry) => ({
    tipId: entry.tip.id,
    anchorId: entry.placement.anchorId,
    level: entry.placement.level,
    issueIdentifier: entry.placement.issueIdentifier,
    dwellMs: TIP_DWELL_MS[entry.tip.tag],
  }));
}

/** Rule 3: dots mark every candidate of a displayable tip except the anchor
 *  the bubble is (or will be) on — the queue head. */
function computeDots(
  placements: readonly TipPlacement[],
  bubbleAnchorId: string | null,
): string[] {
  const dots = new Set<string>();
  for (const placement of placements) {
    for (const anchorId of placement.candidateAnchorIds) {
      if (anchorId !== bubbleAnchorId) dots.add(anchorId);
    }
  }
  return [...dots];
}

/**
 * Page-level tip scheduling (OL-193, OL-187 §6). Pure: the provider feeds in
 * the registered anchors (measured just before the call) and the viewer's
 * tips, and gets back where each tip's bubble primarily shows, which anchors
 * light a dot, and the single page-wide rotation queue.
 *
 * Rules:
 * 1. A tip's candidates are its issue's visible detail header, its issue's
 *    visible rows, and visible summaries whose scope covers the issue. The
 *    primary position is the most specific candidate; same-level ties go to
 *    the anchor higher on the page.
 * 2. Summary de-dup falls out of rule 1: with a visible row or detail header
 *    for the issue, the tip's primary is never the summary.
 * 3. Dots: every candidate of a displayable tip lights a dot, except the
 *    anchor the bubble currently sits on (the queue head's anchor).
 * 4. One queue per page, one bubble at a time: heads-up first, then by
 *    primary level, page position, and creation time. Dwell is per tag.
 * 5. Summary primaries carry the issue identifier for the bubble prefix.
 * 6. A still-valid current tip keeps the queue head — re-scheduling on anchor
 *    or tip changes never interrupts what is on screen.
 */
export function scheduleTips(input: TipScheduleInput): TipSchedule {
  const { anchors, tips, current } = input;

  const visibleAnchors: Candidate[] = [];
  anchors.forEach((anchor, order) => {
    if (anchor.visible) visibleAnchors.push({ anchor, order });
  });

  const placed = computePlacements(visibleAnchors, tips);
  const queue = buildQueue(placed, current);
  const dotAnchorIds = computeDots(
    placed.map((entry) => entry.placement),
    queue[0]?.anchorId ?? null,
  );

  return {
    placements: placed.map((entry) => entry.placement),
    dotAnchorIds,
    queue,
  };
}

/**
 * Whether the nth bubble display (1-based) carries the "you can turn this off
 * in personal settings" hint: the first three displays and every tenth one
 * after that (OL-187 §6). Count persistence lives with the provider.
 */
export function shouldShowSettingsHint(displayCount: number): boolean {
  return displayCount <= 3 || displayCount % 10 === 0;
}
