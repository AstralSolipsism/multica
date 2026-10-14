import type { IssueTip } from "@multica/core/you-should-know";
import type {
  RegisteredTipAnchor,
  TipAnchorRect,
  TipQueueEntry,
  TipRotation,
} from "@multica/core/you-should-know/anchors";
import type { FeedbackSession } from "./use-feedback-session";

/** Registry inputs stay separate so anchor cleanup survives until resync. */
export type TipLayerDisplay = { dotAnchorIds: readonly string[] } & (
  | { kind: "rotation"; anchorId: string | null; waitingAnchorId: null }
  | { kind: "feedback"; anchorId: string; waitingAnchorId: string | null }
);

interface TipLayerProjection {
  /** The rotation's tip whose visibility receipt drives display counting. */
  rotationTipId: string | null;
  /** A complete bubble candidate, including one waiting behind feedback. */
  handoffBubbleKey: string | null;
}

/** The single layer the host renders, together with its runtime inputs. */
export type TipLayerState = TipLayerProjection & (
  | {
      kind: "none";
      measure: (() => TipAnchorRect) | null;
      display: Extract<TipLayerDisplay, { kind: "rotation" }>;
    }
  | {
      kind: "bubble";
      tip: IssueTip;
      entry: TipQueueEntry;
      measure: () => TipAnchorRect;
      display: Extract<TipLayerDisplay, { kind: "rotation" }>;
    }
  | {
      kind: "feedback";
      session: FeedbackSession;
      measure: () => TipAnchorRect;
      display: Extract<TipLayerDisplay, { kind: "feedback" }>;
    }
);

/**
 * Feedback owns the screen until its session ends. Rotation can meanwhile
 * lag behind tip/anchor changes until the settled resync: keep its registry
 * slot and overlay measure even when it cannot yet render a bubble. Counting
 * and focus continue to track the rotation candidate, not the dismissed tip.
 */
export function deriveTipLayerState({
  rotation,
  tips,
  anchors,
  session,
}: {
  rotation: TipRotation;
  tips: readonly IssueTip[];
  anchors: Readonly<Record<string, RegisteredTipAnchor>>;
  session: FeedbackSession | null;
}): TipLayerState {
  const bubbleAnchorId = rotation.entry?.anchorId ?? null;
  const tip = tips.find((candidate) => candidate.id === rotation.tipId);
  const measure = bubbleAnchorId ? (anchors[bubbleAnchorId]?.measure ?? null) : null;
  const bubble = tip && rotation.entry && measure
    ? { kind: "bubble" as const, tip, entry: rotation.entry, measure }
    : null;
  const projection = {
    rotationTipId: tip?.id ?? null,
    handoffBubbleKey: bubble?.tip.id ?? null,
  };

  if (session) {
    return {
      ...projection,
      kind: "feedback",
      session,
      measure: session.measure,
      display: {
        kind: "feedback",
        anchorId: session.anchorId,
        waitingAnchorId: bubbleAnchorId,
        dotAnchorIds: rotation.dotAnchorIds,
      },
    };
  }
  return {
    ...projection,
    ...(bubble ?? { kind: "none", measure }),
    display: {
      kind: "rotation",
      anchorId: bubbleAnchorId,
      waitingAnchorId: null,
      dotAnchorIds: rotation.dotAnchorIds,
    },
  };
}
