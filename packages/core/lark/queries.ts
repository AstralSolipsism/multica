import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type { ListLarkInstallationsResponse } from "../types";

/** Query key namespace for everything Lark-installation-related. Realtime
 * sync invalidates `installations(wsId)` on `lark_installation:*` events
 * so the Settings panel updates without a refetch. */
export const larkKeys = {
  all: (wsId: string) => ["lark", wsId] as const,
  installations: (wsId: string) => [...larkKeys.all(wsId), "installations"] as const,
  targetCapabilities: (wsId: string, installationId: string) =>
    [...larkKeys.all(wsId), "target-capabilities", installationId] as const,
  // `q` (normalized trim) and `session` are part of the key: a new search or
  // an explicit restart after a cursor failure must never share a cache entry
  // with the sequence it replaces, and an in-flight response for the old
  // workspace/bot/query lands in a key the new view no longer reads.
  targetChats: (wsId: string, installationId: string, q: string, session: number) =>
    [...larkKeys.all(wsId), "target-chats", installationId, q, session] as const,
  messageAnchors: (wsId: string, installationId: string, chatId: string, session: number) =>
    [...larkKeys.all(wsId), "message-anchors", installationId, chatId, session] as const,
  privateChatCandidates: (wsId: string, installationId: string) =>
    [...larkKeys.all(wsId), "private-chat-candidates", installationId] as const,
};

export const larkInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: larkKeys.installations(wsId),
    queryFn: () => api.listLarkInstallations(wsId),
    enabled: !!wsId,
  });

export function useSetLarkConversation(wsId: string, installationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chats: { chat_id: string; chat_type: "group" | "p2p" }[]) => api.setLarkConversation(wsId, installationId, chats),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: larkKeys.installations(wsId) });
      // The saved grant re-derives candidate authorization states (a removed
      // chat can expose its still-valid observation as pending again), so the
      // candidate list must be re-read after a full-list save.
      void qc.invalidateQueries({ queryKey: larkKeys.privateChatCandidates(wsId, installationId) });
    },
  });
}

/** Confirm observed private chats into the saved grant (OL-75 contract). The
 * server atomically unions the candidates' p2p targets with every saved
 * target and returns the resulting grant — the response is the authoritative
 * saved state, so the installations cache is patched from it directly instead
 * of waiting on a refetch that a stale full-list draft could then overwrite. */
export function useConfirmLarkPrivateChats(wsId: string, installationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (candidateIds: string[]) => api.confirmLarkPrivateChatCandidates(wsId, installationId, candidateIds),
    onSuccess: (grant) => {
      qc.setQueryData<ListLarkInstallationsResponse | undefined>(
        larkKeys.installations(wsId),
        (old) => old == null ? old : {
          ...old,
          installations: old.installations.map((inst) =>
            inst.id === installationId ? { ...inst, conversation: grant } : inst),
        },
      );
      // Re-derive pending/authorized badges from the new grant.
      void qc.invalidateQueries({ queryKey: larkKeys.privateChatCandidates(wsId, installationId) });
    },
  });
}

/** Discovery page sizes stay well under the server caps (100 / 50) so a
 * mid-flight cap change can never reject a request this client issued. */
export const LARK_TARGET_CHATS_PAGE_SIZE = 20;
export const LARK_MESSAGE_ANCHORS_PAGE_SIZE = 20;

/** Discovery errors are mostly stable answers for this caller (403/404/409)
 * — retrying them just delays the picker's honest state. Only genuine
 * transient failures (network, provider rate limit, 5xx) earn a retry. */
function isTransientDiscoveryError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status === 429 || err.status >= 500;
}

const discoveryRetry = (count: number, err: unknown) => count < 2 && isTransientDiscoveryError(err);

/**
 * What the configured transport supports, per installation. `retry: false`:
 * 403 (not the agent owner/admin), 404 (installation gone OR a pre-discovery
 * server) and 409 (revoked/archived) are stable answers the picker renders
 * as explicit states, not transient blips.
 */
export function larkTargetCapabilitiesOptions(
  wsId: string,
  installationId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: larkKeys.targetCapabilities(wsId, installationId),
    queryFn: () => api.getLarkTargetCapabilities(wsId, installationId),
    enabled: (options?.enabled ?? true) && !!wsId && !!installationId,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Joined-group pages for one (installation, normalized query, session)
 * sequence. Page position lives in the infinite query's pageParam (the
 * opaque server cursor). Consumers must keep paging while
 * `has_more === true` — including past empty filtered pages — before
 * concluding "no matches".
 */
export function larkTargetChatsInfiniteOptions(
  wsId: string,
  installationId: string,
  q: string,
  session: number,
  options?: { enabled?: boolean },
) {
  return infiniteQueryOptions({
    queryKey: larkKeys.targetChats(wsId, installationId, q, session),
    queryFn: ({ pageParam }) =>
      api.listLarkTargetChats(wsId, installationId, {
        pageSize: LARK_TARGET_CHATS_PAGE_SIZE,
        q: q === "" ? undefined : q,
        cursor: pageParam === "" ? undefined : pageParam,
      }),
    initialPageParam: "",
    getNextPageParam: (last) =>
      last.has_more === true && last.next_cursor !== "" ? last.next_cursor : undefined,
    enabled: (options?.enabled ?? true) && !!wsId && !!installationId,
    retry: discoveryRetry,
  });
}

/**
 * Newest-first message anchors for one already-selected group. Only fetched
 * once a group exists (callers pass `enabled`); every page re-checks group
 * reachability server-side, so a stale page never upgrades into a target.
 */
export function larkMessageAnchorsInfiniteOptions(
  wsId: string,
  installationId: string,
  chatId: string,
  session: number,
  options?: { enabled?: boolean },
) {
  return infiniteQueryOptions({
    queryKey: larkKeys.messageAnchors(wsId, installationId, chatId, session),
    queryFn: ({ pageParam }) =>
      api.listLarkMessageAnchors(wsId, installationId, chatId, {
        pageSize: LARK_MESSAGE_ANCHORS_PAGE_SIZE,
        cursor: pageParam === "" ? undefined : pageParam,
      }),
    initialPageParam: "",
    getNextPageParam: (last) =>
      last.has_more === true && last.next_cursor !== "" ? last.next_cursor : undefined,
    enabled: (options?.enabled ?? true) && !!wsId && !!installationId && !!chatId,
    retry: discoveryRetry,
  });
}

/**
 * Observed private chats awaiting human confirmation (OL-75). Single-shot:
 * the contract has no paging or search (at most 50 unexpired candidates per
 * installation), so the manual refresh entry is a plain refetch. The response
 * is `Cache-Control: no-store` and the picker renders stable errors (403 /
 * 404 / 409 / 503) as explicit states, hence the shared discovery retry.
 */
export function larkPrivateChatCandidatesOptions(
  wsId: string,
  installationId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: larkKeys.privateChatCandidates(wsId, installationId),
    queryFn: () => api.listLarkPrivateChatCandidates(wsId, installationId),
    enabled: (options?.enabled ?? true) && !!wsId && !!installationId,
    retry: discoveryRetry,
  });
}
