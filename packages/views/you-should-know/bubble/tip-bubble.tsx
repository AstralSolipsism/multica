"use client";

import { useCallback, useState } from "react";
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
import { BYSTANDER_MARKER } from "./bystander-marker";
import { TipLayer, useReported } from "./tip-layer";

export interface TipBubbleProps {
  /** The tip on display; visibility receipts name it. */
  tipId: string;
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
  /**
   * Visibility receipt for this bubble's tip: positioned, not clipped and not
   * suppressed means the user can see it.
   */
  onVisibleChange: (tipId: string, visible: boolean) => void;
  /** Activating the bubble opens the tip's card (OL-196); until then a no-op. */
  onActivate?: () => void;
}

/**
 * The page's single You-should-know bubble (OL-187 §6, OL-194):
 * `✦ Tag · line`, with the issue identifier before the line on a summary.
 * Floats beside its anchor in a TipLayer.
 */
export function TipBubble({
  tipId,
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
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  useReported(pointerInside || focusInside, onEngagedChange);
  const reportVisible = useCallback(
    (value: boolean) => onVisibleChange(tipId, value),
    [tipId, onVisibleChange],
  );

  return (
    <TipLayer
      data-ysk-bubble=""
      measure={measure}
      level={level}
      suppressed={suppressed}
      reducedMotion={reducedMotion}
      onVisibleChange={reportVisible}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusInside(false);
        }
      }}
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
    </TipLayer>
  );
}
