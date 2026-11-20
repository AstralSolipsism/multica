"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { chatKeys } from "@multica/core/chat/queries";
import type { EntityAttachmentsStatus } from "../../rich-content/entity-attachments-context";

interface MessageQueryState {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  isFetchNextPageError?: boolean;
  olderPageActive?: boolean;
}

/** Current-page metadata lifecycle; older-page activity must not overwrite it. */
export function chatMessageAttachmentsStatus(
  query: MessageQueryState,
): EntityAttachmentsStatus {
  if (query.fetchStatus !== "idle" && !query.olderPageActive) return "loading";
  if (query.status === "error" && !query.isFetchNextPageError) return "error";
  return "ready";
}

/**
 * A next-page fetch cancels an in-flight current-page refetch. Queue the older
 * read instead, then run it after the authoritative current page has landed.
 */
export function useDeferredOlderPageFetch({
  sessionId,
  fetchStatus,
  fetchNextPage,
}: {
  sessionId: string | null;
  fetchStatus: MessageQueryState["fetchStatus"];
  fetchNextPage: () => Promise<unknown>;
}): {
  fetchOlderMessages: () => void;
  olderPageActive: boolean;
} {
  const queryClient = useQueryClient();
  const queued = useRef(false);
  const fetchMeta = sessionId
    ? queryClient.getQueryState(chatKeys.messagesPage(sessionId))?.fetchMeta
    : undefined;
  const olderPageActive = (
    fetchMeta as { fetchMore?: { direction?: unknown } } | undefined
  )?.fetchMore?.direction === "forward";
  const currentPageReading = fetchStatus !== "idle" && !olderPageActive;

  useEffect(() => {
    queued.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (currentPageReading || !queued.current) return;
    queued.current = false;
    void fetchNextPage();
  }, [currentPageReading, fetchNextPage]);

  const fetchOlderMessages = useCallback(() => {
    if (olderPageActive && fetchStatus !== "idle") return;
    if (currentPageReading) {
      queued.current = true;
      return;
    }
    void fetchNextPage();
  }, [olderPageActive, currentPageReading, fetchStatus, fetchNextPage]);

  return { fetchOlderMessages, olderPageActive };
}
