// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decideCommentLanding,
  type CommentLandingInput,
} from "./comment-landing";

// The token-replay re-arm happens in the effect before this function is
// consulted, so the table covers post-rearm state: a replayed landing reads
// as alreadyLandedFor=null + consumedId=undefined.
const base: CommentLandingInput = {
  highlightCommentId: "c2",
  hasItems: true,
  alreadyLandedFor: null,
  consumedId: undefined,
  isArrival: false,
  targetInItems: true,
  scrollContainerReady: true,
  virtuosoMounted: true,
  flat: false,
  collapsedBarrierRootId: null,
  resolvedBarrierRootId: null,
};

describe("decideCommentLanding", () => {
  it("waits without a target or before items load", () => {
    expect(decideCommentLanding({ ...base, highlightCommentId: undefined })).toEqual({ kind: "wait" });
    expect(decideCommentLanding({ ...base, hasItems: false })).toEqual({ kind: "wait" });
    expect(decideCommentLanding({ ...base, hasItems: false, isArrival: true })).toEqual({ kind: "wait" });
  });

  it("skips when the guard already landed this id", () => {
    expect(decideCommentLanding({ ...base, alreadyLandedFor: "c2" })).toEqual({ kind: "skip" });
    expect(
      decideCommentLanding({ ...base, alreadyLandedFor: "c2", consumedId: "c2" }),
    ).toEqual({ kind: "skip" });
  });

  it("skips via the consumed memento (restore) — arrival and non-arrival alike", () => {
    expect(decideCommentLanding({ ...base, consumedId: "c2" })).toEqual({ kind: "skip-consumed" });
    expect(
      decideCommentLanding({ ...base, consumedId: "c2", isArrival: true }),
    ).toEqual({ kind: "skip-consumed" });
    // A different comment's record does not suppress this one.
    expect(decideCommentLanding({ ...base, consumedId: "c1" })).toEqual({ kind: "jump" });
  });

  describe("non-arrival (same-page jump)", () => {
    it("jumps when the target exists and the virtualized list is mounted", () => {
      expect(decideCommentLanding(base)).toEqual({ kind: "jump" });
    });

    it("waits when the target isn't in this issue's items (stale fragment)", () => {
      expect(decideCommentLanding({ ...base, targetInItems: false })).toEqual({ kind: "wait" });
    });

    it("waits while the scroll container or Virtuoso is missing", () => {
      expect(decideCommentLanding({ ...base, scrollContainerReady: false })).toEqual({ kind: "wait" });
      expect(decideCommentLanding({ ...base, virtuosoMounted: false })).toEqual({ kind: "wait" });
    });

    it("jumps without Virtuoso when the timeline is flat (in-page find)", () => {
      expect(
        decideCommentLanding({ ...base, flat: true, virtuosoMounted: false }),
      ).toEqual({ kind: "jump" });
    });

    it("leaves both kinds of unfolding to jumpToReply", () => {
      expect(
        decideCommentLanding({
          ...base,
          collapsedBarrierRootId: "root-1",
          resolvedBarrierRootId: "root-1",
        }),
      ).toEqual({ kind: "jump" });
    });
  });

  describe("arrival (virtualized deep-link landing)", () => {
    const arrival: CommentLandingInput = { ...base, isArrival: true };

    it("lands through the mounted virtual list", () => {
      expect(decideCommentLanding(arrival)).toEqual({ kind: "land" });
    });

    it("waits for the target, scroll container, and virtual list", () => {
      expect(decideCommentLanding({ ...arrival, targetInItems: false })).toEqual({ kind: "wait" });
      expect(decideCommentLanding({ ...arrival, scrollContainerReady: false })).toEqual({ kind: "wait" });
      expect(decideCommentLanding({ ...arrival, virtuosoMounted: false })).toEqual({ kind: "wait" });
    });

    it("can land directly when in-page find already mounted every row", () => {
      expect(
        decideCommentLanding({ ...arrival, flat: true, virtuosoMounted: false }),
      ).toEqual({ kind: "land" });
    });

    it("expands a manually collapsed thread before landing", () => {
      expect(
        decideCommentLanding({ ...arrival, collapsedBarrierRootId: "root-1" }),
      ).toEqual({ kind: "expand-collapsed", rootId: "root-1" });
    });

    it("expands a folded resolved thread before landing", () => {
      expect(
        decideCommentLanding({ ...arrival, resolvedBarrierRootId: "root-1" }),
      ).toEqual({ kind: "expand-resolved", rootId: "root-1" });
    });
  });
});
