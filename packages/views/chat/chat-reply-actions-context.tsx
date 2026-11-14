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
import type { Attachment } from "@multica/core/types";

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
   * (hashSource of its html).
   */
  submit: (content: string, cardKey: string) => Promise<boolean>;
  /** Replace the compose draft with `content` and focus the composer. */
  fill: (content: string) => void;
}>;

/**
 * The chat composer's send entry — `useChatController().handleSend` on the
 * full page, the floating window's own copy.
 */
export type ChatSurfaceSend = (
  content: string,
  attachmentIds?: string[],
  commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
  draftAttachments?: Attachment[],
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
  const [adoptRequest, setAdoptRequest] = useState<ChatReplyAdoptRequest | null>(null);
  const nextAdoptIdRef = useRef(0);

  const submit = useCallback(
    async (content: string, _cardKey: string): Promise<boolean> => {
      try {
        return await handleSend(content, undefined, undefined, []);
      } catch {
        return false;
      }
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
