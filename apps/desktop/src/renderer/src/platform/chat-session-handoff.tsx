import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { getCurrentSlug } from "@multica/core/platform";
import { paths } from "@multica/core/paths";
import { useT } from "@multica/views/i18n";
import { useNavigation } from "@multica/views/navigation";
import { useOpenChatSession, type OpenChatSession } from "@multica/views/you-should-know";

/**
 * Issue window end of the chat handoff (OL-362): "Ask about this" opens the
 * side chat there, and this hands the session to the main window. The issue
 * window cannot show it itself — its router only accepts issue routes and it
 * mounts no floating chat.
 */
export function useMainWindowChatOpener(workspaceSlug: string): OpenChatSession {
  const { t } = useT("you-should-know");
  return useCallback(
    (sessionId) => {
      // The session exists by now; say so if it cannot be shown.
      const failed = (reason: unknown) => {
        console.warn("[chat-session-handoff] main window did not take the session", reason);
        toast.error(t(($) => $.errors.open_chat_failed));
      };
      window.desktopAPI
        .openChatSessionInMainWindow({ workspaceSlug, sessionId })
        .then((result) => {
          if (!result.ok) failed(result.reason);
        }, failed);
    },
    [workspaceSlug, t],
  );
}

/**
 * Main window end of the chat handoff (OL-362). Main focuses (or recreates)
 * this window and delivers the session once this listener is installed. A
 * session of the workspace on screen opens like an "Ask about this" here — the
 * floating chat when available, otherwise the Chat page; one from another
 * workspace goes to that workspace's Chat page, the adapter switching to it.
 *
 * Mount inside the workspace slug provider, only while a workspace is shown:
 * until then main keeps the request queued.
 */
export function DesktopChatSessionBridge() {
  const openChatSession = useOpenChatSession();
  const { push } = useNavigation();
  // The adapter changes with the active tab's location; keep the main-process
  // subscription stable across navigations.
  const latest = useRef({ openChatSession, push });
  useEffect(() => {
    latest.current = { openChatSession, push };
  }, [openChatSession, push]);

  useEffect(() => {
    if (window.desktopAPI.windowContext?.kind === "issue") return undefined;
    // Optional call keeps renderer HMR safe while an old preload is attached.
    return window.desktopAPI.onOpenChatSession?.(({ workspaceSlug, sessionId }) => {
      if (workspaceSlug === getCurrentSlug()) {
        latest.current.openChatSession(sessionId);
        return;
      }
      latest.current.push(
        `${paths.workspace(workspaceSlug).chat()}?session=${encodeURIComponent(sessionId)}`,
      );
    });
  }, []);

  return null;
}
