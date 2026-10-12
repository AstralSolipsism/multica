import { scheduleTips } from "./schedule";
import type {
  RegisteredTipAnchor,
  SchedulableTip,
  TipQueueEntry,
  TipScheduleAnchor,
} from "./types";

/**
 * Snapshot the registry's anchors for `scheduleTips`: every visible anchor is
 * measured once, in one pass, so their viewport coordinates are mutually
 * comparable (the registry deliberately caches no positions — see
 * `RegisteredTipAnchor.measure`). Invisible anchors are never candidates, so
 * they are not measured at all. Registration order is preserved; the
 * scheduler uses it as its final tiebreak.
 */
export function measureTipAnchors(
  anchors: Readonly<Record<string, RegisteredTipAnchor>>,
): TipScheduleAnchor[] {
  return Object.values(anchors).map((anchor) => ({
    id: anchor.id,
    descriptor: anchor.descriptor,
    visible: anchor.visible,
    top: anchor.visible ? anchor.measure().top : 0,
  }));
}

/** What the page's single bubble shows, as advanced by `rotateTips`. */
export interface TipRotation {
  /** Tip on screen; null when nothing on the page is displayable. */
  tipId: string | null;
  /**
   * Bumps on every (re)display — including a lone tip starting another dwell
   * — and keys the dwell timer. Re-placing the same tip (its anchor moved, a
   * dot changed) keeps it, so the remaining dwell time carries on.
   */
  seq: number;
  /** Tips already shown in the running cycle; the current tip is not in it. */
  shown: readonly string[];
  /** The current tip's placement and dwell (head of the pinned queue). */
  entry: TipQueueEntry | null;
  /** Page-wide dot targets while the current tip is on screen. */
  dotAnchorIds: readonly string[];
}

export const INITIAL_TIP_ROTATION: TipRotation = {
  tipId: null,
  seq: 0,
  shown: [],
  entry: null,
  dotAnchorIds: [],
};

/**
 * - `sync`: anchors or tips changed. The tip on screen keeps the bubble while
 *   it is still displayable (scheduling rule 6); otherwise the next one takes
 *   over.
 * - `advance`: the current dwell ran out; the next tip takes over.
 */
export interface TipRotationEvent {
  type: "sync" | "advance";
  anchors: readonly TipScheduleAnchor[];
  tips: readonly SchedulableTip[];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameEntry(a: TipQueueEntry | null, b: TipQueueEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.tipId === b.tipId &&
    a.anchorId === b.anchorId &&
    a.level === b.level &&
    a.issueIdentifier === b.issueIdentifier &&
    a.dwellMs === b.dwellMs
  );
}

/**
 * The next tip in rotation: the first one in queue order (heads-up first,
 * see `scheduleTips`) that has not been shown in the running cycle. Once
 * every displayable tip had its turn a new cycle starts from the top —
 * skipping the tip that just left the screen, so with two or more tips the
 * same one never shows twice in a row.
 */
function pickNext(
  order: readonly TipQueueEntry[],
  shown: readonly string[],
  leaving: string | null,
): { tipId: string | null; shown: readonly string[] } {
  const fresh = order.find((entry) => !shown.includes(entry.tipId));
  if (fresh) return { tipId: fresh.tipId, shown };
  const restart = order.find((entry) => entry.tipId !== leaving) ?? order[0];
  return { tipId: restart?.tipId ?? null, shown: [] };
}

/**
 * Rotation reducer for the page bubble (OL-187 §6, OL-194). Pure: the
 * provider measures anchors (`measureTipAnchors`), passes the viewer's
 * displayable tips, and renders whatever comes back.
 *
 * One page-wide queue from `scheduleTips` drives a cycle: each displayable
 * tip shows once per cycle, in queue order, for its tag's dwell. A sync never
 * interrupts the tip on screen while it stays displayable; its placement is
 * re-pinned, so the bubble follows when a more specific anchor appears.
 * Returns `state` itself when nothing observable changed, so a reducer
 * caller does not re-render on every anchor update.
 */
export function rotateTips(state: TipRotation, event: TipRotationEvent): TipRotation {
  const { anchors, tips } = event;
  const order = scheduleTips({ anchors, tips }).queue;
  const live = new Set(order.map((entry) => entry.tipId));
  // Tips that left the page (dismissed, overturned, anchor gone) drop out of
  // the cycle's memory; one that comes back simply counts as unseen.
  let shown: readonly string[] = state.shown.filter((id) => live.has(id));
  const current = state.tipId !== null && live.has(state.tipId) ? state.tipId : null;

  let tipId: string | null;
  if (event.type === "sync" && current !== null) {
    tipId = current;
  } else {
    if (event.type === "advance" && current !== null && !shown.includes(current)) {
      shown = [...shown, current];
    }
    ({ tipId, shown } = pickNext(order, shown, state.tipId));
  }

  const pinned =
    tipId === null ? null : scheduleTips({ anchors, tips, current: { tipId } });
  const next: TipRotation = {
    tipId,
    seq:
      event.type === "advance" || tipId !== state.tipId ? state.seq + 1 : state.seq,
    shown,
    entry: pinned?.queue[0] ?? null,
    dotAnchorIds: pinned?.dotAnchorIds ?? [],
  };

  const unchanged =
    next.tipId === state.tipId &&
    next.seq === state.seq &&
    sameIds(next.shown, state.shown) &&
    sameEntry(next.entry, state.entry) &&
    sameIds(next.dotAnchorIds, state.dotAnchorIds);
  return unchanged ? state : next;
}
