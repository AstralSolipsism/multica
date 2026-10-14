"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TipRotation } from "@multica/core/you-should-know/anchors";

/**
 * Keyboard focus hand-off between tip layers (OL-196). The host arms it when
 * an action takes away the layer that holds focus — "I already know", a
 * feedback pick, the feedback row ending for any reason — and some tip is
 * going to take that layer's place. The next bubble the host renders is that
 * replacement: it reads `pending` on its first render and takes focus once
 * on screen, if focus is still free.
 *
 * The replacement may render in the same commit (it was already waiting
 * behind the feedback row) or one re-schedule later (the departing tip was
 * still the rotation's current one). The hand-off is spent on that bubble,
 * and lapses if the rotation moves on without rendering one — so no tip that
 * rotates in later ever takes focus.
 *
 * `bubbleKey` is the tip whose bubble the host renders in this commit.
 */
export function useFocusHandoff(rotation: TipRotation, bubbleKey: string | null) {
  const [armedAt, setArmedAt] = useState<TipRotation | null>(null);
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
  const arm = useCallback(() => setArmedAt(rotationRef.current), []);
  useEffect(() => {
    if (armedAt && (bubbleKey !== null || armedAt !== rotation)) setArmedAt(null);
  }, [armedAt, bubbleKey, rotation]);
  return { pending: armedAt !== null, arm };
}
