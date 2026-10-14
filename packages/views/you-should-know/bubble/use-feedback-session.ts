"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { IssueTip } from "@multica/core/you-should-know";
import {
  isTipAnchorCandidate,
  type RegisteredTipAnchor,
  type TipAnchorLevel,
  type TipAnchorRect,
} from "@multica/core/you-should-know/anchors";
import { tipLayerHasFocus } from "./tip-layer";

/** A feedback row standing where a dismissed tip's bubble was. */
export interface FeedbackSession {
  /** The dismissed tip. */
  tip: IssueTip;
  /** The anchor its bubble rode; the row stays beside it. */
  anchorId: string;
  /** That anchor's rect thunk, kept so the row can still render while ending. */
  measure: () => TipAnchorRect;
  level: TipAnchorLevel;
  /** Dismissed after "Learn more" — the narrower set of reasons. */
  expanded: boolean;
  /** Focus was in the card: the row takes it over. */
  takeFocus: boolean;
}

/**
 * Whether the anchor under a feedback row still serves it: still registered,
 * on screen by its own IntersectionObserver (an inner scroll container can
 * clip it while floating-ui still finds it inside the window), and still
 * standing for the dismissed tip's issue (a mounted detail header switches
 * issues in place).
 */
export function feedbackAnchorServes(
  anchor: RegisteredTipAnchor | undefined,
  tip: IssueTip,
): boolean {
  return anchor !== undefined && anchor.visible && isTipAnchorCandidate(anchor.descriptor, tip);
}

/**
 * The feedback row's lifecycle (OL-187 §6, OL-196). Every way out goes
 * through `end` — a reason picked, the timeout, the dismissal failing, the
 * anchor no longer serving the row — and `onEnded` hears whether the row held
 * keyboard focus at that moment, so whatever replaces it can take it over.
 * `end` names the tip it means: a late failure of an earlier dismissal must
 * not end a newer row.
 */
export function useFeedbackSession(
  anchors: Readonly<Record<string, RegisteredTipAnchor>>,
  onEnded: (hadFocus: boolean) => void,
) {
  const [session, setSession] = useState<FeedbackSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const end = useCallback((tipId: string) => {
    if (sessionRef.current?.tip.id !== tipId) return;
    sessionRef.current = null;
    onEndedRef.current(tipLayerHasFocus());
    setSession(null);
  }, []);

  // The anchor gave out: end the row in this commit — while it is still
  // mounted, so its focus can be read, and before it paints anywhere stale.
  const serves = session !== null && feedbackAnchorServes(anchors[session.anchorId], session.tip);
  useLayoutEffect(() => {
    if (session && !serves) end(session.tip.id);
  }, [session, serves, end]);

  return { session, start: setSession, end };
}
