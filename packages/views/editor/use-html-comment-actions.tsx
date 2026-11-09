"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { useCurrentIssueRenderContext } from "../issues/current-issue-render-context";
import { useChatReplyActions } from "../chat/chat-reply-actions-context";
import { HTML_BLOCK_MESSAGE_KEY, type HtmlBlockMessage } from "./utils/html-block-document";

type CommentAction = Extract<HtmlBlockMessage, { content: string }>;

/** The source frame is checked by the caller; activation is checked at receipt. */
export function useHtmlCommentActions(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  documentKey: string,
  beforeFillComment: () => void,
  /**
   * Stable card identity (hashSource of the html). Scoped per card for the
   * Chat retry contract — NOT the volatile documentKey, which changes on
   * reload or theme switch and would fork the attempt record.
   */
  cardKey: string,
) {
  const issue = useCurrentIssueRenderContext();
  const chat = useChatReplyActions();
  const inFlight = useRef<object | null>(null);

  useLayoutEffect(() => () => { inFlight.current = null; }, [documentKey, issue?.id]);

  const handleAction = async (message: CommentAction) => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || inFlight.current) return;
    // Issue detail owns its composer when present; cards inside a chat
    // conversation fall back to that surface's send/draft actions.
    const submit = issue?.submitComment
      ?? (chat ? (content: string) => chat.submit(content, cardKey) : undefined);
    const fill = issue?.fillCommentDraft ?? chat?.fill;
    const callback = message.type === "submit-comment" ? submit : fill;
    if (!callback) return;
    const reply = (ok: boolean) => frame.postMessage({
      [HTML_BLOCK_MESSAGE_KEY]: 1, type: "action-result", action: message.type, ok,
    }, "*");
    // Transient activation can originate elsewhere on the page; it is not
    // proof of a click inside this frame or consent to specific comment text.
    if (!navigator.userActivation?.isActive) {
      reply(false);
      return;
    }
    const request = {};
    inFlight.current = request;
    let ok = false;
    try {
      if (message.type === "submit-comment") {
        ok = await submit!(message.content);
      } else {
        beforeFillComment();
        fill!(message.content);
        ok = true;
      }
    } catch { /* A failed action leaves the card retryable. */ }
    // Reload/navigation must not acknowledge an old request to a new document.
    if (inFlight.current !== request) return;
    inFlight.current = null;
    reply(ok);
  };

  return { handleAction };
}
