// Pure state transitions for the group/topic target fields shared by the two
// push editors (OL-74). Canonical home of the "which fields survive an edit"
// rule — the component suites cover wiring, the matrices live in
// target-selection.test.ts.

/** The topic anchor triple kept in the editors' local state. IDs persist to
 * the route; `summary` is display-only. */
export interface TopicAnchorState {
  messageId: string;
  threadId: string;
  summary: string;
}

const EMPTY_ANCHOR: TopicAnchorState = { messageId: "", threadId: "", summary: "" };

/** A topic anchor belongs to its group (the server enforces
 * belongs-to-group). Any chat change — picking another group OR retyping the
 * ID in the manual fallback — invalidates the current anchor; an unchanged
 * chat keeps it. */
export function anchorAfterChatChange(
  prevChatId: string,
  nextChatId: string,
  anchor: TopicAnchorState,
): TopicAnchorState {
  return nextChatId === prevChatId ? anchor : EMPTY_ANCHOR;
}

/** The thread belongs to the message it was discovered on. Retyping the
 * anchor message ID by hand (discovery fallback) must not keep the old
 * message's thread or summary — the backend persists a thread only as long
 * as it matches the message, and a stale pair breaks topic delivery. An
 * unchanged message keeps both (editing an untouched saved route). */
export function anchorAfterMessageEdit(
  prevMessageId: string,
  nextMessageId: string,
  anchor: TopicAnchorState,
): TopicAnchorState {
  if (nextMessageId === prevMessageId) return anchor;
  return { messageId: nextMessageId, threadId: "", summary: "" };
}
