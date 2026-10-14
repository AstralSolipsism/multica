"use client";

import { useEffect, useRef } from "react";
import type { TipFeedback } from "@multica/core/you-should-know";
import type {
  TipAnchorLevel,
  TipAnchorRect,
} from "@multica/core/you-should-know/anchors";
import { useT } from "../../i18n";
import { BYSTANDER_MARKER } from "./bystander-marker";
import { TipLayerButton } from "./tip-card";
import { TipLayer } from "./tip-layer";
import { useHoldTipRotation } from "./tip-rotation-hold";

/** Without a pick, the feedback row leaves on its own after this long. */
export const TIP_FEEDBACK_TIMEOUT_MS = 20_000;

/** Reasons offered for a tip dismissed from the collapsed card. */
const BRIEF_OPTIONS: readonly TipFeedback[] = ["helpful", "not_relevant", "not_understood"];
/** Reasons offered for a tip dismissed after "Learn more". */
const EXPANDED_OPTIONS: readonly TipFeedback[] = ["helpful", "not_understood"];

export interface TipFeedbackRowProps {
  /** Live rect of the anchor the dismissed tip's bubble rode. */
  measure: () => TipAnchorRect;
  level: TipAnchorLevel;
  /** The tip was dismissed from the expanded card. */
  expanded: boolean;
  /** Focus was in the card when it was dismissed: keep it in the tip layer. */
  takeFocus: boolean;
  suppressed: boolean;
  reducedMotion: boolean;
  onPick: (feedback: TipFeedback) => void;
  onExpire: () => void;
}

/**
 * The one-line feedback left where a dismissed tip was (OL-187 §6, OL-196):
 * Helpful / Not relevant / Didn't understand, or Helpful / Didn't understand
 * when the tip was dismissed after "Learn more". It leaves on a pick or after
 * TIP_FEEDBACK_TIMEOUT_MS. While it shows it is the page's only bubble and
 * holds the rotation, so the next tip waits rather than ticking away unseen.
 */
export function TipFeedbackRow({
  measure,
  level,
  expanded,
  takeFocus,
  suppressed,
  reducedMotion,
  onPick,
  onExpire,
}: TipFeedbackRowProps) {
  const { t } = useT("you-should-know");
  useHoldTipRotation(true);

  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  useEffect(() => {
    const timer = setTimeout(() => onExpireRef.current(), TIP_FEEDBACK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  const firstRef = useRef<HTMLButtonElement>(null);
  const options = expanded ? EXPANDED_OPTIONS : BRIEF_OPTIONS;
  return (
    <TipLayer
      data-ysk-feedback=""
      measure={measure}
      level={level}
      suppressed={suppressed}
      reducedMotion={reducedMotion}
      initialFocus={takeFocus ? firstRef : undefined}
    >
      <div
        role="group"
        aria-label={t(($) => $.feedback.label)}
        className="-ml-1 flex flex-wrap items-center gap-0.5"
      >
        <span className="px-1 text-caption text-brand" aria-hidden="true">
          {BYSTANDER_MARKER}
        </span>
        {options.map((option, index) => (
          <TipLayerButton
            key={option}
            ref={index === 0 ? firstRef : undefined}
            reducedMotion={reducedMotion}
            onActivate={() => onPick(option)}
          >
            {t(($) => $.feedback[option])}
          </TipLayerButton>
        ))}
      </div>
    </TipLayer>
  );
}
