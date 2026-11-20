"use client";

import { useEffectEvent, useLayoutEffect, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useHtmlBlockHostActions } from "./html-block-host-actions";
import { HTML_BLOCK_MESSAGE_KEY } from "./utils/html-block-document";
import { hashSource } from "./utils/source-hash";

const MAX_COMMENT_LENGTH = 16 * 1024;

export function useHtmlCommentActions(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  srcDoc: string | null,
  reloadKey: number,
  html: string,
  closeFullscreen: (() => void) | undefined,
) {
  const actions = useHtmlBlockHostActions();
  const resolveAction = useEffectEvent((type: "submit-comment" | "fill-comment") => {
    if (type === "submit-comment") {
      const submit = actions?.submitComment;
      return submit && ((content: string) => submit(content, hashSource(html)));
    }
    const fill = actions?.fillComment;
    return fill && ((content: string) => {
      // Release the native modal before the host focuses its composer.
      if (closeFullscreen) flushSync(closeFullscreen);
      return fill(content);
    });
  });

  useLayoutEffect(() => {
    if (srcDoc === null) return;
    // The result protocol has no request ID. Serialize actions within each document.
    let pending = false;
    let disposed = false;

    const onMessage = async (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame || pending) return;
      const message = event.data as Record<string, unknown> | null;
      if (message?.[HTML_BLOCK_MESSAGE_KEY] !== 1) return;
      const { type, content } = message;
      if (type !== "submit-comment" && type !== "fill-comment") return;
      if (typeof content !== "string" || !content.trim()) return;
      const action = resolveAction(type);
      if (!action) return;

      const reply = (ok: boolean) => frame.postMessage({
        [HTML_BLOCK_MESSAGE_KEY]: 1, type: "action-result", action: type, ok,
      }, "*");
      // Page activation is required and can originate outside this frame.
      if (!navigator.userActivation?.isActive) {
        reply(false);
        return;
      }

      pending = true;
      let ok = false;
      try {
        ok = (await action(content.slice(0, MAX_COMMENT_LENGTH))) !== false;
      } catch { /* Report failure so the card can retry. */ }
      pending = false;
      if (!disposed) reply(ok);
    };

    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Effect Events read current callbacks without replacing the listener.
  }, [iframeRef, srcDoc, reloadKey]);
}
