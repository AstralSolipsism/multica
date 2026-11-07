// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BaselineRevision } from "@multica/core/api";
import type {
  BaselineAnnotationDraft,
  BaselineAnnotationReplyDraft,
} from "@multica/core/projects/baseline-annotation-draft-store";
import {
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
