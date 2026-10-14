import {
  OPEN_CHAT_SESSION_CHANNEL,
  parseChatSessionHandoff,
  type ChatSessionHandoff,
  type ChatSessionHandoffResult,
} from "../shared/chat-session-handoff";
import type { MainRendererMessageChannel } from "../shared/main-renderer-messages";

export interface ChatSessionHandoffDeps<W, S> {
  /** The window that sent an IPC message (BrowserWindow.fromWebContents). */
  windowOf: (sender: S) => W | null;
  /** Dedicated issue windows that are still open. */
  issueWindows: ReadonlySet<W>;
  /** Whether an issue window has confirmed the main window's account. */
  accounts: { isCurrentIssueSession(window: W): boolean };
  /** Messages waiting for the main renderer's listener. */
  queue: { clear(channel: MainRendererMessageChannel): void };
  /** Queue for the main renderer and focus — or recreate — the main window. */
  dispatch: (handoff: ChatSessionHandoff) => void;
}

/**
 * The main process side of the issue-window chat handoff (OL-362), with the
 * account boundary in one tested place: a request is taken only from a
 * dedicated issue window that has confirmed the main window's account. The
 * main window opens chats itself, a window still confirming its account (or
 * left over from another one) must not steer it, and a queued session goes
 * when the main window's account changes.
 */
export function createChatSessionHandoff<W, S>(deps: ChatSessionHandoffDeps<W, S>) {
  return {
    /** Answers OPEN_CHAT_SESSION_REQUEST_CHANNEL (ipcMain.handle). */
    handleRequest(event: { sender: S }, request: unknown): ChatSessionHandoffResult {
      const window = deps.windowOf(event.sender);
      if (
        !window ||
        !deps.issueWindows.has(window) ||
        !deps.accounts.isCurrentIssueSession(window)
      ) {
        return { ok: false, reason: "untrusted_sender" };
      }
      const handoff = parseChatSessionHandoff(request);
      if (!handoff) return { ok: false, reason: "invalid_request" };
      deps.dispatch(handoff);
      return { ok: true };
    },
    /** The main window's account changed: a waiting session was the old one's. */
    dropForAccountChange(): void {
      deps.queue.clear(OPEN_CHAT_SESSION_CHANNEL);
    },
  };
}
