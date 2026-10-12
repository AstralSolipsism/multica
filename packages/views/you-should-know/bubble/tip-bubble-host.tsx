"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  activeTipsOptions,
  isTipShownToMe,
  tipDisplayLedger,
  tipDisplayOrdinal,
  type IssueTip,
} from "@multica/core/you-should-know";
import {
  INITIAL_TIP_ROTATION,
  measureTipAnchors,
  rotateTips,
  shouldShowSettingsHint,
  type RegisteredTipAnchor,
  type TipAnchorDisplayState,
  type TipAnchorLevel,
  type TipAnchorRegistry,
} from "@multica/core/you-should-know/anchors";
import { youShouldKnowSettingsHref } from "../settings-anchor";
import {
  useDocumentHidden,
  useEditableFocus,
  useOverlayState,
  usePrefersReducedMotion,
} from "./page-signals";
import { TipBubble } from "./tip-bubble";
import { TipFeedbackRow } from "./tip-feedback-row";
import { tipLayerHasFocus } from "./tip-layer";
import { useDwellTimer } from "./use-dwell-timer";
import { useTipActions } from "./use-tip-actions";

const NO_TIPS: IssueTip[] = [];

/**
 * Anchors change in bursts: a view switch unmounts every anchor before the new
 * ones report visible, and each IntersectionObserver reports on its own. A
 * change schedules one re-schedule this long after it, reading whatever the
 * page has settled into by then — so the rotation never acts on a
 * half-mounted page (a tip whose row is merely re-mounting keeps its turn,
 * and no tip is shown, or counted, for a single frame).
 */
export const TIP_SYNC_SETTLE_MS = 120;

/**
 * The viewer's displayable tips: valid, and not yet known or dismissed by
 * them. Any failed read is "no tips" — the first load (a server without the
 * endpoint answers 404) and equally a refetch that fails after tips were
 * cached: TanStack Query keeps the last data on a refetch error, but the
 * bubble must not keep rotating tips the server no longer vouches for. The
 * bubble is ambient, never an error surface. Realtime updates arrive through
 * useYouShouldKnowRealtimeSync, mounted app-wide.
 */
function useDisplayableTips(wsId: string): readonly IssueTip[] {
  const { data, isError } = useQuery(activeTipsOptions(wsId));
  return useMemo(
    () => (isError || !data ? NO_TIPS : data.tips.filter(isTipShownToMe)),
    [data, isError],
  );
}

/**
 * Calls `resync` once per burst of anchor/tip changes, TIP_SYNC_SETTLE_MS
 * after the burst starts (a throttle, not a debounce: continuous changes —
 * scrolling a long list — still re-schedule every window).
 */
function useSettledResync(resync: () => void, anchors: unknown, tips: unknown): void {
  const resyncRef = useRef(resync);
  resyncRef.current = resync;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A pending resync reads the latest anchors and tips when it fires.
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      resyncRef.current();
    }, TIP_SYNC_SETTLE_MS);
  }, [anchors, tips]);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );
}

/**
 * Folds one bubble's visibility receipt into "which tip is on screen". A
 * receipt names the tip whose bubble sent it: `true` claims the screen for
 * that tip, `false` releases it only if that same tip still holds it — so a
 * late `false` from a bubble that already left never clears the receipt of
 * the bubble that replaced it.
 */
export function acknowledgeVisibility(
  current: string | null,
  tipId: string,
  visible: boolean,
): string | null {
  if (visible) return tipId;
  return current === tipId ? null : current;
}

/**
 * Counts a tip as displayed once the user can actually see it, and returns
 * whether its bubble carries the "you can turn this off in personal
 * settings" line (1st–3rd and every 10th distinct tip, OL-187 §6).
 *
 * "Can see it" comes from the bubble's own receipt — positioned, not clipped,
 * not covered — and it must be the receipt of `tipId` itself, with the page
 * in view. A bare "the bubble is visible" flag would let a direct rotation
 * A → B count B on A's leftover receipt before B's bubble has even placed.
 * The line is laid out from the ordinal the tip would get, so it is there on
 * the first visible frame; recording assigns exactly that ordinal,
 * idempotently per tip — opening the bubble into its card is not another
 * display.
 */
