"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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

export interface UseTipAnchorResult {
  /**
   * Attach to the anchor's wrapper element. Undefined unless there is both a
   * registry and a descriptor — attaching a state-setting ref unconditionally
   * would cost every avatar stack in the app an extra render per mount.
   */
  ref: ((element: HTMLElement | null) => void) | undefined;
  /** Whether this anchor should render the low-contrast tip dot. */
  showDot: boolean;
}

/**
 * Registers one AgentAvatarStack as a tip anchor (OL-193). Opt-in: pass a
 * descriptor to register, omit it to stay out of the registry entirely.
 *
 * - Without a provider in context the hook is a no-op (the feature ships
 *   dark until the page-level provider lands).
 * - Registration lifecycle is keyed on registry + element + whether a
 *   descriptor exists; descriptor CONTENT changes update the registration
 *   in place, so a growing summary scope never drops visibility, the bubble,
 *   or dots (scheduling rule 6: re-scheduling must not interrupt).
 * - Visibility comes from an IntersectionObserver; where the platform lacks
 *   one (jsdom, old webviews) the anchor reports visible so tips degrade to
 *   "always candidate" instead of vanishing. Unmounting (e.g. a virtualized
 *   row scrolling off) unregisters on both paths.
 * - Page position is NOT cached: lists here scroll inside inner containers,
 *   so any stored coordinate goes stale on the next scroll. The registry
 *   keeps a `measure()` thunk and the scheduler's caller measures visible
 *   anchors in one pass right before scheduling.
 */
export function useTipAnchor(
  descriptor: TipAnchorDescriptor | undefined,
): UseTipAnchorResult {
  const registry = useTipAnchorRegistry();
  const id = useId();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const attachRef = useCallback((el: HTMLElement | null) => {
    elementRef.current = el;
    setElement(el);
  }, []);
  // Stable measure thunk: reads whatever element is currently attached.
  const measure = useCallback(
    () => elementRef.current?.getBoundingClientRect().top ?? 0,
    [],
  );

  // Keyed on content, not identity — a caller that re-creates the object
  // every render must not churn the registry. Only computed while registering:
  // serializing a large summary scope on every idle render is wasted work.
  const registering = registry !== null && descriptor !== undefined;
  const descriptorKey = useMemo(
    () => (registering && descriptor ? tipAnchorDescriptorKey(descriptor) : null),
    [registering, descriptor],
  );
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;

  // Lifecycle: register, observe, unregister on unmount. Deliberately NOT
  // keyed on descriptorKey — content changes are effect B's job.
  useEffect(() => {
    if (!registry || !element || !descriptorRef.current) return;
    const state = registry.getState;
    state().register({ id, descriptor: descriptorRef.current, measure });

    if (typeof IntersectionObserver !== "function") {
      state().setAnchorVisible(id, true);
      return () => state().unregister(id);
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      state().setAnchorVisible(id, entry.isIntersecting);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      state().unregister(id);
    };
  }, [registry, element, id, registering, measure]);

  // Content updates: re-register in place (keeps visibility and display
  // state). Runs after the lifecycle effect on mount; the registry's own
  // idempotence makes that a no-op.
  useEffect(() => {
    const current = descriptorRef.current;
    if (!registry || !current) return;
    if (!registry.getState().anchors[id]) return;
    registry.getState().register({ id, descriptor: current, measure });
  }, [registry, descriptorKey, id, measure]);

  const showDot = useStore(
    registry ?? NO_REGISTRY,
    (s) => descriptorKey !== null && s.display.dotAnchorIds.includes(id),
  );

  return { ref: registering ? attachRef : undefined, showDot };
}
