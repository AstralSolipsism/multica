// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { IssueTip } from "@multica/core/you-should-know";
import {
  INITIAL_TIP_ROTATION,
  type RegisteredTipAnchor,
  type TipRotation,
} from "@multica/core/you-should-know/anchors";
import { deriveTipLayerState } from "./tip-layer-state";
import type { FeedbackSession } from "./use-feedback-session";

const tip: IssueTip = {
  id: "next",
  workspace_id: "ws",
  issue_id: "issue",
  issue_identifier: "OL-1",
  task_id: "task",
  agent_id: "agent",
  anchor_comment_id: null,
  tag: "you_should_know",
  line: "A tip",
  title: null,
  explanation: null,
  status: "valid",
  overturned_by_task_id: null,
  overturned_by_comment_id: null,
  overturned_reason: null,
  user_state: null,
  created_at: "2026-10-11T08:00:00Z",
  updated_at: "2026-10-11T08:00:00Z",
};

function fixture() {
  const measure = vi.fn(() => ({ top: 100, left: 20, width: 40, height: 20 }));
  const anchor: RegisteredTipAnchor = {
    id: "next-anchor",
    descriptor: { level: "summary", scope: { issue: "OL-1" } },
    visible: true,
    measure,
  };
  const rotation: TipRotation = {
    tipId: tip.id,
    seq: 2,
    shown: ["dismissed"],
    entry: {
      tipId: tip.id,
      anchorId: anchor.id,
      level: "summary",
      issueIdentifier: "OL-1",
      dwellMs: 8_000,
    },
    dotAnchorIds: Object.freeze(["other-anchor"]),
  };
  const session: FeedbackSession = {
    tip: { ...tip, id: "dismissed" },
    anchorId: "feedback-anchor",
    measure: vi.fn(() => ({ top: 300, left: 20, width: 40, height: 20 })),
    level: "row",
    expanded: true,
    takeFocus: true,
  };
  return {
    rotation,
    tips: [tip],
    anchors: { "next-anchor": anchor },
    session: null,
    feedbackSession: session,
  };
}

