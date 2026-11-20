"use client";

import {
  createContext,
  use,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatSendAttempt } from "@multica/core/types";
import { createSafeId } from "@multica/core/utils";
import { useChatStore } from "@multica/core/chat";
import { HtmlBlockHostActionsProvider, type HtmlBlockHostActions } from "../editor/html-block-host-actions";
import type { useChatController } from "./components/use-chat-controller";

type ChatSurfaceSend = ReturnType<typeof useChatController>["handleSend"];
type FillDraft = (content: string) => void;
const ChatReplyDraftContext = createContext<RefObject<FillDraft | null> | null>(null);

export function ChatReplyActionsProvider({
  handleSend,
  children,
}: {
  handleSend: ChatSurfaceSend;
  children: ReactNode;
}) {
  // A retry of the same answer reuses the server receipt's submission ID.
  const attemptsRef = useRef(new Map<string, { content: string; attempt: ChatSendAttempt }>());
  const fillDraftRef = useRef<FillDraft>(null);

  const actions = useMemo<HtmlBlockHostActions>(() => ({
    fillComment: (content) => fillDraftRef.current?.(content),
    submitComment: async (content, cardKey) => {
      const sessionId = useChatStore.getState().activeSessionId ?? "";
      const key = `${sessionId}:${cardKey}`;
      let record = attemptsRef.current.get(key);
      if (!record || record.content !== content) {
        record = { content, attempt: { submissionId: createSafeId() } };
        attemptsRef.current.set(key, record);
      }
      const ok = await handleSend(content, undefined, undefined, [], record.attempt);
      if (ok && attemptsRef.current.get(key) === record) attemptsRef.current.delete(key);
      return ok;
    },
  }), [handleSend]);

  return (
    <HtmlBlockHostActionsProvider value={actions}>
      <ChatReplyDraftContext.Provider value={fillDraftRef}>
        {children}
      </ChatReplyDraftContext.Provider>
    </HtmlBlockHostActionsProvider>
  );
}

export function useRegisterChatReplyDraft(fillDraft: FillDraft) {
  const ref = use(ChatReplyDraftContext);
  useImperativeHandle(ref, () => fillDraft, [fillDraft]);
}
