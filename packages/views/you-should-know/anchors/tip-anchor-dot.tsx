"use client";

/**
 * The "a tip could show here" dot for anchor stacks (OL-193). Deliberately
 * quiet: static, low contrast, no pulse or shimmer — the avatar stack it
 * rides on already carries the motion budget, and anything livelier reads as
 * nervous on dense lists (see issue-agent-activity-indicator.tsx).
 *
 * Centred on the stack's top-right corner so it never covers a face or the
 * `+N` overflow chip: there the 6px dot clears the last head's circle at both
 * stack sizes — only its 1px background ring touches the edge of a 16px (xs)
 * head, reading as a cut-out. Decorative: the bubble itself carries the
 * meaning.
 */
export function TipAnchorDot() {
  return (
    <span
      aria-hidden="true"
      data-testid="tip-anchor-dot"
      className="pointer-events-none absolute -right-[3px] -top-[3px] size-1.5 rounded-full bg-brand/60 ring-1 ring-background"
    />
  );
}
