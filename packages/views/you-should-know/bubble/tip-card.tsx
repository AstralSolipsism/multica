"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { IssueTip } from "@multica/core/you-should-know";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

/**
 * A click handler that ignores the second click of a double-click. The tip
 * layer swaps buttons under the pointer — "Learn more" gives way to "Got it",
 * "Dismiss" to the feedback row — so one double-click would otherwise take
 * two decisions, e.g. open the explanation and mark the tip known.
 * Keyboard activation (`detail` 0) is unaffected.
 */
export function singleClick(action: () => void) {
  return (event: MouseEvent) => {
    if (event.detail > 1) return;
    action();
  };
}

export function TipLayerButton({
  ref,
  reducedMotion,
  onActivate,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  reducedMotion: boolean;
  onActivate: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="xs"
      // Reduced motion: no transitions at all, not even the colour fade.
      className={cn(reducedMotion && "transition-none")}
      onClick={singleClick(onActivate)}
    >
      {children}
    </Button>
  );
}

export interface TipCardProps {
  id: string;
  /** The bubble line that toggles the card; it names the card. */
  labelledBy: string;
  tip: Pick<IssueTip, "title" | "explanation">;
  reducedMotion: boolean;
  onKnown: () => void;
  /** `expanded`: dismissed after "Learn more" (it narrows the feedback). */
  onDismiss: (expanded: boolean) => void;
  onDiscuss: () => void;
}

/**
 * The card the bubble opens into (OL-187 §6, OL-196), with the original's
 * buttons: Learn more / I already know / Dismiss, and once "Learn more" has
 * shown the title and explanation, Got it / Discuss in comments / Dismiss.
 *
 * Mounted only while the card is open, so it always opens on the first set.
 * Focus moves in when it opens — onto its first button — and onto the
 * explanation when "Learn more" reveals it (or onto "Got it" when the tip
 * has nothing to reveal), so a keyboard user never drops out of the card.
 */
export function TipCard({
  id,
  labelledBy,
  tip,
  reducedMotion,
  onKnown,
  onDismiss,
  onDiscuss,
}: TipCardProps) {
  const { t } = useT("you-should-know");
  const [expanded, setExpanded] = useState(false);
  const entryRef = useRef<HTMLElement | null>(null);
  const setEntry = useCallback((element: HTMLElement | null) => {
    entryRef.current = element;
  }, []);
  useEffect(() => {
    entryRef.current?.focus({ preventScroll: true });
  }, [expanded]);

  const details = expanded && (tip.title !== null || tip.explanation !== null);

  return (
    <div id={id} role="group" aria-labelledby={labelledBy} className="flex flex-col gap-1 pt-1">
      {details && (
        // A focus target, not a control: it lets "Learn more" land the
        // reader on what it revealed.
        <div ref={setEntry} tabIndex={-1} className="flex flex-col gap-0.5 text-caption outline-none">
          {tip.title && <p className="font-medium">{tip.title}</p>}
          {tip.explanation && (
            <p className="whitespace-pre-line text-muted-foreground">{tip.explanation}</p>
          )}
        </div>
      )}
      <div className="-mx-1.5 flex flex-wrap items-center gap-0.5">
        {expanded ? (
          <>
            <TipLayerButton
              ref={details ? undefined : setEntry}
              reducedMotion={reducedMotion}
              onActivate={onKnown}
            >
              {t(($) => $.card.got_it)}
            </TipLayerButton>
            <TipLayerButton reducedMotion={reducedMotion} onActivate={onDiscuss}>
              {t(($) => $.card.discuss)}
            </TipLayerButton>
          </>
        ) : (
          <>
            <TipLayerButton
              ref={setEntry}
              reducedMotion={reducedMotion}
              onActivate={() => setExpanded(true)}
            >
              {t(($) => $.card.learn_more)}
            </TipLayerButton>
            <TipLayerButton reducedMotion={reducedMotion} onActivate={onKnown}>
              {t(($) => $.card.already_know)}
            </TipLayerButton>
          </>
        )}
        <TipLayerButton reducedMotion={reducedMotion} onActivate={() => onDismiss(expanded)}>
          {t(($) => $.card.dismiss)}
        </TipLayerButton>
      </div>
    </div>
  );
}
