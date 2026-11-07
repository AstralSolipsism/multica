import type {
  BaselineAnnotation,
  BaselineAnnotationBatch,
  BaselineAnnotationDetail,
  BaselineAnnotationBatchClosed,
  BaselineAnnotationsUpdated,
  BaselineChapter,
  BaselineReviewAnnotationInput,
  BaselineReviewSubmitted,
  BaselineRevision,
  SubmitProjectBaselineReviewInput,
} from "@multica/core/api";
import type { Agent } from "@multica/core/types";
import type {
  BaselineAnnotationDraft,
  BaselineAnnotationDraftAnchor,
  BaselineAnnotationDraftData,
  BaselineAnnotationDraftItem,
  BaselineAnnotationReplyDraft,
} from "@multica/core/projects/baseline-annotation-draft-store";

export type BaselineAnnotationSide = "before" | "after";
export type BaselineReviewOutcome = "changes" | "adopt" | "reject";
export type BaselineReviewRoute = "append" | "source" | "new" | "conflict" | "candidate_open";

export interface BaselineAnnotationActions {
  ownerId: string;
  agents: readonly Agent[];
  onSubmitReview: (input: SubmitProjectBaselineReviewInput) => Promise<BaselineReviewSubmitted | null>;
  onResolveAnnotations: (annotationIds: string[], resolved: boolean) => Promise<BaselineAnnotationsUpdated | null>;
  onCloseBatch: (batchId: string) => Promise<BaselineAnnotationBatchClosed | null>;
}

export interface BaselineAnnotationData {
  batches: readonly BaselineAnnotationBatch[];
  details: readonly BaselineAnnotationDetail[];
  loading: boolean;
  error: boolean;
  actions: BaselineAnnotationActions;
}

export interface BaselineAnnotationThread {
  root: BaselineAnnotation;
  batch: BaselineAnnotationBatch;
  replies: BaselineAnnotation[];
  pendingReplies: BaselineAnnotationReplyDraft[];
}

export interface BaselineComposerAnchor extends BaselineAnnotationDraftAnchor {
  side?: BaselineAnnotationSide;
  targetLabel: string;
  endRowIndex?: number;
}

export function isBaselineAnnotationReply(
  item: BaselineAnnotationDraftItem,
): item is BaselineAnnotationReplyDraft {
  return "parentAnnotationId" in item;
}

export function chapterDraftItems(
  data: BaselineAnnotationDraftData,
  projectId: string,
  chapter: BaselineChapter,
  ownerId: string,
  canDecide: boolean,
): BaselineAnnotationDraftItem[] {
  if (!canDecide || !ownerId) return [];
  return [...data.annotations, ...data.replies].filter((item) =>
    item.projectId === projectId && item.chapter === chapter && item.ownerId === ownerId
  );
}

export function reviewDraftItems(
  items: readonly BaselineAnnotationDraftItem[],
  targetRevisionIds: ReadonlySet<string>,
  activeRootIds: ReadonlySet<string>,
): BaselineAnnotationDraftItem[] {
  return items.filter((item) =>
    isBaselineAnnotationReply(item)
      ? activeRootIds.has(item.parentAnnotationId)
      : targetRevisionIds.has(item.targetRevisionId)
  );
}

export function toBaselineReviewAnnotation(
  item: BaselineAnnotationDraftItem,
): BaselineReviewAnnotationInput {
  return {
    anchorKind: item.anchorKind,
    targetRevisionId: item.targetRevisionId,
    sectionAnchor: item.sectionAnchor,
    sectionTitle: item.sectionTitle,
    ...(item.lineStart !== undefined ? { lineStart: item.lineStart } : {}),
    ...(item.lineEnd !== undefined ? { lineEnd: item.lineEnd } : {}),
    ...(item.quote !== undefined ? { quote: item.quote } : {}),
    ...(item.prefix !== undefined ? { prefix: item.prefix } : {}),
    ...(item.suffix !== undefined ? { suffix: item.suffix } : {}),
    ...(item.start !== undefined ? { start: item.start } : {}),
    ...(isBaselineAnnotationReply(item) ? { parentAnnotationId: item.parentAnnotationId } : {}),
    note: item.note,
  };
}