describe("deriveTipLayerState", () => {
  it("shows nothing until the rotation schedules a tip", () => {
    const state = deriveTipLayerState({ ...fixture(), rotation: INITIAL_TIP_ROTATION });
    expect(state).toEqual({
      kind: "none",
      measure: null,
      display: { kind: "rotation", anchorId: null, waitingAnchorId: null, dotAnchorIds: [] },
      rotationTipId: null,
      handoffBubbleKey: null,
    });
  });

  it("renders the scheduled tip with its exact placement and lazy measure", () => {
    const input = fixture();
    input.tips.unshift({ ...tip, id: "unscheduled" });
    const state = deriveTipLayerState(input);
    expect(state.kind).toBe("bubble");
    if (state.kind !== "bubble") throw new Error("expected a bubble");
    expect(state.tip).toBe(tip);
    expect(state.entry).toBe(input.rotation.entry);
    expect(state.measure).toBe(input.anchors["next-anchor"].measure);
    expect(state.measure).not.toHaveBeenCalled();
    expect(state.display).toEqual({ kind: "rotation", anchorId: "next-anchor", waitingAnchorId: null, dotAnchorIds: ["other-anchor"] });
    expect(state.display.dotAnchorIds).toBe(input.rotation.dotAnchorIds);
    expect(state.rotationTipId).toBe("next");
    expect(state.handoffBubbleKey).toBe("next");
  });

  it("keeps the scheduled slot and overlay measure while a removed tip awaits resync", () => {
    const input = fixture();
    const state = deriveTipLayerState({ ...input, tips: [] });
    expect(state).toEqual({
      kind: "none",
      measure: input.anchors["next-anchor"].measure,
      display: { kind: "rotation", anchorId: "next-anchor", waitingAnchorId: null, dotAnchorIds: ["other-anchor"] },
      rotationTipId: null,
      handoffBubbleKey: null,
    });
  });

  it("cannot render or hand off focus without a queue entry", () => {
    const input = fixture();
    const state = deriveTipLayerState({ ...input, rotation: { ...input.rotation, entry: null } });
    expect(state).toEqual({
      kind: "none",
      measure: null,
      display: { kind: "rotation", anchorId: null, waitingAnchorId: null, dotAnchorIds: ["other-anchor"] },
      rotationTipId: "next",
      handoffBubbleKey: null,
    });
  });

  it("cannot render or hand off focus after the scheduled anchor unregisters", () => {
    const state = deriveTipLayerState({ ...fixture(), anchors: {} });
    expect(state).toEqual({
      kind: "none",
      measure: null,
      display: { kind: "rotation", anchorId: "next-anchor", waitingAnchorId: null, dotAnchorIds: ["other-anchor"] },
      rotationTipId: "next",
      handoffBubbleKey: null,
    });
  });

  it("leaves visibility and scope changes to the settled rotation", () => {
    const input = fixture();
    input.anchors["next-anchor"].visible = false;
    input.anchors["next-anchor"].descriptor = { level: "row", issueId: "another-issue" };
    expect(deriveTipLayerState(input).kind).toBe("bubble");
  });

  it.each([
    [true, true, true],
    [false, true, true],
    [true, false, true],
    [true, true, false],
    [false, false, false],
  ])("keeps feedback in front (tip=%s, entry=%s, anchor=%s)", (hasTip, hasEntry, hasAnchor) => {
    const input = fixture();
    const session = input.feedbackSession;
    const state = deriveTipLayerState({
      ...input,
      session,
      tips: hasTip ? input.tips : [],
      rotation: hasEntry ? input.rotation : INITIAL_TIP_ROTATION,
      anchors: hasAnchor ? input.anchors : {},
    });
    expect(state.kind).toBe("feedback");
    if (state.kind !== "feedback") throw new Error("expected feedback");
    expect(state.session).toBe(session);
    expect(state.measure).toBe(session.measure);
    expect(state.measure).not.toHaveBeenCalled();
    expect(state.display.kind).toBe("feedback");
    expect(state.display.anchorId).toBe("feedback-anchor");
    expect(state.display.waitingAnchorId).toBe(hasEntry ? "next-anchor" : null);
    expect(state.display.dotAnchorIds).toBe(hasEntry ? input.rotation.dotAnchorIds : INITIAL_TIP_ROTATION.dotAnchorIds);
    expect(state.rotationTipId).toBe(hasTip && hasEntry ? "next" : null);
    expect(state.handoffBubbleKey).toBe(hasTip && hasEntry && hasAnchor ? "next" : null);
  });

  it("keeps registry effect inputs stable through unrelated anchor changes", () => {
    const input = fixture();
    const session = input.feedbackSession;
    const before = deriveTipLayerState({ ...input, session });
    const after = deriveTipLayerState({
      ...input,
      session,
      anchors: { ...input.anchors },
      tips: [...input.tips, { ...tip, id: "unscheduled" }],
    });
    expect(after.display).toEqual(before.display);
    expect(after.display.dotAnchorIds).toBe(before.display.dotAnchorIds);
  });

  it("uses the saved feedback measure until the session ends, then reveals the waiting bubble", () => {
    const input = fixture();
    const session = input.feedbackSession;
    // Its anchor is absent: the lifecycle hook, not projection, ends the row.
    const feedback = deriveTipLayerState({ ...input, session });
    expect(feedback.kind).toBe("feedback");
    expect(feedback.measure).toBe(session.measure);
    const bubble = deriveTipLayerState(input);
    expect(bubble.kind).toBe("bubble");
    expect(bubble.measure).toBe(input.anchors["next-anchor"].measure);
    expect(bubble.display).toEqual({ kind: "rotation", anchorId: "next-anchor", waitingAnchorId: null, dotAnchorIds: ["other-anchor"] });
  });
});
