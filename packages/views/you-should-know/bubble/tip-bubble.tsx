"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
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
import type { IssueTipTag } from "@multica/core/you-should-know";
import type {
  TipAnchorLevel,
  TipAnchorRect,
} from "@multica/core/you-should-know/anchors";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

/**
 * Preferred side per anchor level; flip/shift take over when it lacks room.
 * The detail header and the summary chips sit at the top of their surface,
 * so the bubble hangs below them; rows and board cards prefer the side
 * above. Either way the bubble sits beside the anchor, never on it.
 */
const SIDE: Record<TipAnchorLevel, Side> = {
  detail_header: "bottom",
  row: "top",
  summary: "bottom",
};

/**
 * Grow the bubble toward the middle of the window: anchors on the left (list
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

/** The bystander marker; a glyph, not copy — its meaning lives in the tooltip. */
const BYSTANDER_MARKER = "✦";

function toClientRect(rect: TipAnchorRect) {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  };
}

export interface TipBubbleProps {
  /** Live rect of the anchor the bubble rides (see RegisteredTipAnchor.measure). */
  measure: () => TipAnchorRect;
  level: TipAnchorLevel;
  tag: IssueTipTag;
  line: string;
  /** Issue prefix, set when the bubble rides a summary covering many issues. */
  issueIdentifier: string | null;
  /** Deep link for the "turn this off in personal settings" line; null omits it. */
  settingsHref: string | null;
  /** The anchor's own popup or a modal layer is open: keep out of the way. */
  suppressed: boolean;
  reducedMotion: boolean;
  /** Pointer over, or keyboard focus inside, the bubble. */
  onEngagedChange: (engaged: boolean) => void;
  /** Positioned, not clipped and not suppressed — the user can see it. */
  onVisibleChange: (visible: boolean) => void;
  /** Activating the bubble opens the tip's card (OL-196); until then a no-op. */
  onActivate?: () => void;
}

/**
 * Mirrors a bubble state to the host, and reports `false` on unmount: a
 * bubble that goes away (its tip left) is neither hovered nor visible, and
 * never sees the pointerleave or blur that would have said so.
 */
function useReported(value: boolean, report: (value: boolean) => void): void {
  useEffect(() => {
    report(value);
  }, [value, report]);
  useEffect(() => () => report(false), [report]);
}

/**
 * Keeps the floating bubble beside its anchor with floating-ui; returns
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

/**
 * The page's single You-should-know bubble (OL-187 §6, OL-194):
 * `✦ Tag · line`, with the issue identifier before the line on a summary.
 *
 * Rendered by the page-level provider and portaled to <body> — never inside
 * the anchor. React bubbles portal events along the component tree, so a
 * bubble rendered under an anchor would hand its clicks to the row link or
 * header chip button wrapping that anchor.
 *
 * Positioned with floating-ui like CommentSelectionBubble: the anchor is a
 * virtual element over the registry's live rect, re-read every frame because
 * lists scroll inner containers and reflow without a window event. `hide()`
 * drops the bubble once the anchor leaves the viewport; an anchor scrolled out
 * of an inner container is reported invisible by its IntersectionObserver,
 * and the provider re-schedules the tip away from it.
 *
 * Stacking: z-40 — above page panels (the issue peek is z-30) and below
 * menus, popovers, dialogs and tooltips (z-50).
 */
export function TipBubble({
  measure,
  level,
  tag,
  line,
  issueIdentifier,
  settingsHref,
  suppressed,
  reducedMotion,
  onEngagedChange,
  onVisibleChange,
  onActivate,
}: TipBubbleProps) {
  const { t } = useT("you-should-know");
  const floatingRef = useRef<HTMLDivElement>(null);
  const { placed, clipped } = useAnchoredPosition(floatingRef, measure, level);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const visible = placed && !clipped && !suppressed;
  useReported(pointerInside || focusInside, onEngagedChange);
  useReported(visible, onVisibleChange);

  return createPortal(
    <div
      ref={floatingRef}
      data-ysk-bubble=""
      data-level={level}
      className="fixed left-0 top-0 z-40 w-max max-w-[min(24rem,calc(100vw-1rem))]"
      style={{ visibility: visible ? "visible" : "hidden" }}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusInside(false);
        }
      }}
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
        <button
          type="button"
          onClick={onActivate}
          className="flex min-w-0 items-baseline gap-1.5 rounded-sm text-left text-caption outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Tooltip>
            <TooltipTrigger
              render={<span className="shrink-0 text-brand" aria-hidden="true" />}
            >
              {BYSTANDER_MARKER}
            </TooltipTrigger>
            <TooltipContent>{t(($) => $.bubble.marker_tooltip)}</TooltipContent>
          </Tooltip>
          <span
            className={cn(
              "shrink-0 font-medium",
              tag === "heads_up" && "text-warning",
            )}
          >
            {t(($) => $.tag[tag])}
          </span>
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0">
            {issueIdentifier && (
              <span className="mr-1 text-muted-foreground">{issueIdentifier}</span>
            )}
            {line}
          </span>
        </button>
        {settingsHref && (
          <AppLink
            href={settingsHref}
            className="w-fit rounded-sm text-micro text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(($) => $.bubble.settings_hint)}
          </AppLink>
        )}
      </div>
    </div>,
    document.body,
  );
}
