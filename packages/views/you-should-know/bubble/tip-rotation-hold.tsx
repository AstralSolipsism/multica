"use client";

import { createContext, use, useEffect } from "react";

/** Places a hold on the bubble rotation and returns its release. */
export type HoldTipRotation = () => () => void;

export const TipRotationHoldContext = createContext<HoldTipRotation | null>(null);

/**
 * Pauses the page's tip rotation while `active` — for UI that grows out of
 * the bubble and must not have it move on underneath the reader (OL-196: the
 * expanded card, and the feedback row shown after "Dismiss"). Holds stack;
 * the rotation resumes, with the time it had left, once every hold is
 * released. A no-op outside the You-should-know provider.
 */
export function useHoldTipRotation(active: boolean): void {
  const hold = use(TipRotationHoldContext);
  useEffect(() => {
    if (!active || !hold) return;
    return hold();
  }, [active, hold]);
}
