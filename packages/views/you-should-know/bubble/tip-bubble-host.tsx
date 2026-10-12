"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type IssueTip,
} from "@multica/core/you-should-know";
import {
  INITIAL_TIP_ROTATION,
  measureTipAnchors,
  rotateTips,
  shouldShowSettingsHint,
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
import { useDwellTimer } from "./use-dwell-timer";

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
 * The page's tip runtime (OL-194): reads the viewer's active tips, schedules
 * them over the registered anchors, rotates the single bubble, and writes
 * "bubble here, dots there" back into the registry for the anchors to render.
 *
 * Mounted by YouShouldKnowProvider only while the feature is on for this
 * viewer, as a sibling of the page — so the bubble it renders is never a
 * React descendant of any anchor.
 *
 * The rotation pauses — keeping the time left — while the pointer or focus
 * is on the bubble, the user is typing, the page is hidden, the bubble is
 * suppressed by an overlay, or something holds it (`held`).
 */
export function TipBubbleHost({
  registry,
  held,
}: {
  registry: TipAnchorRegistry;
  /** A useHoldTipRotation caller is active (OL-196's card, feedback row). */
  held: boolean;
}) {
  const wsId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const paths = useWorkspacePaths();

  // A failed read (a server without the endpoint answers 404) is simply "no
  // tips": the bubble is ambient, never an error surface. Realtime updates
  // arrive through useYouShouldKnowRealtimeSync, mounted app-wide.
  const { data } = useQuery(activeTipsOptions(wsId));
  const tips = useMemo(
    () => (data?.tips ?? NO_TIPS).filter(isTipShownToMe),
    [data],
  );
  const anchors = useStore(registry, (state) => state.anchors);
  const [rotation, dispatch] = useReducer(rotateTips, INITIAL_TIP_ROTATION);

  // Anchors mounted, scrolled into view, or changed scope; tips arrived or
  // were acted on: re-schedule once the burst settles (TIP_SYNC_SETTLE_MS).
  // Visible anchors are measured together, right before scheduling.
  const tipsRef = useRef(tips);
  tipsRef.current = tips;
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A pending sync reads the latest anchors and tips when it fires.
    if (syncTimerRef.current !== null) return;
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      dispatch({
        type: "sync",
        anchors: measureTipAnchors(registry.getState().anchors),
        tips: tipsRef.current,
      });
    }, TIP_SYNC_SETTLE_MS);
  }, [registry, anchors, tips]);
  useEffect(
    () => () => {
      if (syncTimerRef.current !== null) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    },
    [],
  );

  const advance = useCallback(() => {
    dispatch({
      type: "advance",
      anchors: measureTipAnchors(registry.getState().anchors),
      tips: tipsRef.current,
    });
  }, [registry]);

  const bubbleAnchorId = rotation.entry?.anchorId ?? null;
  useEffect(() => {
    registry
      .getState()
      .setDisplay({ bubbleAnchorId, dotAnchorIds: rotation.dotAnchorIds });
  }, [registry, bubbleAnchorId, rotation.dotAnchorIds]);

  const tip = tips.find((candidate) => candidate.id === rotation.tipId);
  const measure = bubbleAnchorId ? (anchors[bubbleAnchorId]?.measure ?? null) : null;

  const [engaged, setEngaged] = useState(false);
  const typing = useEditableFocus();
  const pageHidden = useDocumentHidden();
  const reducedMotion = usePrefersReducedMotion();
  const { modalOpen, anchorPopupOpen } = useOverlayState(measure);

  const suppressed = modalOpen || anchorPopupOpen;
  const paused = engaged || typing || pageHidden || suppressed || held;
  useDwellTimer(rotation.seq, rotation.entry?.dwellMs ?? null, paused, advance);

  // "You can turn this off in personal settings" rides on the 1st–3rd and
  // every 10th distinct tip this user has seen. A layout effect so the line
  // is there on the bubble's first paint; the ledger is idempotent per tip,
  // so re-running (StrictMode, remounts) never counts twice.
  const [hint, setHint] = useState<{ tipId: string; show: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!rotation.tipId || !userId) return;
    const ordinal = tipDisplayLedger.getState().recordDisplay(userId, rotation.tipId);
    setHint({ tipId: rotation.tipId, show: shouldShowSettingsHint(ordinal) });
  }, [rotation.tipId, userId]);
  const showHint = hint !== null && hint.tipId === rotation.tipId && hint.show;

  if (!tip || !rotation.entry || !measure) return null;

  return (
    <TipBubble
      // A new tip remounts the bubble, replaying its single fade-in.
      key={tip.id}
      measure={measure}
      level={rotation.entry.level}
      tag={tip.tag}
      line={tip.line}
      issueIdentifier={rotation.entry.issueIdentifier}
      settingsHref={showHint ? youShouldKnowSettingsHref(paths.settings()) : null}
      suppressed={suppressed}
      reducedMotion={reducedMotion}
      onEngagedChange={setEngaged}
    />
  );
}
