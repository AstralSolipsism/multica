// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BaselineAnnotation, BaselineRevision } from "@multica/core/api";
import type {
  BaselineAnnotationDraft,
  BaselineAnnotationReplyDraft,
} from "@multica/core/projects/baseline-annotation-draft-store";
import {
  anchorOutdated,
  anchorPlacement,
  baselineReviewRoute,
  isBatchRelatedToCandidate,
  reviewDraftItems,
  toBaselineReviewAnnotation,
} from "./engineering-baseline-annotation-model";

const candidate = {
  id: "candidate-1", chapter: "domain_rules", sourceIssueId: "source-1", createdByType: "agent",
} as BaselineRevision;
const activeBatch = {
  id: "batch-1", chapter: "domain_rules", issueId: "carrier-1", state: "active",
} as never;

describe("baseline annotation review routing", () => {
  it("uses a related active batch for reviewed candidates even without a source task", () => {
    const unrelatedSource = { ...candidate, sourceIssueId: null };
    const details = [{ batch: activeBatch, reviews: [{ reviewedRevisionId: candidate.id }] }] as never[];
    expect(isBatchRelatedToCandidate(activeBatch, candidate, details)).toBe(true);
    expect(baselineReviewRoute({ candidateMode: true, candidate: unrelatedSource, chapterHasCandidate: true, activeBatch, details: [] })).toBe("conflict");
    expect(baselineReviewRoute({ candidateMode: true, candidate: unrelatedSource, chapterHasCandidate: true, activeBatch, details })).toBe("append");
  });

  it("routes source-backed candidates to their author and other candidates to a new task", () => {
    expect(baselineReviewRoute({ candidateMode: true, candidate, chapterHasCandidate: true, activeBatch: null, details: [] })).toBe("source");
    expect(baselineReviewRoute({
      candidateMode: true,
      candidate: { ...candidate, sourceIssueId: null },
      chapterHasCandidate: true,
      activeBatch: null,
      details: [],
    })).toBe("new");
  });

  it("blocks baseline reviews behind an existing candidate unless an active batch accepts an append", () => {
    expect(baselineReviewRoute({ candidateMode: false, candidate: null, chapterHasCandidate: true, activeBatch: null, details: [] })).toBe("candidate_open");
    expect(baselineReviewRoute({ candidateMode: false, candidate: null, chapterHasCandidate: true, activeBatch, details: [] })).toBe("append");
    expect(baselineReviewRoute({ candidateMode: false, candidate: null, chapterHasCandidate: false, activeBatch: null, details: [] })).toBe("new");
  });
});

describe("baseline annotation review payload", () => {
  const annotation: BaselineAnnotationDraft = {
    id: "local-1", ownerId: "owner-1", projectId: "project-1", chapter: "domain_rules",
    anchorKind: "lines", targetRevisionId: "base-1", sectionAnchor: "RULE-1", sectionTitle: "Rule",
    lineStart: 2, lineEnd: 3, quote: "two\nlines", note: "Clarify", createdAt: "2026-01-01T00:00:00Z",
  };
  const reply: BaselineAnnotationReplyDraft = {
    ...annotation, id: "local-reply", targetRevisionId: "old-1", parentAnnotationId: "root-1", note: "Reply",
  };

  it("includes only current targets and replies to active roots", () => {
    const other = { ...annotation, id: "other", targetRevisionId: "other-1" };
    expect(reviewDraftItems([annotation, other, reply], new Set(["base-1"]), new Set(["root-1"]))).toEqual([annotation, reply]);
    expect(reviewDraftItems([annotation, other, reply], new Set(["base-1"]), new Set())).toEqual([annotation]);
  });

  it("removes local identity while retaining complete reply anchors", () => {
    expect(toBaselineReviewAnnotation(reply)).toEqual({
      anchorKind: "lines", targetRevisionId: "old-1", parentAnnotationId: "root-1",
      sectionAnchor: "RULE-1", sectionTitle: "Rule", lineStart: 2, lineEnd: 3,
      quote: "two\nlines", note: "Reply",
    });
    expect(toBaselineReviewAnnotation(reply)).not.toHaveProperty("id");
    expect(toBaselineReviewAnnotation(reply)).not.toHaveProperty("ownerId");
  });
});

