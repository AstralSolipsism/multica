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
  });

  describe("arrival (flat deep-link landing)", () => {
    const arrival: CommentLandingInput = { ...base, isArrival: true };

    it("lands", () => {
      expect(decideCommentLanding(arrival)).toEqual({ kind: "land" });
    });

    it("lands even when the target has no items hit (deleted reply lands above)", () => {
      expect(decideCommentLanding({ ...arrival, targetInItems: false })).toEqual({ kind: "land" });
    });

    it("expands a folded resolved thread before landing", () => {
      expect(
        decideCommentLanding({ ...arrival, resolvedBarrierRootId: "root-1" }),
      ).toEqual({ kind: "expand-resolved", rootId: "root-1" });
    });

    it("never expands on the non-arrival path (the jump unfolds through jumpToReply)", () => {
      expect(
        decideCommentLanding({ ...base, resolvedBarrierRootId: "root-1" }),
      ).toEqual({ kind: "jump" });
    });
  });
});
