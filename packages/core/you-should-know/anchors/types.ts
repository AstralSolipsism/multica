/**
 * Shared types for the You-should-know tip anchor system (OL-193).
 *
 * Anchors are the on-page spots a tip bubble can attach to: wherever an
 * AgentAvatarStack signals "agents are working". This module only defines
 * where tips may show; the bubble itself is a later milestone.
 */

/** Position level. More specific wins: detail_header > row > summary. */
export type TipAnchorLevel = "detail_header" | "row" | "summary";

/**
 * Maps an issue id to its human-readable identifier (e.g. "OL-123") for every
 * issue a summary anchor covers. The identifier prefixes the tip line when a
 * tip rotates inside a summary.
 */
export type TipAnchorScope = Readonly<Record<string, string>>;

/**
 * Caller-supplied description of one anchor. Must be stable (memoized) —
 * consumers key effects off it.
 */
export type TipAnchorDescriptor =
  | { level: "detail_header"; issueId: string }
  | { level: "row"; issueId: string }
  | { level: "summary"; scope: TipAnchorScope };

/** One anchor as held by the registry. */
export interface RegisteredTipAnchor {
  /** Unique per mounted anchor element (React useId of the registering stack). */
  id: string;
  descriptor: TipAnchorDescriptor;
  /** Whether the anchor is inside the viewport (IntersectionObserver). */
  visible: boolean;
  /**
   * Measures the anchor's current viewport-top (px) on demand. NOT a cached
   * value: the app scrolls inner containers rather than the window, so any
   * stored position goes stale on the next scroll. The scheduler's caller
   * measures all visible anchors in one pass right before scheduling — only
   * visible anchors ever compete, and viewport coordinates taken at the same
   * instant are mutually comparable.
   */
  measure: () => number;
}

/** Display state written back into the registry by the page-level provider. */
export interface TipAnchorDisplayState {
  /** Anchor currently hosting the bubble; null when no bubble is shown. */
  bubbleAnchorId: string | null;
  /** Anchors that should render a dot (a tip could show here, but isn't). */
  dotAnchorIds: readonly string[];
}

/**
 * The tip shape the scheduler needs. Structural on purpose: the data layer
 * (OL-192) owns the full IssueTip schema; anything with these fields works.
 */
export interface SchedulableTip {
  id: string;
  issue_id: string;
  tag: "you_should_know" | "heads_up";
  created_at: string;
}

/**
 * Anchor view accepted by the scheduler: a measured snapshot. `top` is the
 * viewport-top measured by the caller just before scheduling (see
 * RegisteredTipAnchor.measure).
 */
export interface TipScheduleAnchor {
  id: string;
  descriptor: TipAnchorDescriptor;
  visible: boolean;
  top: number;
}

/** Where one displayable tip primarily shows, and where its dots go. */
export interface TipPlacement {
  tipId: string;
  /** Primary (most specific) anchor for the tip. */
  anchorId: string;
  level: TipAnchorLevel;
  /** Every visible candidate anchor of the tip, primary included. */
  candidateAnchorIds: readonly string[];
  /** Issue identifier, set only when the primary position is a summary. */
  issueIdentifier: string | null;
}

/** One queue entry: a tip plus where and how long it shows. */
export interface TipQueueEntry {
  tipId: string;
  anchorId: string;
  level: TipAnchorLevel;
  /** Issue identifier, set only when the primary position is a summary. */
  issueIdentifier: string | null;
  /** How long the bubble stays: 8s for you_should_know, 15s for heads_up. */
  dwellMs: number;
}

export interface TipScheduleInput {
  anchors: readonly TipScheduleAnchor[];
  /** Tips visible to the current user (already filtered by the data layer). */
  tips: readonly SchedulableTip[];
  /**
   * The tip whose bubble is currently displayed. When it is still valid it
   * keeps the queue head (rule: re-scheduling never interrupts it).
   */
  current?: { tipId: string } | null;
}

export interface TipSchedule {
  /** One placement per tip that has at least one visible candidate anchor. */
  placements: readonly TipPlacement[];
  /** Page-wide dot targets: candidates of placed tips, minus the queue head's anchor. */
  dotAnchorIds: readonly string[];
  /** Page-wide rotation queue. The head is what the provider shows now. */
  queue: readonly TipQueueEntry[];
}
