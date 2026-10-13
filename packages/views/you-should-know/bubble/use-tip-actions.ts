"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useSetTipState, type TipFeedback } from "@multica/core/you-should-know";
import { useT } from "../../i18n";

export interface TipActions {
  /** "I already know" / "Got it": the tip leaves, everywhere, for good. */
  markKnown: (tipId: string) => void;
  /** "Dismiss"; resolves whether the server took it. */
  dismiss: (tipId: string) => Promise<boolean>;
  /** A pick on the feedback row: the dismissal again, now with its reason. */
  sendFeedback: (tipId: string, feedback: TipFeedback) => void;
}

/**
 * The card's and the feedback row's actions (OL-187 §6, OL-196). State
 * writes go through useSetTipState, which hides the tip at once and rolls it
 * back if the server refuses; a refusal is also reported as a toast.
 */
export function useTipActions(): TipActions {
  const { t } = useT("you-should-know");
  const { mutateAsync } = useSetTipState();

  // mutateAsync rather than mutate: per-call `mutate` callbacks only fire for
  // the hook's latest call, and "Dismiss" then a feedback pick are two calls
  // in a row — each failure must still reach the user.
  const save = useCallback(
    (tipId: string, state: "known" | "dismissed", feedback: TipFeedback | null) =>
      mutateAsync({ tipId, request: { state, feedback } }).then(
        () => true,
        () => {
          toast.error(t(($) => $.errors.state_failed));
          return false;
        },
      ),
    [mutateAsync, t],
  );

  return useMemo(
    () => ({
      markKnown: (tipId) => void save(tipId, "known", null),
      dismiss: (tipId) => save(tipId, "dismissed", null),
      sendFeedback: (tipId, feedback) => void save(tipId, "dismissed", feedback),
    }),
    [save],
  );
}