function useSettingsHint(
  userId: string | null,
  tipId: string | null,
  pageHidden: boolean,
): { showHint: boolean; reportVisible: (tipId: string, visible: boolean) => void } {
  const [visibleTipId, setVisibleTipId] = useState<string | null>(null);
  const reportVisible = useCallback((reportedTipId: string, visible: boolean) => {
    setVisibleTipId((current) => acknowledgeVisibility(current, reportedTipId, visible));
  }, []);
  const onScreen = tipId !== null && visibleTipId === tipId && !pageHidden;
  const history = useStore(tipDisplayLedger, (state) =>
    userId ? state.users[userId] : undefined,
  );
  useEffect(() => {
    if (!userId || !tipId || !onScreen) return;
    tipDisplayLedger.getState().recordDisplay(userId, tipId);
  }, [userId, tipId, onScreen]);
  const showHint =
    userId !== null && tipId !== null &&
    shouldShowSettingsHint(tipDisplayOrdinal(history, tipId));
  return { showHint, reportVisible };
}

/** The feedback row standing where a dismissed tip's bubble was. */
interface PendingFeedback {
  tipId: string;
  /** The anchor the dismissed tip's bubble rode; the row stays there. */
  anchorId: string;
  level: TipAnchorLevel;
  /** Dismissed after "Learn more" — the narrower set of reasons. */
  expanded: boolean;
  /** Focus was in the card: the row takes it over. */
  takeFocus: boolean;
}

/**
 * The pending feedback row and the live rect of its anchor. A row whose
 * anchor went away (the page changed, the agent stopped) has nothing to
 * stand beside: it is dropped, releasing the rotation.
 */
function usePendingFeedback(anchors: Readonly<Record<string, RegisteredTipAnchor>>) {
  const [feedback, setFeedback] = useState<PendingFeedback | null>(null);
  const measure = feedback ? (anchors[feedback.anchorId]?.measure ?? null) : null;
  useEffect(() => {
    if (feedback && !measure) setFeedback(null);
  }, [feedback, measure]);
  return { feedback, measure, setFeedback };
}

/**
 * A flag that stays up for exactly one commit: raised by an action that
 * removes the tip layer holding keyboard focus, it lets the bubble mounted
 * by that same commit take focus over — and nothing mounted later.
 */
function useFocusPulse(): [boolean, (raise: boolean) => void] {
  const [pulse, setPulse] = useState(false);
  // A bubble mounted in the pulse's commit read it on its first render.
  useEffect(() => {
    if (pulse) setPulse(false);
  }, [pulse]);
  return [pulse, setPulse];
}

/**
 * Registry display while the feedback row stands in for the bubble: the row's
 * anchor holds the bubble slot, and the tip waiting behind the row gets a dot
 * on its own anchor like any other tip that is not on screen.
 */
export function feedbackRowDisplay(
  rowAnchorId: string,
  waitingAnchorId: string | null,
  dotAnchorIds: readonly string[],
): TipAnchorDisplayState {
  const dots = waitingAnchorId === null ? dotAnchorIds : [...dotAnchorIds, waitingAnchorId];
  return {
    bubbleAnchorId: rowAnchorId,
    dotAnchorIds: dots.filter((id) => id !== rowAnchorId),
  };
}

/**
 * The page's tip runtime (OL-194, OL-196): reads the viewer's active tips,
 * schedules them over the registered anchors, rotates the single bubble,
 * writes "bubble here, dots there" back into the registry for the anchors to
 * render, and carries out the card's actions. After "Dismiss" the feedback
 * row takes the bubble's place until it is answered or times out.
 *
 * Mounted by YouShouldKnowProvider only while the feature is on for this
 * viewer, as a sibling of the page — so the layers it renders are never
 * React descendants of any anchor.
 *
 * The rotation pauses — keeping the time left — while the pointer or focus
 * is on the bubble, the user is typing, the page is hidden, the layer is
 * suppressed by an overlay, or something holds it (`held`: an open card, the
 * feedback row).
 */
