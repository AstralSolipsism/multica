import { useMemo } from "react";
import { hashKey } from "@tanstack/react-query";

/** Match Query's content equality without mutating refs during render.
 * Callers may reuse a memoized hash instead of serializing the value again. */
export function useStableByContent<T>(value: T, contentKey = hashKey([value])): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- identity follows content, not the reference
  return useMemo(() => value, [contentKey]);
}
