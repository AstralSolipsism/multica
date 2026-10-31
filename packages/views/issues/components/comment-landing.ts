/**
 * Pure decision core of the issue-detail comment deep-link landing
 * (OL-270). The effect in `issue-detail.tsx` gathers these plain values,
 * asks this function what to do, then executes — refs, memento writes and
 * scroll driving stay in the effect, so every timing race (web's
 * one-commit-late hash, hydration, desktop instance reuse, folded resolved
 * threads) is testable from a table without rendering the page.
 */

export interface CommentLandingInput {
  /** The `#comment-…` target, if the URL carries one. */
  highlightCommentId?: string;
  /** Timeline items are loaded (length > 0). */
  hasItems: boolean;
  /** The landing guard's current occupant (didHighlightRef). */
  alreadyLandedFor: string | null;
  /** The memento's consumed id — set when a restore already landed this link. */
  consumedId?: string;
  /** The highlight was captured on this detail's first ready frame. */
  isArrival: boolean;
  /** The target (or its thread root for a reply) is in the issue's items. */
  targetInItems: boolean;
  scrollContainerReady: boolean;
  virtuosoMounted: boolean;
  /** The timeline currently renders flat for in-page find. */
  flat: boolean;
  /** This manually collapsed thread hides the target. */
  collapsedBarrierRootId: string | null;
  /** This folded resolved thread hides the target. */
  resolvedBarrierRootId: string | null;
}

export type CommentLandingDecision =
  | { kind: "wait" }
  | { kind: "skip" }
  /** Consumed by the memento: skip, and mark the guard so later runs skip cheaply. */
  | { kind: "skip-consumed" }
  /** Same-page jump: land through the existing minimap path. */
  | { kind: "jump" }
  /** Expand this manually collapsed thread first; the landing re-runs after. */
  | { kind: "expand-collapsed"; rootId: string }
  /** Expand this folded resolved thread first; the landing re-runs after. */
  | { kind: "expand-resolved"; rootId: string }
  /** Mount the target's virtual row, then center its exact comment anchor. */
  | { kind: "land" };

export function decideCommentLanding(
  input: CommentLandingInput,
): CommentLandingDecision {
  const id = input.highlightCommentId;
  // No target, or the timeline hasn't produced items yet: wait for the next
  // change rather than consuming anything.
  if (!id || !input.hasItems) return { kind: "wait" };
  if (input.alreadyLandedFor === id) return { kind: "skip" };
  if (input.consumedId === id) return { kind: "skip-consumed" };

  // Consume nothing until the target can actually be mounted. In particular,
  // scrollToIndex on an unmounted Virtuoso is a silent no-op that would
  // swallow the landing with the guards consumed.
  if (!input.targetInItems || !input.scrollContainerReady) {
    return { kind: "wait" };
  }
  if (!input.flat && !input.virtuosoMounted) return { kind: "wait" };

  if (!input.isArrival) return { kind: "jump" };
  if (input.collapsedBarrierRootId) {
    return { kind: "expand-collapsed", rootId: input.collapsedBarrierRootId };
  }
  if (input.resolvedBarrierRootId) {
    return { kind: "expand-resolved", rootId: input.resolvedBarrierRootId };
  }
  return { kind: "land" };
}
