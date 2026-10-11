"use client";

/**
 * The "a tip could show here" dot for anchor stacks (OL-193). Deliberately
 * quiet: static, low contrast, no pulse or shimmer — the avatar stack it
 * rides on already carries the motion budget, and anything livelier reads as
 * nervous on dense lists (see issue-agent-activity-indicator.tsx).
 *
 * Positioned off the stack's top-right corner so it never covers a face or
 * the `+N` overflow chip. Decorative: the bubble itself carries the meaning.
 */
export function TipAnchorDot() {
  return (
    <span
      aria-hidden="true"
      data-testid="tip-anchor-dot"
      className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-brand/60 ring-1 ring-background"
    />
  );
}