export function buildBaselineAnnotationThreads(
  details: readonly BaselineAnnotationDetail[],
  pendingItems: readonly BaselineAnnotationDraftItem[],
): BaselineAnnotationThread[] {
  return details.flatMap((detail) => {
    const annotations = detail.annotations;
    return annotations.filter((annotation) => !annotation.parentAnnotationId).map((root) => ({
      root,
      batch: detail.batch,
      replies: annotations.filter((annotation) => annotation.parentAnnotationId === root.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      pendingReplies: pendingItems.filter((item): item is BaselineAnnotationReplyDraft =>
        isBaselineAnnotationReply(item) && item.parentAnnotationId === root.id
      ),
    }));
  });
}

export function activeBaselineBatch(
  batches: readonly BaselineAnnotationBatch[],
  chapter: BaselineChapter,
): BaselineAnnotationBatch | null {
  return batches.find((batch) => batch.chapter === chapter && batch.state === "active") ?? null;
}

export function isBatchRelatedToCandidate(
  batch: BaselineAnnotationBatch,
  candidate: BaselineRevision,
  details: readonly BaselineAnnotationDetail[],
): boolean {
  if (!!candidate.sourceIssueId && candidate.sourceIssueId === batch.issueId) return true;
  return details.some((detail) => detail.batch.id === batch.id && detail.reviews.some((review) =>
    review.reviewedRevisionId === candidate.id
  ));
}

export function baselineReviewRoute(options: {
  candidateMode: boolean;
  candidate: BaselineRevision | null;
  chapterHasCandidate: boolean;
  activeBatch: BaselineAnnotationBatch | null;
  details: readonly BaselineAnnotationDetail[];
}): BaselineReviewRoute {
  const { candidateMode, candidate, chapterHasCandidate, activeBatch, details } = options;
  if (activeBatch) {
    if (!candidateMode) return "append";
    return candidate && isBatchRelatedToCandidate(activeBatch, candidate, details) ? "append" : "conflict";
  }
  if (!candidateMode) return chapterHasCandidate ? "candidate_open" : "new";
  return candidate?.sourceIssueId && candidate.createdByType === "agent" ? "source" : "new";
}

export function annotationSide(
  annotation: BaselineAnnotation | BaselineAnnotationDraft,
  baseRevisionId: string | null,
): BaselineAnnotationSide {
  if ("side" in annotation && annotation.side === "before") return "before";
  if (!("side" in annotation) && annotation.targetRevisionId === baseRevisionId) return "before";
  return "after";
}

export function annotationLines(
  annotation: BaselineAnnotation | BaselineAnnotationDraft,
): { start: number; end: number } | null {
  if (annotation.anchorKind !== "lines") return null;
  const located = "located" in annotation ? annotation.located : null;
  const start = located?.lineStart ?? annotation.lineStart;
  const end = located?.lineEnd ?? annotation.lineEnd;
  if (start == null || end == null) return null;
  return { start, end };
}

export function annotationReplyAnchor(annotation: BaselineAnnotation): BaselineAnnotationDraftAnchor {
  return {
    anchorKind: annotation.anchorKind === "unknown" ? "section" : annotation.anchorKind,
    targetRevisionId: annotation.targetRevisionId,
    sectionAnchor: annotation.sectionAnchor,
    sectionTitle: annotation.sectionTitle,
    ...(annotation.lineStart != null ? { lineStart: annotation.lineStart } : {}),
    ...(annotation.lineEnd != null ? { lineEnd: annotation.lineEnd } : {}),
    ...(annotation.quote ? { quote: annotation.quote } : {}),
    ...(annotation.prefix ? { prefix: annotation.prefix } : {}),
    ...(annotation.suffix ? { suffix: annotation.suffix } : {}),
    ...(annotation.start ? { start: annotation.start } : {}),
  };
}

export function draftAnchor(
  item: BaselineAnnotationDraftItem,
): BaselineAnnotationDraftAnchor {
  return {
    anchorKind: item.anchorKind,
    targetRevisionId: item.targetRevisionId,
    sectionAnchor: item.sectionAnchor,
    sectionTitle: item.sectionTitle,
    ...(item.lineStart !== undefined ? { lineStart: item.lineStart } : {}),
    ...(item.lineEnd !== undefined ? { lineEnd: item.lineEnd } : {}),
    ...(item.quote !== undefined ? { quote: item.quote } : {}),
    ...(item.prefix !== undefined ? { prefix: item.prefix } : {}),
    ...(item.suffix !== undefined ? { suffix: item.suffix } : {}),
    ...(item.start !== undefined ? { start: item.start } : {}),
  };
}

export function newBaselineAnnotation(
  anchor: BaselineAnnotationDraftAnchor,
  note: string,
  identity: { id: string; ownerId: string; projectId: string; chapter: BaselineChapter; createdAt: string },
): BaselineAnnotationDraft {
  return { ...anchor, ...identity, note };
}

export function newBaselineAnnotationReply(
  parent: BaselineAnnotation,
  note: string,
  identity: { id: string; ownerId: string; projectId: string; chapter: BaselineChapter; createdAt: string },
): BaselineAnnotationReplyDraft {
  return {
    ...annotationReplyAnchor(parent),
    ...identity,
    parentAnnotationId: parent.id,
    note,
  };
}
