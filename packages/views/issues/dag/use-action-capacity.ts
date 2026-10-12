import { useLayoutEffect, useRef, useState } from "react";

/** Extra room required before a collapsed action returns to the bar, so a
 *  boundary width cannot oscillate. */
const RESTORE_HYSTERESIS_PX = 48;
/** The label truncates first; actions start collapsing only once the label
 *  is down to this reservation. */
const LABEL_RESERVE_PX = 96;
const ITEM_GAP_PX = 4;

/**
 * How many of the zone's actions fit, as a prefix length. The zone renders
 * every action after each reset so their intrinsic widths can be measured
 * into a ref; each fit then checks the prefix sum against the zone's
 * clientWidth minus the fixed siblings (More trigger, clear button, focus
 * hint) and the label reservation. A flex `scrollWidth` approach does not
 * work here: an overflow-hidden flex container reports
 * `scrollWidth == clientWidth`, so collapsed actions would never come back.
 *
 * Zero-width environments (jsdom) report full capacity: nothing collapses.
 */
export function useActionCapacity(actionKeys: readonly string[], resetKey: string | null) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const widthsRef = useRef(new Map<string, number>());
  const fitRef = useRef<() => void>(() => undefined);
  const [visibleCount, setVisibleCount] = useState(actionKeys.length);
  useLayoutEffect(() => {
    setVisibleCount(actionKeys.length);
  }, [resetKey, actionKeys.length]);
  useLayoutEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    fitRef.current = () => {
      if (!zone.clientWidth) return;
      // Measure the mounted actions and fixed siblings, then fit a prefix.
      // Runs after every render because content changes (the hidden-chain
      // hint, a new label) do not resize the zone and would not trip the
      // observer.
      for (const el of zone.querySelectorAll<HTMLElement>("[data-dag-action]")) {
        const key = el.dataset.dagAction!;
        if (el.offsetWidth) widthsRef.current.set(key, el.offsetWidth);
      }
      const fixedWidth = [...zone.querySelectorAll<HTMLElement>("[data-dag-fixed]")].reduce(
        (sum, el) => sum + el.offsetWidth,
        0,
      );
      // The reservation must use the label's full content width: offsetWidth
      // is the ALREADY-squeezed render width, which shrinks together with the
      // reservation and would let the label vanish before anything collapses.
      const labelEl = zone.querySelector<HTMLElement>("[data-dag-label]");
      const labelWidth = Math.min(labelEl?.scrollWidth ?? 0, LABEL_RESERVE_PX);
      const gap =
        parseFloat(getComputedStyle(zone).columnGap) || ITEM_GAP_PX;
      setVisibleCount((current) => {
        // Gaps apply to every zone child — label, actions and fixed parts.
        const gaps = gap * (zone.childElementCount - 1);
        let used = fixedWidth + labelWidth + gaps;
        let fits = 0;
        for (const key of actionKeys) {
          const width = widthsRef.current.get(key) ?? 0;
          if (used + width > zone.clientWidth) break;
          used += width;
          fits += 1;
        }
        if (fits < current) return fits;
        if (fits > current && zone.clientWidth - used >= RESTORE_HYSTERESIS_PX) return fits;
        return current;
      });
    };
    fitRef.current();
  });
  useLayoutEffect(() => {
    const zone = zoneRef.current;
    if (!zone || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(zone);
    return () => observer.disconnect();
  }, []);
  return { zoneRef, visibleCount };
}
