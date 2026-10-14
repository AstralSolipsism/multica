/**
 * Labrastro fork (OL-362): showing a chat session in the main window on behalf
 * of a dedicated issue window. That window's router only accepts issue routes
 * and it has no floating chat, so "Ask about this" there opens the side chat,
 * then asks main to bring the main window forward with it.
 *
 * Renderer → main: OPEN_CHAT_SESSION_REQUEST_CHANNEL (invoke).
 * Main → main renderer: OPEN_CHAT_SESSION_CHANNEL, through the main-renderer
 * message queue, so the request survives a main window that is still loading
 * or has to be recreated.
 */
export const OPEN_CHAT_SESSION_REQUEST_CHANNEL = "window:open-chat-session";
export const OPEN_CHAT_SESSION_CHANNEL = "chat:open-session";

export interface ChatSessionHandoff {
  /** The workspace the session belongs to; the main window may be in another. */
  workspaceSlug: string;
  sessionId: string;
}

export type ChatSessionHandoffResult =
  | { ok: true }
  | { ok: false; reason: "invalid_request" | "untrusted_sender" };

// Same workspace slug rule as dedicated issue windows (issue-window.ts).
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate renderer-controlled input; both sides of the channel use it. */
export function parseChatSessionHandoff(value: unknown): ChatSessionHandoff | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.workspaceSlug !== "string" ||
    !WORKSPACE_SLUG_PATTERN.test(input.workspaceSlug) ||
    typeof input.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(input.sessionId)
  ) {
    return null;
  }
  return { workspaceSlug: input.workspaceSlug, sessionId: input.sessionId };
}
