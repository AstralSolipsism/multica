"use client";

import { useCallback, useEffect, useRef } from "react";

interface ReadingAnchor {
  element: Element;
  top: number;
  scrollTop: number;
}

/**
 * Virtuoso compensates prepends and resizes during upward scrolling, but its
 * resize compensation stops when scrolling is idle. Keep a visible text block
 * in place when an overscanned iframe, diagram or image finishes later. Measure
 * the residual displacement AFTER Virtuoso has committed its own compensation;
 * applying the height delta itself would count that compensation twice.
 */
export function useReadingAnchor(
  scrollRoot: HTMLElement | null,
  isFollowing: () => boolean,
  scrollBy: (top: number) => void,
  active = true,
) {
  const scheduleRef = useRef<() => void>(() => {});
  const callbacks = useRef({ isFollowing, scrollBy });
  callbacks.current = { isFollowing, scrollBy };

  useEffect(() => {
    if (!active || !scrollRoot) return;
    let anchor: ReadingAnchor | null = null;
    let frame = 0;
    let touching = false;
    let dragging = false;

    const capture = () => {
      anchor = null;
      if (callbacks.current.isFollowing()) return;
      const viewport = scrollRoot.getBoundingClientRect();
      // Anchor inside the row: anchoring only its top would miss an iframe
      // growing above the reading line in that SAME long message.
      // Include fold triggers so an expansion grows below its own anchor.
      const candidates = scrollRoot.querySelectorAll(
        "[data-chat-message-row] p, [data-chat-message-row] pre, " +
        "[data-chat-message-row] li, [data-chat-message-row] h1, " +
        "[data-chat-message-row] h2, [data-chat-message-row] h3, " +
        '[data-chat-message-row] [data-slot="collapsible-trigger"], ' +
        "[data-chat-message-row] [data-rich-block-shell], [data-chat-message-row]",
      );
      // Rows are fallbacks only; prefer their visible content or fold trigger.
      const elements = Array.from(candidates);
      const element = elements.find((el) => {
        if (el.hasAttribute("data-chat-message-row")) return false;
        const rect = el.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }) ?? elements.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      if (element) anchor = {
        element,
        top: element.getBoundingClientRect().top,
        scrollTop: scrollRoot.scrollTop,
      };
    };

    const settle = () => {
      frame = 0;
      if (!touching && !dragging && !callbacks.current.isFollowing() && anchor?.element.isConnected) {
        const delta = anchor.element.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) > 1) callbacks.current.scrollBy(delta);
      }
      capture();
    };
    const schedule = () => {
      if (frame) return;
      // Prepending commits its offset and scroll correction over two frames.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(settle); });
    };
    scheduleRef.current = schedule;

    const onScroll = () => {
      if (frame || touching || dragging) return;
      if (anchor?.element.isConnected) {
        const offset = anchor.element.getBoundingClientRect().top + scrollRoot.scrollTop;
        if (Math.abs(offset - anchor.top - anchor.scrollTop) > 1) {
          schedule();
          return;
        }
      }
      capture();
    };
    const onInput = () => {
      // Reader input owns the viewport, including during a queued correction.
      anchor = null;
      schedule();
    };
    const onTouchStart = () => { touching = true; onInput(); };
    const onTouchEnd = () => { touching = false; onInput(); };
    const onPointerDown = (event: PointerEvent) => {
      dragging = event.target === scrollRoot;
      onInput();
    };
    const onPointerUp = () => { if (dragging) { dragging = false; onInput(); } };
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    scrollRoot.addEventListener("wheel", onInput, { passive: true });
    scrollRoot.addEventListener("keydown", onInput);
    scrollRoot.addEventListener("touchstart", onTouchStart, { passive: true });
    scrollRoot.addEventListener("touchend", onTouchEnd, { passive: true });
    scrollRoot.addEventListener("touchcancel", onTouchEnd, { passive: true });
    scrollRoot.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    capture();
    return () => {
      cancelAnimationFrame(frame);
      scheduleRef.current = () => {};
      scrollRoot.removeEventListener("scroll", onScroll);
      scrollRoot.removeEventListener("wheel", onInput);
      scrollRoot.removeEventListener("keydown", onInput);
      scrollRoot.removeEventListener("touchstart", onTouchStart);
      scrollRoot.removeEventListener("touchend", onTouchEnd);
      scrollRoot.removeEventListener("touchcancel", onTouchEnd);
      scrollRoot.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [active, scrollRoot]);

  return useCallback(() => scheduleRef.current(), []);
}
