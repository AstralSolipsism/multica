"use client";

import { useReducedMotion } from "@multica/core/appearance";

/** Follows both the OS and the Appearance reduce-motion settings. */
export function usePrefersReducedMotion(): boolean {
  return useReducedMotion();
}
