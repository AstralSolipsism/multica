"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { IssueTip } from "@multica/core/you-should-know";
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
import { BYSTANDER_MARKER } from "./bystander-marker";
import { TipCard } from "./tip-card";
import { TipLayer, useReported } from "./tip-layer";
import { useHoldTipRotation } from "./tip-rotation-hold";

export interface TipBubbleProps {
  /** The tip on display; visibility receipts name it. */
  tip: Pick<IssueTip, "id" | "tag" | "line" | "title" | "explanation">;
  /** Live rect of the anchor the bubble rides (see RegisteredTipAnchor.measure). */
  measure: () => TipAnchorRect;
  level: TipAnchorLevel;
  /** Issue prefix, set when the bubble rides a summary covering many issues. */
  issueIdentifier: string | null;
  /** Deep link for the "turn this off in personal settings" line; null omits it. */
  settingsHref: string | null;
  /** The anchor's own popup or a modal layer is open: keep out of the way. */
  suppressed: boolean;
  reducedMotion: boolean;
  /**
   * Mounted in place of a tip layer that had keyboard focus: take it over
   * once on screen. Read on the first render only.
   */
  takeFocus: boolean;
  /** Pointer over, or keyboard focus inside, the bubble. */
  onEngagedChange: (engaged: boolean) => void;
  /**
   * Visibility receipt for this bubble's tip: positioned, not clipped and not
   * suppressed means the user can see it.
   */
  onVisibleChange: (tipId: string, visible: boolean) => void;
  /** "I already know" / "Got it". */
  onKnown: () => void;
  /** "Dismiss"; `expanded` when it came after "Learn more". */
  onDismiss: (expanded: boolean) => void;
  /** "Discuss in comments". */
  onDiscuss: () => void;
}

/**
 * Whether the bubble is open into its card. An open card holds the rotation.
 * Closing it from the bubble — a second click on the bubble line, or Escape
 * anywhere in it — hands focus back to the bubble line; an action that
 * closes it decides where focus goes itself.
 */
function useCardDisclosure(toggleRef: RefObject<HTMLButtonElement | null>) {
  const [open, setOpen] = useState(false);
  useHoldTipRotation(open);
  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) toggleRef.current?.focus({ preventScroll: true });
    },
    [toggleRef],
  );
  const toggle = useCallback(() => {
    if (open) close(true);
    else setOpen(true);
  }, [open, close]);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!open || event.key !== "Escape") return;
      // Kept from page-level Escape handlers (closing the issue peek).
      event.stopPropagation();
      close(true);
    },
    [open, close],
  );
  return { open, close, toggle, onKeyDown };
}

/**
 * The page's single You-should-know bubble (OL-187 §6, OL-194):
 * `✦ Tag · line`, with the issue identifier before the line on a summary.
 * Activating it opens the bubble into its card (OL-196) — the same floating
 * layer, grown in place; activating it again, or Escape, closes the card.
 */
export function TipBubble({
  tip,
  measure,
  level,
  issueIdentifier,
  settingsHref,
  suppressed,
  reducedMotion,
  takeFocus,
  onEngagedChange,
  onVisibleChange,
  onKnown,
  onDismiss,
  onDiscuss,
}: TipBubbleProps) {
  const { t } = useT("you-should-know");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const toggleId = useId();
  const cardId = useId();
  const card = useCardDisclosure(toggleRef);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  useReported(pointerInside || focusInside, onEngagedChange);
  const reportVisible = useCallback(
    (value: boolean) => onVisibleChange(tip.id, value),
    [tip.id, onVisibleChange],
  );
  // A focus hand-off comes with the bubble's first commit (TipBubbleHost).
  const [focusOnShow] = useState(takeFocus);

  return (
    <TipLayer
      data-ysk-bubble=""
      measure={measure}
      level={level}
      suppressed={suppressed}
      reducedMotion={reducedMotion}
      onVisibleChange={reportVisible}
      initialFocus={focusOnShow ? toggleRef : undefined}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusInside(false);
        }
      }}
      onKeyDown={card.onKeyDown}
    >
      <button
        ref={toggleRef}
        id={toggleId}
        type="button"
        aria-expanded={card.open}
        aria-controls={card.open ? cardId : undefined}
        onClick={card.toggle}
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
            tip.tag === "heads_up" && "text-warning",
          )}
        >
          {t(($) => $.tag[tip.tag])}
        </span>
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          ·
        </span>
        <span className="min-w-0">
          {issueIdentifier && (
            <span className="mr-1 text-muted-foreground">{issueIdentifier}</span>
          )}
          {tip.line}
        </span>
      </button>
      {card.open && (
        <TipCard
          id={cardId}
          labelledBy={toggleId}
          tip={tip}
          reducedMotion={reducedMotion}
          onKnown={onKnown}
          onDismiss={onDismiss}
          onDiscuss={() => {
            card.close(false);
            onDiscuss();
          }}
        />
      )}
      {settingsHref && (
        <AppLink
          href={settingsHref}
          className="w-fit rounded-sm text-micro text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(($) => $.bubble.settings_hint)}
        </AppLink>
      )}
    </TipLayer>
  );
}
