// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_TIP_ROTATION,
  measureTipAnchors,
  rotateTips,
  type TipRotation,
} from "./rotation";
import type {
  RegisteredTipAnchor,
  SchedulableTip,
  TipAnchorDescriptor,
  TipScheduleAnchor,
} from "./types";

function anchor(
  id: string,
  descriptor: TipAnchorDescriptor,
  overrides: Partial<TipScheduleAnchor> = {},
): TipScheduleAnchor {
  return { id, descriptor, visible: true, top: 0, ...overrides };
}

function tip(id: string, overrides: Partial<SchedulableTip> = {}): SchedulableTip {
  return {
    id,
    issue_id: "issue-1",
    tag: "you_should_know",
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const ROW_1 = anchor("row-1", { level: "row", issueId: "issue-1" }, { top: 100 });
const ROW_2 = anchor("row-2", { level: "row", issueId: "issue-2" }, { top: 200 });
const SUMMARY = anchor(
  "summary",
  { level: "summary", scope: { "issue-1": "OL-1", "issue-2": "OL-2" } },
  { top: 10 },
);

// Three tips: one per issue-1 creation time, plus a heads-up on issue-2.
const A = tip("a", { created_at: "2026-10-01T00:00:01Z" });
const B = tip("b", { created_at: "2026-10-01T00:00:02Z" });
const H = tip("h", { issue_id: "issue-2", tag: "heads_up" });

function run(
  events: { type: "sync" | "advance"; anchors?: TipScheduleAnchor[]; tips?: SchedulableTip[] }[],
  initial: TipRotation = INITIAL_TIP_ROTATION,
): TipRotation[] {
  const states: TipRotation[] = [];
  let state = initial;
  for (const event of events) {
    state = rotateTips(state, {
      type: event.type,
      anchors: event.anchors ?? [ROW_1, ROW_2, SUMMARY],
      tips: event.tips ?? [A, B, H],
    });
    states.push(state);
  }
  return states;
}

describe("rotateTips — cycle", () => {
  it("starts with the queue head: heads-up first, on its primary anchor", () => {
    const [first] = run([{ type: "sync" }]);
    expect(first).toMatchObject({
      tipId: "h",
      seq: 1,
      shown: [],
      entry: { tipId: "h", anchorId: "row-2", level: "row", dwellMs: 15_000 },
    });
  });

  it("walks the queue once per cycle, then starts over without repeating the last tip", () => {
    const states = run([
      { type: "sync" },
      { type: "advance" },
      { type: "advance" },
      { type: "advance" },
      { type: "advance" },
    ]);
    expect(states.map((s) => s.tipId)).toEqual(["h", "a", "b", "h", "a"]);
    expect(states.map((s) => s.entry?.dwellMs)).toEqual([
      15_000, 8_000, 8_000, 15_000, 8_000,
    ]);
    // The cycle's memory resets when it wraps around.
    expect(states[2]!.shown).toEqual(["h", "a"]);
    expect(states[3]!.shown).toEqual([]);
  });

  it("bumps seq on every display, including a lone tip starting another dwell", () => {
    const states = run([
      { type: "sync", tips: [A] },
      { type: "advance", tips: [A] },
      { type: "advance", tips: [A] },
    ]);
    expect(states.map((s) => s.tipId)).toEqual(["a", "a", "a"]);
    expect(states.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it("lets a heads-up that arrives mid-cycle go next", () => {
    const states = run([
      { type: "sync", tips: [A, B] },
      { type: "sync", tips: [A, B, H] },
      { type: "advance" },
    ]);
    expect(states.map((s) => s.tipId)).toEqual(["a", "a", "h"]);
  });

  it("shows nothing when no tip has a visible anchor", () => {
    const [state] = run([
      { type: "sync", anchors: [{ ...ROW_1, visible: false }], tips: [A] },
    ]);
    expect(state).toMatchObject({ tipId: null, entry: null, dotAnchorIds: [] });
  });
});

describe("rotateTips — re-scheduling never interrupts", () => {
  it("keeps the current tip and its remaining dwell (same seq) on a sync", () => {
    const [first, second] = run([
      { type: "sync" },
      // A new issue's row mounts; the heads-up still shows, timer untouched.
      {
        type: "sync",
        anchors: [ROW_1, ROW_2, SUMMARY, anchor("row-3", { level: "row", issueId: "issue-3" })],
      },
    ]);
    expect(second!.tipId).toBe(first!.tipId);
    expect(second!.seq).toBe(first!.seq);
  });

  it("re-pins the current tip onto a more specific anchor that appears", () => {
    const states = run([
      // Only the summary is visible: the tip shows there with its identifier.
      { type: "sync", anchors: [SUMMARY], tips: [A] },
      // Its row scrolls into view: same tip, same dwell, now on the row.
      { type: "sync", anchors: [SUMMARY, ROW_1], tips: [A] },
    ]);
    expect(states[0]!.entry).toMatchObject({ anchorId: "summary", issueIdentifier: "OL-1" });
    expect(states[1]!.entry).toMatchObject({ anchorId: "row-1", issueIdentifier: null });
    expect(states[1]!.seq).toBe(states[0]!.seq);
  });

  it("moves on when the current tip stops being displayable", () => {
    const states = run([
      { type: "sync" },
      // The heads-up was dismissed in another tab.
      { type: "sync", tips: [A, B] },
    ]);
    expect(states[1]).toMatchObject({ tipId: "a", seq: 2 });
  });

  it("returns the same state object when nothing observable changed", () => {
    const [first] = run([{ type: "sync" }]);
    const again = rotateTips(first!, {
      type: "sync",
      anchors: [ROW_1, ROW_2, SUMMARY],
      tips: [A, B, H],
    });
    expect(again).toBe(first);
  });
});

describe("rotateTips — dots", () => {
  it("lights every candidate except the anchor hosting the bubble", () => {
    const [state] = run([{ type: "sync", anchors: [SUMMARY, ROW_1], tips: [A] }]);
    expect(state!.entry!.anchorId).toBe("row-1");
    expect(state!.dotAnchorIds).toEqual(["summary"]);
  });
});

describe("measureTipAnchors", () => {
  function registered(id: string, visible: boolean, top: number): RegisteredTipAnchor {
    return {
      id,
      descriptor: { level: "row", issueId: id },
      visible,
      measure: vi.fn(() => ({ top, left: 0, width: 10, height: 10 })),
    };
  }

  it("measures each visible anchor once and skips invisible ones", () => {
    const shown = registered("shown", true, 240);
    const offscreen = registered("offscreen", false, 900);
    const snapshot = measureTipAnchors({ shown, offscreen });
    expect(snapshot).toEqual([
      { id: "shown", descriptor: shown.descriptor, visible: true, top: 240 },
      { id: "offscreen", descriptor: offscreen.descriptor, visible: false, top: 0 },
    ]);
    expect(shown.measure).toHaveBeenCalledTimes(1);
    expect(offscreen.measure).not.toHaveBeenCalled();
  });
});
