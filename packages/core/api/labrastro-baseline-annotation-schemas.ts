import { z } from "zod";
import { BaselineChapterSchema } from "./labrastro-engineering-schemas";

const id = z.string().uuid();
const nullableId = id.nullable().default(null);
const nullableTime = z.string().nullable().default(null);
const carrier = z.object({
  kind: z.enum(["revision_issue", "source_issue", "unknown"]).catch("unknown"),
  issue_id: nullableId, identifier: z.string().default(""),
}).transform((v) => ({ kind: v.kind, issueId: v.issue_id, identifier: v.identifier }));
const batchRow = z.object({
  id, workspace_id: id, project_id: id, chapter: BaselineChapterSchema,
  carrier_kind: z.enum(["revision_issue", "source_issue", "unknown"]).catch("unknown"),
  issue_id: nullableId, agent_id: id, created_by_id: id, created_at: z.string(),
  closed_at: nullableTime, close_reason: z.enum(["adopted", "rejected", "manual", "issue_closed", "unknown"]).catch("unknown").nullable().default(null),
  closed_by_id: nullableId, closed_revision_id: nullableId,
});
const batchFields = (v: z.infer<typeof batchRow>) => ({
  id: v.id, workspaceId: v.workspace_id, projectId: v.project_id, chapter: v.chapter,
  carrierKind: v.carrier_kind, issueId: v.issue_id, agentId: v.agent_id, createdById: v.created_by_id, createdAt: v.created_at,
  closedAt: v.closed_at, closeReason: v.close_reason, closedById: v.closed_by_id, closedRevisionId: v.closed_revision_id,
});
export const BaselineAnnotationBatchRowSchema = batchRow.transform(batchFields);
export const BaselineAnnotationBatchSchema = batchRow.extend({
  state: z.enum(["active", "closed", "unknown"]).catch("unknown"), carrier,
  working: z.object({ revision_id: id, revision_number: z.number().int().positive(), status: z.enum(["candidate", "adopted", "unknown"]).catch("unknown") })
    .transform((v) => ({ revisionId: v.revision_id, revisionNumber: v.revision_number, status: v.status })).nullable().default(null),
  counts: z.object({ open: z.number().int().nonnegative(), resolved: z.number().int().nonnegative() }),
}).transform((v) => ({ ...batchFields(v), state: v.state, carrier: v.carrier, working: v.working, counts: v.counts }));
export const BaselineReviewSchema = z.object({
  id, batch_id: id, client_key: id, reviewed_revision_id: id, summary: z.string().default(""),
  wake_comment_id: nullableId, created_by_id: id, created_at: z.string(),
}).transform((v) => ({ id: v.id, batchId: v.batch_id, clientKey: v.client_key, reviewedRevisionId: v.reviewed_revision_id,
  summary: v.summary, wakeCommentId: v.wake_comment_id, createdById: v.created_by_id, createdAt: v.created_at }));
export const BaselineAnnotationSchema = z.object({
  id, ordinal: z.number().int().min(1).max(50), review_id: id, parent_annotation_id: nullableId,
  anchor_kind: z.enum(["text", "lines", "section", "unknown"]).catch("unknown"),
  section_anchor: z.string().min(1), section_title: z.string().default(""), target_revision_id: id, target_revision_number: z.number().int().positive(),
  side: z.enum(["before", "after", "unknown"]).catch("unknown"),
  line_start: z.number().int().positive().nullable().default(null), line_end: z.number().int().positive().nullable().default(null),
  quote: z.string().default(""), prefix: z.string().default(""), suffix: z.string().default(""), start: z.number().int().nonnegative().default(0),
  note: z.string(), response: z.string().nullable().default(null), responded_at: nullableTime, responded_by_task_id: nullableId,
  created_by_id: id, created_at: z.string(), resolved_at: nullableTime, resolved_by_id: nullableId,
  state: z.enum(["open", "resolved", "archived", "unknown"]).catch("unknown"),
  location: z.enum(["exact", "moved", "section_only", "outdated", "unknown"]).catch("unknown"),
  located: z.object({ revision_number: z.number().int().positive(), line_start: z.number().int().positive().optional(),
    line_end: z.number().int().positive().optional(), start: z.number().int().nonnegative().optional() })
    .transform((v) => ({ revisionNumber: v.revision_number, lineStart: v.line_start, lineEnd: v.line_end, start: v.start })).nullable().default(null),
}).transform((v) => ({
  id: v.id, ordinal: v.ordinal, reviewId: v.review_id, parentAnnotationId: v.parent_annotation_id, anchorKind: v.anchor_kind,
  sectionAnchor: v.section_anchor, sectionTitle: v.section_title, targetRevisionId: v.target_revision_id, targetRevisionNumber: v.target_revision_number,
  side: v.side, lineStart: v.line_start, lineEnd: v.line_end, quote: v.quote, prefix: v.prefix, suffix: v.suffix, start: v.start,
  note: v.note, response: v.response, respondedAt: v.responded_at, respondedByTaskId: v.responded_by_task_id,
  createdById: v.created_by_id, createdAt: v.created_at, resolvedAt: v.resolved_at, resolvedById: v.resolved_by_id,
  state: v.state, location: v.location, located: v.located,
}));
export const BaselineAnnotationBatchesSchema = z.object({ batches: z.array(BaselineAnnotationBatchSchema) });
export const BaselineAnnotationDetailSchema = z.object({
  batch: BaselineAnnotationBatchSchema, reviews: z.array(BaselineReviewSchema), annotations: z.array(BaselineAnnotationSchema),
  sections: z.array(z.object({ chapter: BaselineChapterSchema, anchor: z.string(), title: z.string(), level: z.number().int(), content_markdown: z.string() })
    .transform((v) => ({ chapter: v.chapter, anchor: v.anchor, title: v.title, level: v.level, contentMarkdown: v.content_markdown }))).default([]),
});
export const BaselineReviewSubmittedSchema = z.object({
  batch: BaselineAnnotationBatchRowSchema, review: BaselineReviewSchema, carrier,
  woke: z.object({ agent_id: id, via: z.enum(["assign", "mention", "unknown"]).catch("unknown") }).transform((v) => ({ agentId: v.agent_id, via: v.via })),
});
export const BaselineAnnotationsUpdatedSchema = z.object({ updated: z.number().int().min(1).max(50) });
export const BaselineAnnotationBatchClosedSchema = z.object({ batch: BaselineAnnotationBatchRowSchema });

export type BaselineAnnotationBatchRow = z.infer<typeof BaselineAnnotationBatchRowSchema>;
export type BaselineAnnotationBatch = z.infer<typeof BaselineAnnotationBatchSchema>;
export type BaselineAnnotationBatches = z.infer<typeof BaselineAnnotationBatchesSchema>;
export type BaselineReview = z.infer<typeof BaselineReviewSchema>;
export type BaselineAnnotation = z.infer<typeof BaselineAnnotationSchema>;
export type BaselineAnnotationDetail = z.infer<typeof BaselineAnnotationDetailSchema>;
export type BaselineAnnotationSection = BaselineAnnotationDetail["sections"][number];
export type BaselineReviewSubmitted = z.infer<typeof BaselineReviewSubmittedSchema>;
export type BaselineAnnotationsUpdated = z.infer<typeof BaselineAnnotationsUpdatedSchema>;
export type BaselineAnnotationBatchClosed = z.infer<typeof BaselineAnnotationBatchClosedSchema>;
