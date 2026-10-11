"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  createTipAnchorRegistry,
  tipAnchorDescriptorKey,
  type TipAnchorDescriptor,
} from "@multica/core/you-should-know/anchors";
import { useTipAnchorRegistry } from "./tip-anchor-context";

// Subscribed stand-in when no provider is mounted: never written to, so the
// dot selector it serves always reads false. Lets the hook keep a constant
// shape instead of conditionally calling useStore.
const NO_REGISTRY = createTipAnchorRegistry();

function measureTop(element: HTMLElement): number {
  return element.getBoundingClientRect().top + window.scrollY;
}

export interface UseTipAnchorResult {
  /** Attach to the anchor's wrapper element. */
  ref: (element: HTMLElement | null) => void;
  /** Whether this anchor should render the low-contrast tip dot. */
  showDot: boolean;
}

/**
 * Registers one AgentAvatarStack as a tip anchor (OL-193). Opt-in: pass a
 * descriptor to register, omit it to stay out of the registry entirely.
 *
 * - Without a provider in context the hook is a no-op (the feature ships
 *   dark until the page-level provider lands).
 * - Registration follows the element: no element (empty stack), no anchor;
 *   unmounting (e.g. a virtualized row scrolling off) unregisters.
 * - Visibility and page position come from an IntersectionObserver; where
 *   the platform lacks one (jsdom, old webviews) the anchor reports visible
 *   so tips degrade to "always candidate" instead of vanishing.
 */
export function useTipAnchor(
  descriptor: TipAnchorDescriptor | undefined,
): UseTipAnchorResult {
  const registry = useTipAnchorRegistry();
  const id = useId();
  const [element, setElement] = useState<HTMLElement | null>(null);

  // The effect keys off the descriptor's content, not its identity — a caller
  // that re-creates the object every render must not churn the registry.
  const descriptorKey = descriptor ? tipAnchorDescriptorKey(descriptor) : null;
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;

  useEffect(() => {
    const current = descriptorRef.current;
    if (!registry || !element || !current) return;
    const state = registry.getState;
    state().register({ id, descriptor: current, top: measureTop(element) });

    if (typeof IntersectionObserver !== "function") {
      state().setAnchorGeometry(id, {
        visible: true,
        top: measureTop(element),
      });
      return () => state().unregister(id);
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      state().setAnchorGeometry(id, {
        visible: entry.isIntersecting,
        top: entry.boundingClientRect.top + window.scrollY,
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      state().unregister(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- descriptor identity is keyed on its serialized content; id is stable per mount.
  }, [registry, element, descriptorKey, id]);

  const showDot = useStore(
    registry ?? NO_REGISTRY,
    (s) => descriptorKey !== null && s.display.dotAnchorIds.includes(id),
  );

  return { ref: setElement, showDot };
}
