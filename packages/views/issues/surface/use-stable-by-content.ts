import { useMemo } from "react";
import { hashKey } from "@tanstack/react-query";

/** Match Query's content equality without mutating refs during render. */
export function useStableByContent<T>(value: T): T {
  const contentKey = hashKey([value]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- identity follows content, not the reference
  return useMemo(() => value, [contentKey]);
}
