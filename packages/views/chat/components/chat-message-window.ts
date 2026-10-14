import { useRef } from "react";

// Virtuoso anchors its scroll compensation to item INDICES: prepending rows
// must come with a `firstItemIndex` that drops by the row count, or the rows
// the reader is looking at shift under them. The base value itself is
// arbitrary — large enough that a long history of prepends never crosses zero.
export const CHAT_MESSAGE_WINDOW_BASE_INDEX = 1_000_000;

export interface ChatMessageWindowAnchor {
  /** Row keys of the rendered window at the previous render. */
  keys: readonly string[];
  /** Virtuoso index that keys[0] occupied at the previous render. */
  firstItemIndex: number;
}

/**
 * Advances the window anchor by row IDENTITY, not page arithmetic.
 *
 * The chat list's message window is contiguous and changes only at its ends:
 * an older page prepends rows at the top, a new message appends at the tail,
 * and a full refetch (chat:message / chat:done / task:* all invalidate the
 * paged query) re-normalizes page boundaries — which can drop rows from the
 * top when the loaded pages are full, or move rows between pages without any
 * visible change at all. The old `base - count(olderPages)` computation could
 * not tell those apart: a boundary slide changed the count without changing
 * the top row (or vice versa), and Virtuoso compensated for a prepend that
 * never happened — the reader's row jumped (OL-272). Filtering
 * (`onboarding_kickoff` never renders) also made the count lie, because the
 * list and the counter disagreed about which rows exist.
 *
 * Diffing the actual rendered keys keeps one invariant: a row that exists in
 * both renders keeps its Virtuoso index, so Virtuoso's own compensation keeps
 * the viewport on the same message.
 */
export function advanceChatMessageWindowAnchor(
  prev: ChatMessageWindowAnchor,
  keys: readonly string[],
): ChatMessageWindowAnchor {
  if (keys.length === 0 || prev.keys.length === 0) {
    return { keys, firstItemIndex: CHAT_MESSAGE_WINDOW_BASE_INDEX };
  }
  const first = keys[0]!;
  const prevFirst = prev.keys[0]!;
  if (first === prevFirst) {
    // Same top row: changes (if any) are at the tail, which needs no index move.
    return { keys, firstItemIndex: prev.firstItemIndex };
  }
  // Rows dropped from the top (the loaded window slid down on refetch): the
  // new top row sat `dropped` positions into the old window.
  //
  // NOTE: an INCREASE of firstItemIndex is how Virtuoso learns "rows were
  // removed from the top" and shifts the viewport up by their height — its
  // type docs only describe the decrease-for-prepend direction, but this
  // relies on the increase path (the `shiftWith` compensation, verified
  // against react-virtuoso 4.18.7 with the real library in Chromium; the
  // component tests here mock Virtuoso and would not catch a behavior change
  // on upgrade). If a Virtuoso upgrade ever stops compensating increases, the
  // reader's row jumps on every window slide — re-verify against OL-272's
  // acceptance criterion 4 when bumping the dependency.
  const dropped = prev.keys.indexOf(first);
  if (dropped > 0) {
    return { keys, firstItemIndex: prev.firstItemIndex + dropped };
  }
  // Rows prepended (an older page landed): the old top row now sits deeper.
  const prepended = keys.indexOf(prevFirst);
  if (prepended > 0) {
    return { keys, firstItemIndex: prev.firstItemIndex - prepended };
  }
  // No overlap (wholesale replacement, e.g. a refetch racing a cache clear):
  // keep the index; Virtuoso re-keys every row off `computeItemKey` anyway.
  return { keys, firstItemIndex: prev.firstItemIndex };
}

/**
 * The list's `firstItemIndex`, tracked across renders by row identity. Lives
 * inside the list component (which remounts per session) so a session switch
 * naturally starts a fresh anchor.
 *
 * The anchor advances DURING render, not in an effect: Virtuoso reads
 * `firstItemIndex` off this same render pass, so the data and its index base
 * must move together — an effect would hand Virtuoso new rows with a stale
 * base for one commit, which is exactly the frame that jumps. The advance is
 * a pure function of (previous anchor, current keys), so a double render is
 * idempotent.
 */
export function useChatMessageWindowIndex(keys: readonly string[]): number {
  const ref = useRef<ChatMessageWindowAnchor>({
    keys: [],
    firstItemIndex: CHAT_MESSAGE_WINDOW_BASE_INDEX,
  });
  const anchor = advanceChatMessageWindowAnchor(ref.current, keys);
  ref.current = anchor;
  // An empty list passes 0, matching Virtuoso's own default firstItemIndex.
  return keys.length > 0 ? anchor.firstItemIndex : 0;
}
