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
  /**
   * The highlight is the one this detail ARRIVED with (captured on the first
   * ready frame) — it owns the flat deep-link landing. Anything else changed
   * on an already-mounted detail and gets the virtualized minimap jump.
   */
  isArrival: boolean;
  /** The target (or its thread root for a reply) is in the issue's items. */
  targetInItems: boolean;
  scrollContainerReady: boolean;
  virtuosoMounted: boolean;
  /** The timeline currently renders flat (arrival landing or in-page find). */
  flat: boolean;
  /**
   * Arrival only: this folded resolved thread must be expanded before the
   * landing can find its anchor (the effect re-evaluates after the expand).
   */
  resolvedBarrierRootId: string | null;
}

export type CommentLandingDecision =
  | { kind: "wait" }
  | { kind: "skip" }
  /** Consumed by the memento: skip, and mark the guard so later runs skip cheaply. */
  | { kind: "skip-consumed" }
  /** Same-page jump: land through Virtuoso without flattening the timeline. */
  | { kind: "jump" }
  /** Expand this folded resolved thread first; the landing re-runs after. */
  | { kind: "expand-resolved"; rootId: string }
  /** Arrival landing on the flat timeline. */
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

  if (!input.isArrival) {
    // A same-page jump. Consume nothing until the jump can actually run:
    // scrollToIndex on an unmounted Virtuoso (or a target that isn't in this
    // issue's items — e.g. a fragment left over from the previous page) is a
    // silent no-op that would swallow the jump with the guards consumed.
    if (!input.targetInItems || !input.scrollContainerReady) {
      return { kind: "wait" };
    }
    if (!input.flat && !input.virtuosoMounted) return { kind: "wait" };
    return { kind: "jump" };
  }

  if (input.resolvedBarrierRootId) {
    return { kind: "expand-resolved", rootId: input.resolvedBarrierRootId };
  }
  return { kind: "land" };
}
