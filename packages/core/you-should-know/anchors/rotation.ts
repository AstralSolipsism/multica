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

const ENTRY_FIELDS = ["tipId", "anchorId", "level", "issueIdentifier", "dwellMs"] as const;

function sameEntry(a: TipQueueEntry | null, b: TipQueueEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return ENTRY_FIELDS.every((field) => a[field] === b[field]);
}

function sameRotation(a: TipRotation, b: TipRotation): boolean {
  return (
    a.tipId === b.tipId &&
    a.seq === b.seq &&
    sameIds(a.shown, b.shown) &&
    sameEntry(a.entry, b.entry) &&
    sameIds(a.dotAnchorIds, b.dotAnchorIds)
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
 * Which tip the bubble shows after `type`, given the fresh queue `order`.
 * A sync keeps a still-displayable current tip; an advance marks it shown
 * and moves on. A current tip that is no longer displayable is replaced on
 * either event.
 */
function chooseTip(
  state: TipRotation,
  type: TipRotationEvent["type"],
  order: readonly TipQueueEntry[],
): { tipId: string | null; shown: readonly string[] } {
  const live = new Set(order.map((entry) => entry.tipId));
  // Tips that left the page (dismissed, overturned, anchor gone) drop out of
  // the cycle's memory; one that comes back simply counts as unseen.
  const shown = state.shown.filter((id) => live.has(id));
  const current = state.tipId !== null && live.has(state.tipId) ? state.tipId : null;
  if (current === null) return pickNext(order, shown, state.tipId);
  if (type === "sync") return { tipId: current, shown };
  return pickNext(order, shown.includes(current) ? shown : [...shown, current], current);
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
  const { tipId, shown } = chooseTip(state, event.type, scheduleTips({ anchors, tips }).queue);
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
  return sameRotation(state, next) ? state : next;
}
