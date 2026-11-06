"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useCurrentIssueRenderContext } from "../issues/current-issue-render-context";
import { useT } from "../i18n";
import { HTML_BLOCK_MESSAGE_KEY, type HtmlBlockMessage } from "./utils/html-block-document";

type CommentAction = Extract<HtmlBlockMessage, { content: string }>;
interface PendingAction {
  message: CommentAction;
  frame: Window;
  execute: () => boolean | Promise<boolean>;
  sending: boolean;
}

function reply(request: PendingAction, ok: boolean) {
  request.frame.postMessage({ [HTML_BLOCK_MESSAGE_KEY]: 1, type: "action-result", action: request.message.type, ok }, "*");
}

/** Untrusted frames can request an action; only host controls authorize a post. */
export function useHtmlCommentActions(iframeRef: RefObject<HTMLIFrameElement | null>, documentKey: string) {
  const issue = useCurrentIssueRenderContext();
  const pendingRef = useRef<PendingAction | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [sending, setSending] = useState(false);

  useLayoutEffect(() => {
    setPending(null);
    setSending(false);
    return () => {
      const request = pendingRef.current;
      pendingRef.current = null;
      if (request && !request.sending) reply(request, false);
    };
  }, [documentKey, issue?.id]);

  const finish = (request: PendingAction, ok: boolean) => {
    // A reload/navigation must not acknowledge an old request to the new card.
    if (pendingRef.current !== request) return;
    reply(request, ok);
    pendingRef.current = null;
    setPending(null);
    setSending(false);
  };

  const execute = async (request: PendingAction) => {
    if (pendingRef.current !== request || request.sending) return;
    request.sending = true;
    setSending(true);
    let ok = false;
    try { ok = await request.execute(); } catch { /* Keep the answer retryable. */ }
    finish(request, ok);
  };

  const handleAction = (message: CommentAction) => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || pendingRef.current) return;
    const callback = message.type === "submit-comment" ? issue?.submitComment : issue?.fillCommentDraft;
    if (!callback) return;
    const request: PendingAction = {
      message, frame, sending: false,
      execute: message.type === "submit-comment"
        ? () => issue!.submitComment!(message.content)
        : () => { issue!.fillCommentDraft!(message.content); return true; },
    };
    if (message.type === "fill-comment" && !navigator.userActivation?.isActive) {
      reply(request, false);
      return;
    }
    pendingRef.current = request;
    if (message.type === "fill-comment" && issue?.hasCommentDraft?.() === false) {
      void execute(request);
      return;
    }
    setPending(request);
    frame.postMessage({ [HTML_BLOCK_MESSAGE_KEY]: 1, type: "action-pending", action: message.type }, "*");
  };

  const confirmation = pending && (
    <CommentConfirmation request={pending} sending={sending} onConfirm={() => void execute(pending)} onCancel={() => finish(pending, false)} />
  );
  return { handleAction, confirmation, hasPendingAction: () => pendingRef.current !== null };
}

function CommentConfirmation({ request, sending, onConfirm, onCancel }: {
  request: PendingAction;
  sending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useT("editor");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const position = useRef<DOMRect | null>(null);
  const stableSince = useRef(0);
  const [ready, setReady] = useState(false);
  const canConfirm = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const previous = position.current;
    const now = performance.now();
    if (!previous || rect.x !== previous.x || rect.y !== previous.y || rect.width !== previous.width || rect.height !== previous.height) {
      position.current = rect;
      stableSince.current = now;
    }
    const stable = now - stableSince.current >= 500;
    setReady(stable);
    return stable;
  }, []);

  useLayoutEffect(() => {
    position.current = null;
    let frame: number;
    // Scroll, layout shifts and fullscreen can move the button without resizing it.
    const observe = () => {
      canConfirm();
      frame = requestAnimationFrame(observe);
    };
    observe();
    return () => cancelAnimationFrame(frame);
  }, [request, canConfirm]);

  return (
    <section
      aria-label={request.message.type === "submit-comment" ? t(($) => $.html_action.confirm_submit) : t(($) => $.html_action.confirm_fill)}
      aria-busy={sending}
      className="shrink-0 space-y-2 border-t bg-muted p-3"
    >
      <p className="text-label font-medium">
        {request.message.type === "submit-comment" ? t(($) => $.html_action.confirm_submit) : t(($) => $.html_action.confirm_fill)}
      </p>
      {/* Plain text, never another markdown/HTML preview of the untrusted body. */}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-2 font-mono text-caption">{request.message.content}</pre>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={sending} onClick={onCancel}>
          {t(($) => $.html_action.cancel)}
        </Button>
        <Button ref={buttonRef} type="button" size="sm" disabled={sending || !ready} onClick={() => { if (canConfirm()) onConfirm(); }}>
          {sending && <Spinner />}
          {request.message.type === "submit-comment" ? t(($) => $.html_action.post) : t(($) => $.html_action.replace_draft)}
        </Button>
      </div>
    </section>
  );
}
