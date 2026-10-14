"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  ScrollRestorationProvider,
  type ScrollRestorationAdapter,
} from "@multica/views/platform";

/**
 * Web half of the MUL-4741 scroll-restoration protocol (desktop's half lives
 * in the tab coordinator). The browser only restores the window's own scroll
 * position on back/forward — the app's scrollable containers
 * (`data-tab-scroll-root`) are inner divs and virtualized lists it knows
 * nothing about, so without this, navigating back lands every list at the
 * top.
 *
 * Capture is continuous rather than before-navigation: the App Router has no
 * reliable "about to leave" hook, so a capture-phase scroll listener records
 * each marked container's offset as the user scrolls, keyed by
 * `pathname::containerKey`. Serving is the same pull-based adapter desktop
 * uses — views read the offset at mount through `useRestoredScrollOffset` /
 * `useRestoredScrollRef`.
 *
 * Keying by pathname (not by history entry) matches desktop's memento
 * semantics: returning to a route — via back or via a fresh link — restores
 * where you last were on it. The map is module state: per browser tab (web
 * tabs are real tabs), reset on full reload where the browser's own
 * restoration takes over.
 */
const savedOffsets = new Map<string, { top: number; height: number }>();

/**
 * Generic view-state entries (the desktop memento's second cargo — e.g.
 * "this route's comment-highlight deep link already landed"). Views write
 * through `setViewState` when the state changes and read back at mount.
 * Same lifetime as the offsets: module state, per browser tab, reset on
 * full reload.
 */
const savedViewState = new Map<string, string>();

/**
 * Keys recently served through `adapter.get` are write-suppressed briefly:
 * the restoring container assigns `scrollTop` at attach time, and if its
 * content height isn't final yet the browser clamps the assignment and fires
 * a scroll event — without suppression that clamped value (or a clamp to 0)
 * would overwrite the very memento being restored. A real user scroll within
 * the window is lost, which is the cheap side of the trade.
 */
const suppressedUntil = new Map<string, number>();
const RESTORE_SUPPRESS_MS = 1000;

function mementoKey(pathname: string, containerKey: string): string {
  return `${pathname}::${containerKey}`;
}

/**
 * Delete every view-state entry under `pathname` whose entry key starts with
 * `entryKeyPrefix`. The navigation layer calls this when a fresh in-app push
 * carries a `#comment-…` deep link: the push is new landing intent, so the
 * destination route's "highlight already landed" record must not suppress it.
 * (The record exists to stop a RESTORE — a tab switch back — from re-jumping,
 * not to lock the route out of ever landing again.)
 */
export function clearViewStateEntries(
  pathname: string,
  entryKeyPrefix: string,
): void {
  const prefix = mementoKey(pathname, entryKeyPrefix);
  for (const key of [...savedViewState.keys()]) {
    if (key.startsWith(prefix)) savedViewState.delete(key);
  }
}

export function WebScrollRestorationProvider({
  children,
}: {
  children: ReactNode;
}) {
  // Key entries by React's pathname, not `window.location.pathname`: Next
  // commits the URL in HistoryUpdater's insertion effect, so during the
  // destination route's first render (and its mount-time memento reads) the
  // address bar still shows the PREVIOUS route. A view that mounts mid-commit
  // — e.g. the canonical rewrite remounting the issue detail — must key its
  // reads by the route React is actually rendering, or it inherits whatever
  // the previous route's pathname stored.
  //
  // Two channels, two timing rules (OL-270 review): the ADAPTER closures
  // capture the render-time `pathname` (a discarded transition render builds
  // a discarded adapter, so a never-committed route never leaks into reads);
  // the scroll LISTENER is registered once and reads a ref that only layout
  // effects move — i.e. the last COMMITTED pathname — so a scroll event from
  // the outgoing page during a navigation render is never filed under the
  // incoming route.
  const pathname = usePathname();
  const committedPathnameRef = useRef(pathname);
  useLayoutEffect(() => {
    committedPathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      const raw = el.getAttribute("data-tab-scroll-root");
      if (raw === null) return;
      const key = mementoKey(committedPathnameRef.current, raw || "main");
      const suppressed = suppressedUntil.get(key);
      if (suppressed !== undefined) {
        if (performance.now() < suppressed) return;
        suppressedUntil.delete(key);
      }
      if (el.scrollTop <= 0) {
        // Back at the top is the default state — a stale offset would
        // otherwise resurrect on the next visit.
        savedOffsets.delete(key);
      } else {
        savedOffsets.set(key, { top: el.scrollTop, height: el.scrollHeight });
      }
    };
    // Scroll events don't bubble, but they do propagate on the capture
    // phase, so one window listener observes every container.
    window.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      window.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  const adapter = useMemo<ScrollRestorationAdapter>(
    () => ({
      get(containerKey) {
        const key = mementoKey(pathname, containerKey);
        const saved = savedOffsets.get(key);
        if (saved) {
          // The caller is about to restore this offset — shield the memento
          // from the clamped scroll events the restore itself can produce.
          suppressedUntil.set(key, performance.now() + RESTORE_SUPPRESS_MS);
        }
        return saved;
      },
      getViewState(entryKey) {
        return savedViewState.get(
          mementoKey(pathname, entryKey),
        );
      },
      setViewState(entryKey, value) {
        const key = mementoKey(pathname, entryKey);
        if (value === undefined) savedViewState.delete(key);
        else savedViewState.set(key, value);
      },
    }),
    [pathname],
  );

  return (
    <ScrollRestorationProvider adapter={adapter}>
      {children}
    </ScrollRestorationProvider>
  );
}
