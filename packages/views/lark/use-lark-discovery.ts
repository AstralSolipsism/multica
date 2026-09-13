"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  larkMessageAnchorsInfiniteOptions,
  larkTargetCapabilitiesOptions,
  larkTargetChatsInfiniteOptions,
} from "@multica/core/lark";
import type { LarkDiscoveredChat, LarkMessageAnchor } from "@multica/core/types";
import {
  larkDiscoveryErrorKey,
  mergeDiscoveredChats,
  mergeMessageAnchors,
  type LarkDiscoveryErrorKey,
} from "./discovery";

// Headless state for the OL-74 target pickers. All discovery reads are
// keyed by (workspace, installation, query/chat, session): switching the
// workspace, bot or group points the view at a different key, so a response
// that was in flight for the previous selection can only land in a cache
// entry the new view no longer reads — it can never pollute the new state.
// `session` is the explicit "restart from page one" escape hatch for an
// expired/rejected cursor, which invalidates every page of a sequence.

export interface LarkDiscoveryListState<T> {
  items: T[];
  /** First page is loading — nothing to show yet. */
  isLoading: boolean;
  /** A later page is loading (auto-continuing an empty filtered page counts). */
  isFetchingMore: boolean;
  /** More pages exist; "no matches" is only knowable when this is false. */
  hasMore: boolean;
  error: unknown;
  errorKey: LarkDiscoveryErrorKey | null;
  /** Refetch the current sequence (or restart it when the cursor died). */
  retry: () => void;
  /** Explicit restart from page one (new session, fresh cursor chain). */
  restart: () => void;
  fetchMore: () => void;
}

function useRetryRestart(error: unknown, restart: () => void, refetchPage: () => void, hasData: boolean, fetchNextPage: () => void) {
  return useCallback(() => {
    if (larkDiscoveryErrorKey(error) === "invalid_cursor") {
      // Every cursor of this sequence is dead; only a fresh first page helps.
      restart();
      return;
    }
    if (hasData) fetchNextPage();
    else refetchPage();
  }, [error, restart, refetchPage, hasData, fetchNextPage]);
}

export function useLarkTargetCapabilities(
  wsId: string,
  installationId: string,
  options?: { enabled?: boolean },
) {
  return useQuery(larkTargetCapabilitiesOptions(wsId, installationId, options));
}

export function useLarkTargetChats(
  wsId: string,
  installationId: string,
  options?: { enabled?: boolean },
): LarkDiscoveryListState<LarkDiscoveredChat> & {
  search: string;
  setSearch: (value: string) => void;
  /** Debounced, normalized (trimmed, lowercased) query actually sent. */
  query: string;
} {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [session, setSession] = useState(0);

  // Debounce keystrokes into the normalized query the server binds into its
  // cursor scope (trim + case-insensitive substring, ≤100 chars enforced
  // server-side; overlong input surfaces as invalid_request).
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim().toLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const result = useInfiniteQuery(
    larkTargetChatsInfiniteOptions(wsId, installationId, query, session, options),
  );
  const { data, hasNextPage, isFetchingNextPage, isError, fetchNextPage } = result;

  const items = useMemo(() => mergeDiscoveredChats(data?.pages), [data?.pages]);
  const lastPage = data?.pages[data.pages.length - 1];

  // A name filter runs one provider page at a time: empty filtered pages are
  // skipped automatically so "no matches" is only ever shown once pagination
  // really finished (has_more === false), never on an intermediate page.
  useEffect(() => {
    if (!lastPage || lastPage.items.length > 0) return;
    if (isError || !hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [lastPage, isError, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const restart = useCallback(() => setSession((s) => s + 1), []);
  const retry = useRetryRestart(
    result.error,
    restart,
    () => void result.refetch(),
    (data?.pages.length ?? 0) > 0,
    () => void fetchNextPage(),
  );

  return {
    items,
    isLoading: result.isPending,
    isFetchingMore: isFetchingNextPage,
    hasMore: hasNextPage === true,
    error: result.error,
    errorKey: result.isError ? larkDiscoveryErrorKey(result.error) : null,
    retry,
    restart,
    fetchMore: () => void fetchNextPage(),
    search,
    setSearch,
    query,
  };
}

export function useLarkMessageAnchors(
  wsId: string,
  installationId: string,
  chatId: string,
  options?: { enabled?: boolean },
): LarkDiscoveryListState<LarkMessageAnchor> {
  const [session, setSession] = useState(0);
  const result = useInfiniteQuery(
    larkMessageAnchorsInfiniteOptions(wsId, installationId, chatId, session, options),
  );
  const { data, hasNextPage, isFetchingNextPage } = result;

  const items = useMemo(() => mergeMessageAnchors(data?.pages), [data?.pages]);

  const restart = useCallback(() => setSession((s) => s + 1), []);
  const retry = useRetryRestart(
    result.error,
    restart,
    () => void result.refetch(),
    (data?.pages.length ?? 0) > 0,
    () => void result.fetchNextPage(),
  );

  return {
    items,
    isLoading: result.isPending,
    isFetchingMore: isFetchingNextPage,
    hasMore: hasNextPage === true,
    error: result.error,
    errorKey: result.isError ? larkDiscoveryErrorKey(result.error) : null,
    retry,
    restart,
    fetchMore: () => void result.fetchNextPage(),
  };
}
