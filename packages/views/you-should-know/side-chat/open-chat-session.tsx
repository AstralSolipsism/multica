"use client";

import { createContext, useCallback, useContext } from "react";
import { useChatStore } from "@multica/core/chat";
import { useWorkspacePaths } from "@multica/core/paths";
import { isFloatingChatRouteSuppressed } from "../../chat/floating-chat-visibility";
import { useNavigation } from "../../navigation";

/** Shows a chat session to the member: the surface decides where. */
export type OpenChatSession = (sessionId: string) => void;

/**
 * Where a tip's side chat opens (OL-288 §5). Unset, it opens in this
 * window; a desktop issue window provides one that hands the session to the
 * main window instead, because its own router only accepts issue routes.
 */
export const SideChatOpenerContext = createContext<OpenChatSession | null>(null);

/**
 * Opens a chat session in this window: the floating chat when it is
 * available here, otherwise the Chat page on that session. The floating chat
 * is off in Settings, or the Chat page itself is showing (it hides the
 * floating copy and follows the same active session).
 *
 * Only the active session changes. Drafts stay in their own slots, so text
 * the member left in another chat — or in the new-chat composer — is kept.
 */
export function useOpenChatSession(): OpenChatSession {
  const navigation = useNavigation();
  const chatPath = useWorkspacePaths().chat();
  const { pathname, push } = navigation;
  return useCallback(
    (sessionId) => {
      const chat = useChatStore.getState();
      if (chat.floatingChatEnabled && !isFloatingChatRouteSuppressed(pathname, chatPath)) {
        chat.setActiveSession(sessionId);
        chat.setOpen(true);
        return;
      }
      push(`${chatPath}?session=${encodeURIComponent(sessionId)}`);
    },
    [pathname, push, chatPath],
  );
}

/** The opener for this surface: the provided one, or this window's. */
export function useSideChatOpener(): OpenChatSession {
  const provided = useContext(SideChatOpenerContext);
  const local = useOpenChatSession();
  return provided ?? local;
}
