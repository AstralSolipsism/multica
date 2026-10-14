"use client";

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { WSClient } from "../api/ws-client";
import { getCurrentWsId } from "../platform/workspace-storage";
import { chatKeys } from "../chat/queries";
import { youShouldKnowKeys } from "./queries";
import type { IssueTipList, IssueTipUserState } from "../api/labrastro-ysk-schemas";
import type {
  ChatSession,
  IssueTipChangedPayload,
  IssueTipStateChangedPayload,
} from "../types";

/** Debounce window for task-lifecycle invalidations of the active list. */
const ACTIVE_REFRESH_DEBOUNCE_MS = 750;

/** Patch `user_state` on one tip across every cached YSK list. */
function applyTipStateToCaches(
  qc: QueryClient,
  wsId: string,
  tipId: string,
  userState: IssueTipUserState | null,
) {
  for (const [key] of qc.getQueriesData<IssueTipList>({
    queryKey: youShouldKnowKeys.all(wsId),
  })) {
    qc.setQueryData<IssueTipList>(key, (old) =>
      old
        ? {
            ...old,
            tips: old.tips.map((tip) =>
              tip.id === tipId ? { ...tip, user_state: userState } : tip,
            ),
          }
        : old,
    );
  }
}

interface ChatSessionChangedPayload {
  chat_session_id?: string;
  title?: string;
  project_id?: string | null;
  status?: ChatSession["status"];
  updated_at?: string;
}

/**
 * A side chat stays out of the session list until its first message, so the
 * chat surfaces read it from its detail entry (useTipSideChatLookup). The list
 * handlers never reach that entry: keep renames and archiving in step with it.
 */
function applySessionUpdateToDetail(qc: QueryClient, wsId: string, payload: ChatSessionChangedPayload) {
  const sessionId = payload.chat_session_id;
  if (!sessionId) return;
  qc.setQueryData<ChatSession>(chatKeys.session(wsId, sessionId), (old) =>
    old
      ? {
          ...old,
          title: payload.title ?? old.title,
          ...("project_id" in payload ? { project_id: payload.project_id } : {}),
          status: payload.status ?? old.status,
          updated_at: payload.updated_at ?? old.updated_at,
        }
      : old,
  );
}

/**
 * Keeps the You Should Know caches in sync with WS events (OL-187 §13 H).
 *
 * - `issue_tip:created` / `issue_tip:updated`: each event carries the tip;
 *   invalidate that issue's tip lists (both status variants) plus the active
 *   list. These events broadcast workspace-wide, so scoping keeps other
 *   issues' mounted queries untouched. Without a usable `issue_id` in the
 *   payload, fall back to invalidating all YSK queries.
 * - `issue_tip_state:changed`: patch `user_state` in place when the payload
 *   carries `tip_id` + `state` (this is what makes a tip vanish in every
 *   other tab of the same user); otherwise invalidate.
 * - task lifecycle events: debounced active-list refresh — whenever an agent
 *   starts or stops working, the active tip set changes.
 * - `chat:session_updated` / `chat:session_deleted`: patch or drop a side
 *   chat's detail entry (applySessionUpdateToDetail).
 * - reconnect: invalidate everything (events may have been missed).
 */
export function useYouShouldKnowRealtimeSync(ws: WSClient | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!ws) return;

    const onTipChanged = (payload: unknown) => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      const issueId = (payload as IssueTipChangedPayload)?.tip?.issue_id;
      if (!issueId) {
        qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
        return;
      }
      qc.invalidateQueries({ queryKey: youShouldKnowKeys.issueAnyStatus(wsId, issueId) });
      qc.invalidateQueries({ queryKey: youShouldKnowKeys.active(wsId) });
    };

    const onTipStateChanged = (payload: unknown) => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      const { tip_id: tipId, state, feedback } =
        payload as IssueTipStateChangedPayload;
      if (tipId && state) {
        applyTipStateToCaches(qc, wsId, tipId, { state, feedback: feedback ?? null });
      } else {
        qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
      }
    };

    let activeTimer: ReturnType<typeof setTimeout> | null = null;
    const onTaskLifecycle = () => {
      const wsId = getCurrentWsId();
      if (!wsId) return;
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = setTimeout(() => {
        activeTimer = null;
        qc.invalidateQueries({ queryKey: youShouldKnowKeys.active(wsId) });
      }, ACTIVE_REFRESH_DEBOUNCE_MS);
    };

    const onChatSessionUpdated = (payload: unknown) => {
      const wsId = getCurrentWsId();
      if (wsId) applySessionUpdateToDetail(qc, wsId, payload as ChatSessionChangedPayload);
    };

    const onChatSessionDeleted = (payload: unknown) => {
      const wsId = getCurrentWsId();
      const sessionId = (payload as ChatSessionChangedPayload)?.chat_session_id;
      if (wsId && sessionId) qc.removeQueries({ queryKey: chatKeys.session(wsId, sessionId) });
    };

    const unsubTipCreated = ws.on("issue_tip:created", onTipChanged);
    const unsubTipUpdated = ws.on("issue_tip:updated", onTipChanged);
    const unsubTipState = ws.on("issue_tip_state:changed", onTipStateChanged);
    const unsubChatSessionUpdated = ws.on("chat:session_updated", onChatSessionUpdated);
    const unsubChatSessionDeleted = ws.on("chat:session_deleted", onChatSessionDeleted);
    const unsubTaskRunning = ws.on("task:running", onTaskLifecycle);
    const unsubTaskCompleted = ws.on("task:completed", onTaskLifecycle);
    const unsubTaskFailed = ws.on("task:failed", onTaskLifecycle);
    const unsubTaskCancelled = ws.on("task:cancelled", onTaskLifecycle);
    const unsubReconnect = ws.onReconnect(() => {
      const wsId = getCurrentWsId();
      if (wsId) qc.invalidateQueries({ queryKey: youShouldKnowKeys.all(wsId) });
    });

    return () => {
      unsubTipCreated();
      unsubTipUpdated();
      unsubTipState();
      unsubChatSessionUpdated();
      unsubChatSessionDeleted();
      unsubTaskRunning();
      unsubTaskCompleted();
      unsubTaskFailed();
      unsubTaskCancelled();
      unsubReconnect();
      if (activeTimer) clearTimeout(activeTimer);
    };
  }, [ws, qc]);
}
