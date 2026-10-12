"use client";

import { useEffect, useRef } from "react";

/**
 * Pausable countdown for one bubble display (OL-194).
 *
 * `displayKey` identifies the display: a new key starts a fresh `durationMs`
 * countdown. While `paused`, the clock stops; resuming continues with the
 * time that was left rather than starting over. `durationMs: null` means
 * nothing is on screen and no clock runs.
 */
export function useDwellTimer(
  displayKey: number,
  durationMs: number | null,
  paused: boolean,
  onElapsed: () => void,
): void {
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;
  const keyRef = useRef<number | null>(null);
  const remainingRef = useRef(0);

  useEffect(() => {
    if (durationMs === null) {
      keyRef.current = null;
      return;
    }
    if (keyRef.current !== displayKey) {
      keyRef.current = displayKey;
      remainingRef.current = durationMs;
    }
    if (paused) return;

    const startedAt = Date.now();
    const timer = setTimeout(() => {
      remainingRef.current = 0;
      onElapsedRef.current();
    }, remainingRef.current);
    return () => {
      clearTimeout(timer);
      // Bank what is left; the next run either resumes it (same key) or
      // replaces it (new key).
      remainingRef.current = Math.max(
        0,
        remainingRef.current - (Date.now() - startedAt),
      );
    };
  }, [displayKey, durationMs, paused]);
}
