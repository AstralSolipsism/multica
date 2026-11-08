"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { useCurrentIssueRenderContext } from "../issues/current-issue-render-context";
import { HTML_BLOCK_MESSAGE_KEY, type HtmlBlockMessage } from "./utils/html-block-document";

type CommentAction = Extract<HtmlBlockMessage, { content: string }>;

/** The source frame is checked by the caller; activation is checked at receipt. */
export function useHtmlCommentActions(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  documentKey: string,
  beforeFillComment: () => void,
) {
  const issue = useCurrentIssueRenderContext();
  const inFlight = useRef<object | null>(null);

  useLayoutEffect(() => () => { inFlight.current = null; }, [documentKey, issue?.id]);

  const handleAction = async (message: CommentAction) => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || inFlight.current) return;
    const callback = message.type === "submit-comment" ? issue?.submitComment : issue?.fillCommentDraft;
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
        ok = await issue!.submitComment!(message.content);
      } else {
        beforeFillComment();
        issue!.fillCommentDraft!(message.content);
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
