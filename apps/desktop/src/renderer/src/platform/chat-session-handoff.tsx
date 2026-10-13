import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { getCurrentSlug } from "@multica/core/platform";
import { useRequiredWorkspaceSlug } from "@multica/core/paths";
import { useT } from "@multica/views/i18n";
import { useOpenChatSession, type OpenChatSession } from "@multica/views/you-should-know";
import { useTabStore } from "@/stores/tab-store";
import type { ChatSessionHandoff } from "../../../shared/chat-session-handoff";

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
 * this window and delivers the session once this listener is installed. It
 * opens like an "Ask about this" here — the floating chat when available,
 * otherwise the Chat page. A session of another workspace first switches the
 * window to that workspace (its tabs as they were), then opens by the same
 * rule once that workspace is on screen; going somewhere else meanwhile
 * drops it.
 *
 * Mount inside the workspace slug provider, only while a workspace is shown:
 * until then main keeps the request queued.
 */
export function DesktopChatSessionBridge() {
  const slug = useRequiredWorkspaceSlug();
  const openChatSession = useOpenChatSession();
  // The opener changes with the active tab's location; keep the main-process
  // subscription stable across navigations.
  const latest = useRef(openChatSession);
  useEffect(() => {
    latest.current = openChatSession;
  }, [openChatSession]);
  const waiting = useRef<{ handoff: ChatSessionHandoff; from: string | null } | null>(null);

  useEffect(() => {
    if (window.desktopAPI.windowContext?.kind === "issue") return undefined;
    // Optional call keeps renderer HMR safe while an old preload is attached.
    return window.desktopAPI.onOpenChatSession?.((handoff) => {
      const current = getCurrentSlug();
      if (handoff.workspaceSlug === current) {
        waiting.current = null;
        latest.current(handoff.sessionId);
        return;
      }
      waiting.current = { handoff, from: current };
      useTabStore.getState().switchWorkspace(handoff.workspaceSlug);
    });
  }, []);

  // This provider follows the workspace on screen, so a landed switch shows
  // up here; the chat store already writes to that workspace's slots.
  useEffect(() => {
    const entry = waiting.current;
    if (!entry) return;
    if (slug === entry.handoff.workspaceSlug) {
      waiting.current = null;
      openChatSession(entry.handoff.sessionId);
    } else if (slug !== entry.from) {
      waiting.current = null;
    }
  }, [slug, openChatSession]);

  return null;
}
