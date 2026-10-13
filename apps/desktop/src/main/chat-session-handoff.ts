import {
  parseChatSessionHandoff,
  type ChatSessionHandoff,
  type ChatSessionHandoffResult,
} from "../shared/chat-session-handoff";

/**
 * Answer an issue window's request to show a chat session in the main window
 * (OL-362). Only a dedicated issue window of the current account may ask: the
 * main window opens chats itself, and a window left over from another account
 * must not steer this one. `deliver` queues the session for the main
 * renderer, focusing — or recreating — the main window.
 */
export function handleChatSessionHandoff(
  request: unknown,
  {
    fromCurrentIssueWindow,
    deliver,
  }: {
    fromCurrentIssueWindow: boolean;
    deliver: (handoff: ChatSessionHandoff) => void;
  },
): ChatSessionHandoffResult {
  if (!fromCurrentIssueWindow) return { ok: false, reason: "untrusted_sender" };
  const handoff = parseChatSessionHandoff(request);
  if (!handoff) return { ok: false, reason: "invalid_request" };
  deliver(handoff);
  return { ok: true };
}
