"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  activeTipsOptions,
  isTipShownToMe,
  tipDisplayLedger,
  tipDisplayOrdinal,
  youShouldKnowKeys,
  type IssueTip,
  type IssueTipList,
} from "@multica/core/you-should-know";
import {
  INITIAL_TIP_ROTATION,
  measureTipAnchors,
  rotateTips,
  shouldShowSettingsHint,
  type TipAnchorDisplayState,
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
import { useFeedbackSession } from "./use-feedback-session";
import { useFocusHandoff } from "./use-focus-handoff";
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
function displayableTips(data: IssueTipList | undefined, failed: boolean): readonly IssueTip[] {
  return failed || !data ? NO_TIPS : data.tips.filter(isTipShownToMe);
}

function useDisplayableTips(wsId: string): readonly IssueTip[] {
  const { data, isError } = useQuery(activeTipsOptions(wsId));
  return useMemo(() => displayableTips(data, isError), [data, isError]);
}

/**
 * The same, read from the cache this instant — ahead of the render that will
 * carry it (an optimistic hide or its rollback lands there first).
 */
function readDisplayableTips(qc: QueryClient, wsId: string): readonly IssueTip[] {
  const state = qc.getQueryState<IssueTipList>(youShouldKnowKeys.active(wsId));
  return displayableTips(state?.data, state?.status === "error");
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
 * row takes the bubble's place until it ends (useFeedbackSession).
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
  const qc = useQueryClient();
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
  // Whether some tip will take the screen once the feedback row is gone,
  // judged on this instant's tips and anchors (the next re-schedule decides
  // which): a row that held keyboard focus hands it on only then.
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
  const successorWaits = useCallback(
    () =>
      rotateTips(rotationRef.current, {
        type: "sync",
        anchors: measureTipAnchors(registry.getState().anchors),
        tips: readDisplayableTips(qc, wsId),
      }).tipId !== null,
    [registry, qc, wsId],
  );

  const bubbleAnchorId = rotation.entry?.anchorId ?? null;
  const tip = tips.find((candidate) => candidate.id === rotation.tipId);
  const measure = bubbleAnchorId ? (anchors[bubbleAnchorId]?.measure ?? null) : null;

  // A row that held focus hands it to the bubble that replaces it. (Called
  // after render, once `handoff` below exists.)
  const feedback = useFeedbackSession(anchors, (hadFocus) => {
    if (hadFocus && successorWaits()) handoff.arm();
  });
  const { session } = feedback;
  const bubble = tip && rotation.entry && measure
    ? { tip, entry: rotation.entry, measure }
    : null;
  const handoff = useFocusHandoff(rotation, bubble?.tip.id ?? null);

  const rowAnchorId = session?.anchorId ?? null;
  useEffect(() => {
    registry
      .getState()
      .setDisplay(
        rowAnchorId === null
          ? { bubbleAnchorId, dotAnchorIds: rotation.dotAnchorIds }
          : feedbackRowDisplay(rowAnchorId, bubbleAnchorId, rotation.dotAnchorIds),
      );
  }, [registry, bubbleAnchorId, rotation.dotAnchorIds, rowAnchorId]);

  const [engaged, setEngaged] = useState(false);
  const typing = useEditableFocus();
  const pageHidden = useDocumentHidden();
  const reducedMotion = usePrefersReducedMotion();
  // Overlays are judged against whichever layer is up: the row or the bubble.
  const { modalOpen, anchorPopupOpen } = useOverlayState(session ? session.measure : measure);

  const suppressed = modalOpen || anchorPopupOpen;
  const paused = engaged || typing || pageHidden || suppressed || held;
  useDwellTimer(rotation.seq, rotation.entry?.dwellMs ?? null, paused, advance);

  const { showHint, reportVisible } = useSettingsHint(userId, tip?.id ?? null, pageHidden);

  // While the feedback row shows it is the page's only bubble.
  if (session) {
    return (
      <TipFeedbackRow
        key={session.tip.id}
        measure={session.measure}
        level={session.level}
        expanded={session.expanded}
        takeFocus={session.takeFocus}
        suppressed={suppressed}
        reducedMotion={reducedMotion}
        onPick={(option) => {
          actions.sendFeedback(session.tip.id, option);
          feedback.end(session.tip.id);
        }}
        onExpire={() => feedback.end(session.tip.id)}
      />
    );
  }
  if (!bubble) return null;
  const { entry } = bubble;

  return (
    <TipBubble
      // A new tip remounts the bubble, replaying its single fade-in.
      key={bubble.tip.id}
      tip={bubble.tip}
      measure={bubble.measure}
      level={entry.level}
      issueIdentifier={entry.issueIdentifier}
      settingsHref={showHint ? youShouldKnowSettingsHref(paths.settings()) : null}
      suppressed={suppressed}
      reducedMotion={reducedMotion}
      takeFocus={handoff.pending}
      onEngagedChange={setEngaged}
      onVisibleChange={reportVisible}
      onKnown={() => {
        // `advance` below puts the next tip up in this same commit.
        if (tipLayerHasFocus()) handoff.arm();
        actions.markKnown(bubble.tip.id);
        // Straight on to the next tip: no gap while the optimistic update
        // lands and the next re-schedule comes round.
        advance();
      }}
      onDismiss={(expanded) => {
        feedback.start({
          tip: bubble.tip,
          anchorId: entry.anchorId,
          measure: bubble.measure,
          level: entry.level,
          expanded,
          takeFocus: tipLayerHasFocus(),
        });
        void actions.dismiss(bubble.tip.id).then((saved) => {
          // The tip is back: no reason left to ask for.
          if (!saved) feedback.end(bubble.tip.id);
        });
      }}
    />
  );
}
