"use client";

import { Suspense, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@multica/views/navigation";
import {
  ISSUE_HIGHLIGHT_MEMENTO_PREFIX,
  parseCommentHighlightHash,
} from "@multica/views/issues/comment-deep-link";
import { canGoBackInApp } from "./in-app-history";
import { clearViewStateEntries } from "./scroll-restoration";

/** Split an in-app path into its pathname and fragment ("" when none). */
function splitInAppPath(path: string): { pathname: string; hash: string } {
  const hashIdx = path.indexOf("#");
  const hash = hashIdx === -1 ? "" : path.slice(hashIdx);
  const beforeHash = hashIdx === -1 ? path : path.slice(0, hashIdx);
  const queryIdx = beforeHash.indexOf("?");
  return {
    pathname: queryIdx === -1 ? beforeHash : beforeHash.slice(0, queryIdx),
    hash,
  };
}

/**
 * Web half of the `multica:navigate` bridge — the event shared content
 * (comments, chat, issue descriptions) fires when a link resolves to an in-app
 * destination. A plain click ("push") is a router push in place. A modifier
 * click normally never reaches here on web — real anchors leave it to the
 * browser — but the editor must intercept every click (contenteditable
 * anchors don't navigate natively), and for those `window.open` is the
 * closest the web can get: JS cannot open a background tab, so both tab
 * dispositions land as a foreground browser tab.
 */
function useInternalLinkHandler(push: (path: string) => void) {
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ path?: string; disposition?: string }>
      ).detail;
      const path = detail?.path;
      if (!path) return;
      if (
        detail?.disposition === "background-tab" ||
        detail?.disposition === "foreground-tab"
      ) {
        window.open(
          window.location.origin + path,
          "_blank",
          "noopener,noreferrer",
        );
        return;
      }
      push(path);
    };
    window.addEventListener("multica:navigate", handler);
    return () => window.removeEventListener("multica:navigate", handler);
  }, [push]);
}

/**
 * The fragment is client-only state Next.js never surfaces: `usePathname()`
 * drops it, and a `router.replace("/x#y")` mutates `window.location` without
 * a render of its own. Reading it through an external store re-reads the URL
 * on every render and re-renders on the events that change it behind React's
 * back, so `adapter.hash` is never a stale copy.
 */
function subscribeToHash(onStoreChange: () => void): () => void {
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

function NavigationProviderInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The target of an in-app navigation committed through this adapter, plus
  // the URL the address bar showed when the navigation started. Next writes
  // history only when the destination commits (HistoryUpdater's
  // useInsertionEffect), so during the destination's FIRST render
  // `window.location` still shows the previous route — and a plain
  // `window.location.hash` read there returns the previous page's fragment.
  // The record applies only while the address bar is EXACTLY the URL it was
  // recorded against: any commit (the navigation itself, a redirect, a
  // popstate, a later push) invalidates it, so a stale record can never
  // report an outdated fragment for a route it outlived (OL-270 R5).
  // This is what lets a pushed `#comment-…` deep link reach the destination
  // page's first render instead of arriving one commit late.
  const pendingNavRef = useRef<{
    from: string;
    pathname: string;
    hash: string;
  } | null>(null);

  const rawHash = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    () => "",
  );
  const pending = pendingNavRef.current;
  const windowUrl =
    window.location.pathname + window.location.search + window.location.hash;
  const hash =
    pending && pending.from === windowUrl && pending.pathname === pathname
      ? pending.hash
      : rawHash;

  useEffect(() => {
    // The URL moved on — committed, redirected, or superseded; either way the
    // record's `from` premise is gone.
    if (pendingNavRef.current && pendingNavRef.current.from !== windowUrl) {
      pendingNavRef.current = null;
    }
  }, [pathname, rawHash, windowUrl]);

  const push = useCallback(
    (path: string) => {
      const target = splitInAppPath(path);
      pendingNavRef.current = {
        from: window.location.pathname + window.location.search + window.location.hash,
        ...target,
      };
      // A push carrying a comment deep link is fresh landing intent: clear the
      // destination route's "highlight already landed" memento, or a previous
      // landing on that same route suppresses this one. Restores (tab switch
      // back, browser back) never pass through here and keep their record.
      if (parseCommentHighlightHash(target.hash)) {
        clearViewStateEntries(target.pathname, ISSUE_HIGHLIGHT_MEMENTO_PREFIX);
      }
      router.push(path);
    },
    [router],
  );
  const replace = useCallback(
    (path: string) => {
      pendingNavRef.current = {
        from: window.location.pathname + window.location.search + window.location.hash,
        ...splitInAppPath(path),
      };
      router.replace(path);
    },
    [router],
  );
  const replaceCanonical = useCallback(
    (path: string) => {
      const target = splitInAppPath(path);
      // The rewrite REMOUNTS the issue detail on web, and the new instance
      // must re-land its deep link: clear the destination route's landed
      // record synchronously so the remount's first render already reads an
      // empty entry. (Desktop instead carries the record over — its detail
      // instance survives the rewrite.) A rewrite without a comment anchor
      // touches nothing.
      if (parseCommentHighlightHash(target.hash)) {
        clearViewStateEntries(target.pathname, ISSUE_HIGHLIGHT_MEMENTO_PREFIX);
      }
      pendingNavRef.current = {
        from: window.location.pathname + window.location.search + window.location.hash,
        ...target,
      };
      router.replace(path);
    },
    [router],
  );
  useInternalLinkHandler(push);

  const adapter: NavigationAdapter = {
    push,
    replace,
    replaceCanonical,
    back: router.back,
    forward: router.forward,
    canGoBack: canGoBackInApp,
    pathname,
    searchParams: new URLSearchParams(searchParams.toString()),
    hash,
    getShareableUrl: (path: string) =>
      typeof window === "undefined" ? path : window.location.origin + path,
    // router.prefetch is a no-op in dev mode by Next.js design; in production
    // it warms the RSC payload + route chunk so the next push() commits with
    // no network round-trip. Safe to call repeatedly — Next dedupes internally.
    prefetch: (path: string) => {
      router.prefetch(path);
    },
  };

  return <NavigationProvider value={adapter}>{children}</NavigationProvider>;
}

export function WebNavigationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense>
      <NavigationProviderInner>{children}</NavigationProviderInner>
    </Suspense>
  );
}
