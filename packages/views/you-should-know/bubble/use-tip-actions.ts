"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  useSetTipState,
  type IssueTip,
  type TipFeedback,
} from "@multica/core/you-should-know";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import {
  issueCommentDraftKey,
  isTipIssuePath,
  tipDiscussionQuote,
} from "./tip-discussion";

export interface TipActions {
  /** "I already know" / "Got it": the tip leaves, everywhere, for good. */
  markKnown: (tipId: string) => void;
  /** "Dismiss"; resolves whether the server took it. */
  dismiss: (tipId: string) => Promise<boolean>;
  /** A pick on the feedback row: the dismissal again, now with its reason. */
  sendFeedback: (tipId: string, feedback: TipFeedback) => void;
  /**
   * "Discuss in comments": quote the tip into the issue's comment draft and
   * take the user to that comment box. `detailOnScreen` says the issue's
   * detail — and with it the comment box — is already open on this page.
   * Leaves the tip's state alone and never sends anything.
   */
  discuss: (tip: IssueTip, detailOnScreen: boolean) => void;
}

/**
 * The card's and the feedback row's actions (OL-187 §6, OL-196). State
 * writes go through useSetTipState, which hides the tip at once and rolls it
 * back if the server refuses; a refusal is also reported as a toast.
 */
export function useTipActions(): TipActions {
  const { t } = useT("you-should-know");
  const { mutateAsync } = useSetTipState();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();

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

  const discuss = useCallback(
    (tip: IssueTip, detailOnScreen: boolean) => {
      const quote = tipDiscussionQuote(t(($) => $.tag[tip.tag]), tip.line, tip.explanation);
      // Lands after any draft already there. A composer on screen picks the
      // write up by itself — it opens its editor on the draft, focuses it and
      // scrolls it into view — and one mounted later opens straight into the
      // editable draft.
      useCommentDraftStore
        .getState()
        .appendToDraftContent(issueCommentDraftKey(tip.issue_id), quote);
      if (detailOnScreen || isTipIssuePath(navigation.pathname, tip, paths.issueDetail)) {
        return;
      }
      navigation.push(paths.issueDetail(tip.issue_identifier || tip.issue_id));
    },
    [t, navigation, paths],
  );

  return useMemo(
    () => ({
      markKnown: (tipId) => void save(tipId, "known", null),
      dismiss: (tipId) => save(tipId, "dismissed", null),
      sendFeedback: (tipId, feedback) => void save(tipId, "dismissed", feedback),
      discuss,
    }),
    [save, discuss],
  );
}