describe("baseline anchor placement", () => {
  const candidate = { id: "candidate-1", revisionNumber: 3 } as BaselineRevision;
  const root = (overrides: Partial<BaselineAnnotation>): BaselineAnnotation => ({
    id: "annotation-1", ordinal: 1, reviewId: "review-1", parentAnnotationId: null,
    anchorKind: "lines", sectionAnchor: "RULE-1", sectionTitle: "Rule",
    targetRevisionId: "candidate-1", targetRevisionNumber: 3, side: "after",
    lineStart: 2, lineEnd: 2, quote: "", prefix: "", suffix: "", start: 0,
    note: "Note", response: null, respondedAt: null, respondedByTaskId: null,
    createdById: "user-1", createdAt: "2026-01-01T00:00:00Z", resolvedAt: null, resolvedById: null,
    state: "open", location: "exact", located: null, ...overrides,
  });

  it("keeps original lines for base and candidate targets regardless of server location", () => {
    // Working-version (candidate-numbered) located lines must not override the
    // base-side anchor lines, and candidate targets keep their after lines.
    const beforeMoved = root({
      targetRevisionId: "base-1", targetRevisionNumber: 2, side: "before", location: "moved",
      located: { revisionNumber: 3, lineStart: 3, lineEnd: 3, start: undefined },
    });
    expect(anchorPlacement(beforeMoved, "base-1", candidate)).toEqual({ side: "before", start: 2, end: 2 });
    expect(anchorOutdated(beforeMoved, "base-1", candidate)).toBe(false);
    const afterExact = root({ lineStart: 5, lineEnd: 6, located: { revisionNumber: 3, lineStart: 4, lineEnd: 4, start: undefined } });
    expect(anchorPlacement(afterExact, "base-1", candidate)).toEqual({ side: "after", start: 5, end: 6 });
    expect(anchorOutdated(afterExact, "base-1", candidate)).toBe(false);
  });

  it("falls back to located lines on the candidate side for replaced revisions", () => {
    const replaced = root({
      targetRevisionId: "replaced-1", targetRevisionNumber: 2, location: "moved",
      located: { revisionNumber: 3, lineStart: 7, lineEnd: 8, start: undefined },
    });
    expect(anchorPlacement(replaced, "base-1", candidate)).toEqual({ side: "after", start: 7, end: 8 });
    expect(anchorOutdated(replaced, "base-1", candidate)).toBe(false);
  });

  it("marks anchors unlocatable in the rendered revisions outdated", () => {
    const foreign = root({ targetRevisionId: "old-1", location: "outdated", located: null });
    expect(anchorPlacement(foreign, "base-1", candidate)).toBeNull();
    expect(anchorOutdated(foreign, "base-1", candidate)).toBe(true);
    const foreignLocated = root({
      targetRevisionId: "old-1", location: "moved",
      located: { revisionNumber: 2, lineStart: 1, lineEnd: 1, start: undefined },
    });
    expect(anchorPlacement(foreignLocated, "base-1", candidate)).toBeNull();
    expect(anchorOutdated(foreignLocated, "base-1", candidate)).toBe(true);
    // Deleted lines on a rendered target still land on their removed row in
    // the Diff — no "outdated" badge while the version has not changed.
    const deletedLines = root({
      targetRevisionId: "base-1", side: "before", location: "outdated", located: null,
    });
    expect(anchorPlacement(deletedLines, "base-1", candidate)).toEqual({ side: "before", start: 2, end: 2 });
    expect(anchorOutdated(deletedLines, "base-1", candidate)).toBe(false);
  });

  it("keeps section anchors without line placement", () => {
    const section = root({ anchorKind: "section", lineStart: null, lineEnd: null });
    expect(anchorPlacement(section, "base-1", candidate)).toBeNull();
    expect(anchorOutdated(section, "base-1", candidate)).toBe(false);
  });
});
