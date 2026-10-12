"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isEditableShortcutTarget } from "@multica/core/shortcuts";
import type { TipAnchorRect } from "@multica/core/you-should-know/anchors";

// Page-wide conditions the tip bubble reacts to (OL-194): every one of them
// pauses the rotation, and the overlay ones also hide the bubble.

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** The page is in a background tab or a minimized window. */
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "hidden",
    () => false,
  );
}

function subscribeFocus(onChange: () => void) {
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  return () => {
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", onChange);
  };
}

/**
 * The user is typing: focus sits in an input, textarea, select or
 * contenteditable editor — the same test the shortcut layer uses to keep
 * its hands off keystrokes.
 */
export function useEditableFocus(): boolean {
  return useSyncExternalStore(
    subscribeFocus,
    () => isEditableShortcutTarget(document.activeElement),
    () => false,
  );
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The OS asks for reduced motion: the bubble then gets no transition at all. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

/** Base UI marks everything outside a modal layer (dialog, modal menu). */
const MODAL_MARKER = "data-base-ui-inert";
/** Base UI marks a trigger while its popup (hover card, popover, menu) is open. */
const POPUP_OPEN_MARKER = "data-popup-open";

// Slack for sub-pixel rounding between a trigger and the stack inside it.
const EDGE_TOLERANCE_PX = 1;

function containsRect(outer: DOMRect, inner: TipAnchorRect): boolean {
  return (
    outer.left <= inner.left + EDGE_TOLERANCE_PX &&
    outer.top <= inner.top + EDGE_TOLERANCE_PX &&
    outer.right >= inner.left + inner.width - EDGE_TOLERANCE_PX &&
    outer.bottom >= inner.top + inner.height - EDGE_TOLERANCE_PX
  );
}

/**
 * Whether the anchor's own popup is open. Every anchor stack sits inside the
 * trigger of its host's hover card or popover (row activity card, header
 * chip popover, summary chip card), and Base UI marks that trigger with
 * `data-popup-open` while the popup shows. The registry keeps no elements
 * (core is DOM-free), so "its own" is decided by geometry: an open trigger
 * whose box contains the anchor's box.
 */
function isAnchorPopupOpen(measure: () => TipAnchorRect): boolean {
  const triggers = document.querySelectorAll(`[${POPUP_OPEN_MARKER}]`);
  // The common case — no popup open anywhere — costs no layout read.
  if (triggers.length === 0) return false;
  const anchor = measure();
  if (anchor.width <= 0 || anchor.height <= 0) return false;
  for (const trigger of triggers) {
    if (containsRect(trigger.getBoundingClientRect(), anchor)) return true;
  }
  return false;
}

export interface OverlayState {
  /** A modal layer is open; the bubble hides until it closes. */
  modalOpen: boolean;
  /** The bubble's anchor has its own hover card / popover open; the bubble yields. */
  anchorPopupOpen: boolean;
}

const NO_OVERLAY: OverlayState = { modalOpen: false, anchorPopupOpen: false };

/**
 * Watches for the overlays the bubble must get out of the way of, while a
 * bubble is on screen (`measure` non-null). Both signals are attribute
 * markers Base UI maintains, so one MutationObserver over the body covers
 * them: attribute flips for triggers and inerted siblings, child insertions
 * for modal backdrops (they are born with the inert marker).
 */
export function useOverlayState(measure: (() => TipAnchorRect) | null): OverlayState {
  const [state, setState] = useState<OverlayState>(NO_OVERLAY);

  useEffect(() => {
    if (!measure) {
      setState(NO_OVERLAY);
      return;
    }
    const check = () => {
      const modalOpen = document.querySelector(`[${MODAL_MARKER}]`) !== null;
      const anchorPopupOpen = isAnchorPopupOpen(measure);
      setState((prev) =>
        prev.modalOpen === modalOpen && prev.anchorPopupOpen === anchorPopupOpen
          ? prev
          : { modalOpen, anchorPopupOpen },
      );
    };
    check();
    // Records are delivered once per microtask checkpoint, so a burst of DOM
    // changes costs a single check.
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [MODAL_MARKER, POPUP_OPEN_MARKER],
    });
    return () => observer.disconnect();
  }, [measure]);

  return state;
}
