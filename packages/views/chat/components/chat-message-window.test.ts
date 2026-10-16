// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  advanceChatMessageWindowAnchor,
  CHAT_MESSAGE_WINDOW_BASE_INDEX,
  type ChatMessageWindowAnchor,
} from "./chat-message-window";

const BASE = CHAT_MESSAGE_WINDOW_BASE_INDEX;

function anchor(
  keys: readonly string[],
  firstItemIndex: number = BASE,
): ChatMessageWindowAnchor {
  return { keys, firstItemIndex };
}

describe("advanceChatMessageWindowAnchor", () => {
  it("starts a fresh window at the base index", () => {
    expect(advanceChatMessageWindowAnchor(anchor([]), ["m1", "m2"]).firstItemIndex).toBe(BASE);
  });

  it("keeps the index when new messages arrive at the tail", () => {
    // The common live case: chat:message upserts into page 0's tail. Nothing
    // above moved, so nothing may be compensated.
    const prev = anchor(["m1", "m2", "m3"], BASE - 50);
    const next = advanceChatMessageWindowAnchor(prev, ["m1", "m2", "m3", "m4"]);
    expect(next.firstItemIndex).toBe(BASE - 50);
  });

  it("moves the index down by exactly the prepended row count when an older page lands", () => {
    // Scrolling up fetches a cursor page: those rows appear ABOVE the window.
    // Virtuoso shifts the viewport by (prepended rows x their height), so the
    // count must come from the rendered keys — a count taken from raw page
    // data also charged for filtered rows (onboarding_kickoff never renders),
    // leaving the compensation one row off (OL-272).
    const prev = anchor(["m50", "m51"], BASE);
    const next = advanceChatMessageWindowAnchor(prev, ["m47", "m48", "m49", "m50", "m51"]);
    expect(next.firstItemIndex).toBe(BASE - 3);
  });

  it("moves the index up when a refetch slides the full loaded window down", () => {
    // All loaded pages full, one new message at the tail: the refetch
    // re-normalizes page boundaries and the oldest loaded row falls out of
    // the window. Counting page sizes leaves firstItemIndex unchanged while
    // the top row silently changes identity — Virtuoso then anchors the
    // viewport to the wrong row (OL-272). Identity diffing sees the drop.
    const prev = anchor(["m1", "m2", "m3"], BASE - 3);
    const next = advanceChatMessageWindowAnchor(prev, ["m2", "m3", "m4"]);
    expect(next.firstItemIndex).toBe(BASE - 3 + 1);
  });

  it("keeps the index when a refetch only slides the page boundary", () => {
    // Last (oldest) page not full: it absorbs the boundary shift, so the
    // merged window gains the new row at the TAIL and the top row is
    // unchanged. Page arithmetic would report one more "older" row and
    // compensate for a prepend that never happened (OL-272).
    const prev = anchor(["m1", "m2", "m3"], BASE - 3);
    const next = advanceChatMessageWindowAnchor(prev, ["m1", "m2", "m3", "m4"]);
    expect(next.firstItemIndex).toBe(BASE - 3);
  });

  it("survives a simultaneous top drop and tail append", () => {
    const prev = anchor(["m1", "m2", "m3", "m4"], BASE - 4);
    const next = advanceChatMessageWindowAnchor(prev, ["m3", "m4", "m5", "m6"]);
    expect(next.firstItemIndex).toBe(BASE - 4 + 2);
  });

  it("keeps the index when the window is wholly replaced", () => {
    // No overlap to anchor on (e.g. a refetch racing a cache clear): Virtuoso
    // re-keys every row off computeItemKey anyway, so holding the index is the
    // least-surprise fallback.
    const prev = anchor(["m1", "m2"], BASE - 2);
    const next = advanceChatMessageWindowAnchor(prev, ["x1", "x2"]);
    expect(next.firstItemIndex).toBe(BASE - 2);
  });

  it("returns to the base index whenever the window empties", () => {
    const prev = anchor(["m1"], BASE - 1);
    expect(advanceChatMessageWindowAnchor(prev, []).firstItemIndex).toBe(BASE);
  });
});
