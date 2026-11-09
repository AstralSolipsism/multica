"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useChatStore } from "@multica/core/chat";
import type { Attachment, ChatSendAttempt } from "@multica/core/types";
import { createSafeId } from "@multica/core/utils";

/**
 * Reply actions for HTML blocks rendered inside a chat conversation (a
 * decision card's "submit" / "fill" buttons). Provided by both chat surfaces —
 * the full page and the floating window — around their message list and
 * composer, so the SAME card markup works in an issue detail page (whose
 * `CurrentIssueRenderContext` still wins, see use-html-comment-actions) and in
 * a conversation.
 */
export type ChatReplyActions = Readonly<{
  /**
   * Send `content` as the user's next message in the active session through
   * the surface's own `handleSend`, so queueing, failure handling and the
   * archived-agent guards all apply. `cardKey` is the card's stable identity
   * (hashSource of its html): it scopes the retry attempt below.
   */
  submit: (content: string, cardKey: string) => Promise<boolean>;
  /** Replace the compose draft with `content` and focus the composer. */
  fill: (content: string) => void;
}>;

/**
 * The chat composer's send entry — `useChatController().handleSend` on the
 * full page, the floating window's own copy. The attempt argument is passed
 * EXPLICITLY: without it each call mints a fresh clientMessageId and a retry
 * after a lost response would duplicate the message and its task server-side.
 */
export type ChatSurfaceSend = (
  content: string,
  attachmentIds?: string[],
  commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
  draftAttachments?: Attachment[],
  attempt?: ChatSendAttempt,
) => Promise<boolean>;

const ChatReplyActionsContext = createContext<ChatReplyActions | null>(null);

/**
 * The latest `fill` request, consumed by the ChatInput mounted inside the
 * provider. Carried in its own context so the actions value can stay
 * referentially stable — a card's in-flight request must not be dropped just
 * because another card filled the composer (see use-html-comment-actions).
 */
type ChatReplyAdoptRequest = { id: number; content: string };
const ChatReplyAdoptContext = createContext<ChatReplyAdoptRequest | null>(null);

export function ChatReplyActionsProvider({
  handleSend,
  children,
}: {
  handleSend: ChatSurfaceSend;
  children: ReactNode;
}) {
  // One attempt per [sessionId, cardKey], kept across FAILED sends so an
  // unchanged answer retried after a lost response reuses the same
  // clientMessageId and the server's dedup window replays the first result —
  // same rule as the composer's sendAttemptsRef (chat-input.tsx). Component-
  // local by design: not in Zustand, not persisted. A success deletes the
  // record; a changed answer replaces it with a fresh id.
  const attemptsRef = useRef(
    new Map<string, { content: string; attempt: ChatSendAttempt }>(),
  );
  const [adoptRequest, setAdoptRequest] = useState<ChatReplyAdoptRequest | null>(null);
  const nextAdoptIdRef = useRef(0);

  const submit = useCallback(
    async (content: string, cardKey: string): Promise<boolean> => {
      const sessionId = useChatStore.getState().activeSessionId ?? "";
      const key = `${sessionId}:${cardKey}`;
      let record = attemptsRef.current.get(key);
      if (!record || record.content !== content) {
        record = { content, attempt: { clientMessageId: createSafeId() } };
        attemptsRef.current.set(key, record);
      }
      let ok = false;
      try {
        ok = await handleSend(content, undefined, undefined, [], record.attempt);
      } catch {
        ok = false;
      }
      if (ok) attemptsRef.current.delete(key);
      return ok;
    },
    [handleSend],
  );

  const fill = useCallback((content: string) => {
    setAdoptRequest({ id: ++nextAdoptIdRef.current, content });
  }, []);

  const actions = useMemo(() => ({ submit, fill }), [submit, fill]);

  return (
    <ChatReplyActionsContext.Provider value={actions}>
      <ChatReplyAdoptContext.Provider value={adoptRequest}>
        {children}
      </ChatReplyAdoptContext.Provider>
    </ChatReplyActionsContext.Provider>
  );
}

/** The chat reply actions, or null outside a chat surface. */
export function useChatReplyActions(): ChatReplyActions | null {
  return useContext(ChatReplyActionsContext);
}

/**
 * The pending fill request for the composer inside the provider. Id-keyed so
 * ChatInput applies each request exactly once.
 */
export function useChatReplyAdoptRequest(): ChatReplyAdoptRequest | null {
  return useContext(ChatReplyAdoptContext);
}
