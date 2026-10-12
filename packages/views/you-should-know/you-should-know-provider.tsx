"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useIsMobile } from "@multica/ui/hooks/use-mobile";
import { useYouShouldKnowEnabled } from "@multica/core/you-should-know";
import { createTipAnchorRegistry } from "@multica/core/you-should-know/anchors";
import { TipAnchorRegistryProvider } from "./anchors/tip-anchor-context";
import { TipBubbleHost } from "./bubble/tip-bubble-host";
import { TipRotationHoldContext } from "./bubble/tip-rotation-hold";

/**
 * Page-level You-should-know provider (OL-194): owns the page's tip anchor
 * registry and mounts the bubble runtime next to the page. "One bubble per
 * page" is one per provider — web mounts it in the dashboard layout, desktop
 * in each tab's workspace layout (one tab is mounted per window) and in the
 * standalone issue window.
 *
 * Renders nothing extra and requests nothing while the feature is off for
 * this viewer — workspace switch off, personal switch muted (or not loaded
 * yet) — or on a narrow, mobile-width window. Children always render in the
 * same tree position, so toggling never remounts the page; the registry is
 * simply withheld, which keeps every anchor out of it.
 */
export function YouShouldKnowProvider({ children }: { children: ReactNode }) {
  const { enabled } = useYouShouldKnowEnabled();
  const isMobile = useIsMobile();
  // useIsMobile() reads false until its effect has measured the window. Wait
  // out that first commit so a narrow window never mounts the runtime — and
  // fires the tips request — on a pre-measurement render.
  const [measured, setMeasured] = useState(false);
  useEffect(() => setMeasured(true), []);
  const [registry] = useState(createTipAnchorRegistry);
  const active = enabled && measured && !isMobile;

  // Rotation holds (useHoldTipRotation) are counted here, above the page, so
  // whatever grows out of the bubble can keep it still.
  const [holds, setHolds] = useState(0);
  const hold = useCallback(() => {
    setHolds((count) => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setHolds((count) => count - 1);
    };
  }, []);

  return (
    <TipRotationHoldContext.Provider value={active ? hold : null}>
      <TipAnchorRegistryProvider registry={active ? registry : null}>
        {children}
        {active && <TipBubbleHost registry={registry} held={holds > 0} />}
      </TipAnchorRegistryProvider>
    </TipRotationHoldContext.Provider>
  );
}
