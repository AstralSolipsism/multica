"use client";

import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  hide,
  offset,
  shift,
  type Placement,
  type Side,
} from "@floating-ui/dom";
import type {
  TipAnchorLevel,
  TipAnchorRect,
} from "@multica/core/you-should-know/anchors";
import { cn } from "@multica/ui/lib/utils";

/** Root markers of the page's two tip layers: the bubble (with its card) and the feedback row. */
const TIP_LAYER_SELECTOR = "[data-ysk-bubble], [data-ysk-feedback]";

/** Whether keyboard focus sits inside one of the page's tip layers. */
export function tipLayerHasFocus(): boolean {
  return document.activeElement?.closest(TIP_LAYER_SELECTOR) != null;
}

/**
 * Preferred side per anchor level; flip/shift take over when it lacks room.
 * The detail header and the summary chips sit at the top of their surface,
 * so the layer hangs below them; rows and board cards prefer the side above.
 * Either way the layer sits beside the anchor, never on it.
 */
const SIDE: Record<TipAnchorLevel, Side> = {
  detail_header: "bottom",
  row: "top",
  summary: "bottom",
};

/**
 * Grow the layer toward the middle of the window: anchors on the left (list
 * rows, the sub-issues chip) extend it rightward, anchors on the right (header
 * chips, later board columns) leftward — so it stays over the page content
 * instead of spilling onto the sidebar.
 */
function placementFor(level: TipAnchorLevel, anchor: TipAnchorRect): Placement {
  const leftHalf = anchor.left + anchor.width / 2 <= window.innerWidth / 2;
  return `${SIDE[level]}-${leftHalf ? "start" : "end"}`;
}

const GAP_PX = 6;
const VIEWPORT_PADDING_PX = 8;

function toClientRect(rect: TipAnchorRect) {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  };
}

/**
 * Mirrors a layer state to the host, and reports `false` on unmount: a layer
 * that goes away (its tip left) is neither hovered nor visible, and never
 * sees the pointerleave or blur that would have said so.
 */
export function useReported(value: boolean, report: (value: boolean) => void): void {
  useEffect(() => {
    report(value);
  }, [value, report]);
  useEffect(() => () => report(false), [report]);
}

/**
 * Keeps the floating layer beside its anchor with floating-ui; returns
 * whether it has a position yet and whether `hide()` found the anchor
 * clipped out of view.
 */
function useAnchoredPosition(
  floatingRef: RefObject<HTMLDivElement | null>,
  measure: () => TipAnchorRect,
  level: TipAnchorLevel,
): { placed: boolean; clipped: boolean } {
  const [placed, setPlaced] = useState(false);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const floating = floatingRef.current;
    if (!floating) return;
    const reference = { getBoundingClientRect: () => toClientRect(measure()) };
    let active = true;
    const update = () => {
      void computePosition(reference, floating, {
        strategy: "fixed",
        placement: placementFor(level, measure()),
        middleware: [
          offset(GAP_PX),
          flip({ padding: VIEWPORT_PADDING_PX }),
          shift({ padding: VIEWPORT_PADDING_PX }),
          hide(),
        ],
      }).then(({ x, y, placement, middlewareData }) => {
        if (!active) return;
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.dataset.placement = placement;
        setPlaced(true);
        setClipped(middlewareData.hide?.referenceHidden === true);
      });
    };
    const cleanup = autoUpdate(reference, floating, update, {
      animationFrame: true,
    });
    return () => {
      active = false;
      cleanup();
    };
  }, [floatingRef, measure, level]);
  return { placed, clipped };
}

const IGNORE_VISIBILITY = () => {};

/** Nothing holds keyboard focus: it fell back to the page body. */
function focusIsFree(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Focuses `target` the first time the layer is on screen. A fresh layer stays
 * `visibility: hidden` until floating-ui has placed it, and a hidden element
 * cannot take focus — so a focus call at mount would be silently dropped.
 * Skipped if focus has meanwhile landed anywhere but the page body.
 */
function useFocusWhenShown(
  visible: boolean,
  target: RefObject<HTMLElement | null> | undefined,
): void {
  const doneRef = useRef(false);
  useEffect(() => {
    if (!visible || !target || doneRef.current) return;
    doneRef.current = true;
    if (focusIsFree()) target.current?.focus({ preventScroll: true });
  }, [visible, target]);
}

export interface TipLayerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "children"> {
  /** Live rect of the anchor the layer rides (see RegisteredTipAnchor.measure). */
  measure: () => TipAnchorRect;
  level: TipAnchorLevel;
  /** The anchor's own popup or a modal layer is open: keep out of the way. */
  suppressed: boolean;
  reducedMotion: boolean;
  /**
   * Whether the user can see the layer: positioned, not clipped and not
   * suppressed.
   */
  onVisibleChange?: (visible: boolean) => void;
  /**
   * Takes over keyboard focus once the layer first shows — for a layer that
   * replaces one the focus was in.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * One floating tip layer beside an anchor (OL-194, OL-196): the bubble that
 * grows into its card, or the feedback row left in its place after
 * "Dismiss".
 *
 * Portaled to <body> and rendered by the page-level provider — never inside
 * the anchor. React bubbles portal events along the component tree, so a
 * layer rendered under an anchor would hand its clicks to the row link or
 * header chip button wrapping that anchor.
 *
 * Positioned with floating-ui like CommentSelectionBubble: the anchor is a
 * virtual element over the registry's live rect, re-read every frame because
 * lists scroll inner containers and reflow without a window event. `hide()`
 * drops the layer once the anchor leaves the viewport; an anchor scrolled out
 * of an inner container is reported invisible by its IntersectionObserver,
 * and the provider re-schedules the tip away from it.
 *
 * Stacking: z-40 — above page panels (the issue peek is z-30) and below
 * menus, popovers, dialogs and tooltips (z-50).
 */
export function TipLayer({
  measure,
  level,
  suppressed,
  reducedMotion,
  onVisibleChange = IGNORE_VISIBILITY,
  initialFocus,
  children,
  ...rootProps
}: TipLayerProps) {
  const floatingRef = useRef<HTMLDivElement>(null);
  const { placed, clipped } = useAnchoredPosition(floatingRef, measure, level);
  const visible = placed && !clipped && !suppressed;
  useReported(visible, onVisibleChange);
  useFocusWhenShown(visible, initialFocus);

  return createPortal(
    <div
      {...rootProps}
      ref={floatingRef}
      data-level={level}
      className="fixed left-0 top-0 z-40 w-max max-w-[min(24rem,calc(100vw-1rem))]"
      style={{ visibility: visible ? "visible" : "hidden" }}
    >
      <div
        data-motion={reducedMotion ? "none" : "fade"}
        className={cn(
          "flex flex-col gap-0.5 rounded-lg bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10",
          // One quiet fade on the way in, nothing looping: a pulse or shimmer
          // reads as nervous next to working agents (see
          // issue-agent-activity-indicator.tsx). Reduced motion: none at all.
          !reducedMotion && "animate-in fade-in-0 duration-150 motion-reduce:animate-none",
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
