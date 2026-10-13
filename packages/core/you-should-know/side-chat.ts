"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { chatKeys, chatSessionOptions } from "../chat/queries";
import type { ChatPendingTask, ChatSession } from "../types/chat";

// Labrastro fork: YSK side chats (OL-288 §3/§5, OL-362). A member opens a
// private chat with the agent that produced a tip; the server (OL-360) keeps
// that chat out of the session list until its first message.

/**
 * Why a tip's side chat cannot be opened, as the open endpoint names it.
 * Clients that predict a refusal check in the server's order: access first,
 * then archive, then runtime.
 */
export const TIP_CHAT_BLOCK_REASONS = [
  "invocation_not_allowed",
  "agent_archived",
  "agent_no_runtime",
] as const;
export type TipChatBlockReason = (typeof TIP_CHAT_BLOCK_REASONS)[number];

/** The structured `code` of a failed request. Duck-typed: no client import. */
function responseCode(err: unknown): string | undefined {
  const body = (err as { body?: unknown } | null)?.body;
  if (!body || typeof body !== "object") return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function responseStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** The refusal an open failure carries, or null for any other failure. */
export function tipChatBlockReason(err: unknown): TipChatBlockReason | null {
  const code = responseCode(err);
  return TIP_CHAT_BLOCK_REASONS.find((reason) => reason === code) ?? null;
}

/**
 * Writes an opened side chat into the chat caches: the detail entry lets a
 * chat surface show a session the list does not carry yet, and a listed row
 * (an earlier chat, possibly just unarchived) takes its current status.
 */
export async function seedOpenedTipChat(
  qc: QueryClient,
  wsId: string,
  session: ChatSession,
): Promise<void> {
  // A fetch of this record that started before the open (a reconnect
  // refetch) would otherwise land on top with the pre-open status.
  await qc.cancelQueries({ queryKey: chatKeys.session(wsId, session.id) });
  qc.setQueryData(chatKeys.session(wsId, session.id), session);
  const listed = qc
    .getQueryData<ChatSession[]>(chatKeys.sessions(wsId))
    ?.find((row) => row.id === session.id);
  if (!listed) return;
  qc.setQueryData<ChatSession[]>(chatKeys.sessions(wsId), (old) =>
    old?.map((row) =>
      row.id === session.id
        ? { ...row, status: session.status, title: session.title, tip_source: session.tip_source }
        : row,
    ),
  );
  // Unarchiving restores unread state that only the list endpoint computes.
  if (listed.status !== session.status) {
    void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
  }
}

/**
 * Opens (or reopens) the side chat for a tip. Never touches the tip's state
 * and never runs the agent: the server only creates the session.
 */
export function useOpenTipChat() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: async (tipId: string): Promise<ChatSession> => {
      try {
        return await api.openTipChat(tipId);
      } catch (err) {
        // The issue changed projects while the server was opening; the
        // contract is to retry once.
        if (responseCode(err) !== "tip_source_changed") throw err;
        return api.openTipChat(tipId);
      }
    },
    onSuccess: (session) => seedOpenedTipChat(qc, wsId, session),
  });
}

export interface TipSideChatLookup {
  /** The active session: its list row, or a side chat the list omits until its first message. */
  currentSession: ChatSession | null;
  /** The list lacks the active id and its side-chat lookup has not answered yet. */
  pending: boolean;
  /**
   * The session alone names the agent — a side chat, or one still being
   * looked up — so a surface must not fall back to another agent.
   */
  pinsAgent: boolean;
}

/**
 * Resolves the active chat session for a chat surface. A listed row wins;
 * otherwise the session's own record answers, and only a side chat is taken
 * from it. A record seeded by the open flow answers at once; others are
 * fetched once the loaded list has confirmed the id is not one of its rows.
 *
 * While the list itself loads nothing is pinned, as for any chat: the agent
 * shown is then the remembered one until the rows arrive. Sends are not
 * affected — they address the session, which carries its own agent.
 */
export function useTipSideChatLookup(
  wsId: string,
  activeSessionId: string | null,
  sessions: readonly ChatSession[],
  sessionsLoaded: boolean,
): TipSideChatLookup {
  const qc = useQueryClient();
  const listed = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId) ?? null
    : null;
  const lookupId = activeSessionId && !listed ? activeSessionId : "";
  // A chat this client just created by sending is waiting for the list to
  // catch up; it is an ordinary chat, so there is nothing to look up or pin.
  // (The surfaces subscribe to this pending-task entry, so they re-render.)
  const justSent =
    lookupId !== "" &&
    !!qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask(lookupId))?.task_id;
  const lookingUp = lookupId !== "" && sessionsLoaded && !justSent;
  const detail = useQuery({
    ...chatSessionOptions(wsId, lookupId),
    enabled: lookingUp,
    // A deleted or foreign session answers 404: no point asking twice.
    retry: (failures, err) => failures < 1 && responseStatus(err) !== 404,
  });
  const gone = detail.status === "error" && responseStatus(detail.error) === 404;
  const record = detail.data;
  const sideChat =
    lookupId !== "" && !gone && record?.id === lookupId && record.tip_source ? record : null;
  const currentSession = listed ?? sideChat;
  // Unanswered, or failed for any reason but "gone": hold on rather than let
  // the surface drop a chat that no list can bring back.
  const pending =
    lookingUp &&
    !sideChat &&
    !gone &&
    (detail.status === "pending" || detail.status === "error");
  return { currentSession, pending, pinsAgent: pending || !!currentSession?.tip_source };
}