export function TipBubbleHost({
  registry,
  held,
}: {
  registry: TipAnchorRegistry;
  /** A useHoldTipRotation caller is active (the open card, the feedback row). */
  held: boolean;
}) {
  const wsId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const paths = useWorkspacePaths();
  const tips = useDisplayableTips(wsId);
  const anchors = useStore(registry, (state) => state.anchors);
  const [rotation, dispatch] = useReducer(rotateTips, INITIAL_TIP_ROTATION);
  const actions = useTipActions();

  // Visible anchors are measured together, right before scheduling; both the
  // settled resync and the dwell-end advance read the latest tips.
  const tipsRef = useRef(tips);
  tipsRef.current = tips;
  const reschedule = useCallback(
    (type: "sync" | "advance") =>
      dispatch({
        type,
        anchors: measureTipAnchors(registry.getState().anchors),
        tips: tipsRef.current,
      }),
    [registry],
  );
  // Anchors mounted, scrolled into view, or changed scope; tips arrived, were
  // acted on, or the read failed: re-schedule once the burst settles.
  useSettledResync(() => reschedule("sync"), anchors, tips);
  const advance = useCallback(() => reschedule("advance"), [reschedule]);

  const { feedback, measure: feedbackMeasure, setFeedback } = usePendingFeedback(anchors);
  const [focusPulse, raiseFocusPulse] = useFocusPulse();

  const bubbleAnchorId = rotation.entry?.anchorId ?? null;
  const feedbackAnchorId = feedback?.anchorId ?? null;
  useEffect(() => {
    registry
      .getState()
      .setDisplay(
        feedbackAnchorId === null
          ? { bubbleAnchorId, dotAnchorIds: rotation.dotAnchorIds }
          : feedbackRowDisplay(feedbackAnchorId, bubbleAnchorId, rotation.dotAnchorIds),
      );
  }, [registry, bubbleAnchorId, rotation.dotAnchorIds, feedbackAnchorId]);

  const tip = tips.find((candidate) => candidate.id === rotation.tipId);
  const measure = bubbleAnchorId ? (anchors[bubbleAnchorId]?.measure ?? null) : null;

  const [engaged, setEngaged] = useState(false);
  const typing = useEditableFocus();
  const pageHidden = useDocumentHidden();
  const reducedMotion = usePrefersReducedMotion();
  // Overlays are judged against whichever layer is up: the row or the bubble.
  const { modalOpen, anchorPopupOpen } = useOverlayState(feedback ? feedbackMeasure : measure);

  const suppressed = modalOpen || anchorPopupOpen;
  const paused = engaged || typing || pageHidden || suppressed || held;
  useDwellTimer(rotation.seq, rotation.entry?.dwellMs ?? null, paused, advance);

  const { showHint, reportVisible } = useSettingsHint(userId, tip?.id ?? null, pageHidden);

  // While the feedback row shows it is the page's only bubble.
  if (feedback) {
    if (!feedbackMeasure) return null;
    return (
      <TipFeedbackRow
        key={feedback.tipId}
        measure={feedbackMeasure}
        level={feedback.level}
        expanded={feedback.expanded}
        takeFocus={feedback.takeFocus}
        suppressed={suppressed}
        reducedMotion={reducedMotion}
        onPick={(option) => {
          raiseFocusPulse(tipLayerHasFocus());
          actions.sendFeedback(feedback.tipId, option);
          setFeedback(null);
        }}
        onExpire={() => {
          raiseFocusPulse(tipLayerHasFocus());
          setFeedback(null);
        }}
      />
    );
  }

  if (!tip || !rotation.entry || !measure) return null;
  const entry = rotation.entry;

  return (
    <TipBubble
      // A new tip remounts the bubble, replaying its single fade-in.
      key={tip.id}
      tip={tip}
      measure={measure}
      level={entry.level}
      issueIdentifier={entry.issueIdentifier}
      settingsHref={showHint ? youShouldKnowSettingsHref(paths.settings()) : null}
      suppressed={suppressed}
      reducedMotion={reducedMotion}
      takeFocus={focusPulse}
      onEngagedChange={setEngaged}
      onVisibleChange={reportVisible}
      onKnown={() => {
        raiseFocusPulse(tipLayerHasFocus());
        actions.markKnown(tip.id);
        // Straight on to the next tip, in this same commit: no gap while the
        // optimistic update lands, and the next bubble can take focus over.
        advance();
      }}
      onDismiss={(expanded) => {
        setFeedback({
          tipId: tip.id,
          anchorId: entry.anchorId,
          level: entry.level,
          expanded,
          takeFocus: tipLayerHasFocus(),
        });
        void actions.dismiss(tip.id).then((saved) => {
          // The tip is back: no reason left to ask for.
          if (!saved) setFeedback((current) => (current?.tipId === tip.id ? null : current));
        });
      }}
      onDiscuss={() => actions.discuss(tip, entry.level === "detail_header")}
    />
  );
}
