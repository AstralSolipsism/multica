import { z } from "zod";
import { CommentTriggerOutcomeSchema } from "./schemas";

export const WikiCommentAnchorSchema = z.object({
  kind: z.enum(["text", "section"]).catch("section"),
  section_anchor: z.string(), section_title: z.string().catch(""),
  exact: z.string().catch(""), prefix: z.string().catch(""), suffix: z.string().catch(""),
  start: z.number().int().nonnegative().optional(), revision_number: z.number().int().catch(0),
}).transform((a) => ({ kind: a.kind, sectionAnchor: a.section_anchor, sectionTitle: a.section_title, exact: a.exact, prefix: a.prefix, suffix: a.suffix, start: a.start, revisionNumber: a.revision_number }));
export type WikiCommentAnchor = z.infer<typeof WikiCommentAnchorSchema>;

export const WikiCommentLocationSchema = z.object({
  state: z.enum(["anchored", "moved", "section_only", "orphaned"]).catch("orphaned"),
  section_anchor: z.string().optional(), start: z.number().int().nonnegative().optional(),
}).transform((l) => ({ state: l.state, sectionAnchor: l.section_anchor, start: l.start }));
export type WikiCommentLocation = z.infer<typeof WikiCommentLocationSchema>;

export const WikiCommentSchema = z.object({
  id: z.string(), body_markdown: z.string(), author_type: z.enum(["member", "agent"]).catch("member"),
  author_id: z.string(), author_task_id: z.string().nullish(), created_at: z.string(), edited_at: z.string().nullish(),
}).transform((c) => ({ id: c.id, bodyMarkdown: c.body_markdown, authorType: c.author_type, authorId: c.author_id, authorTaskId: c.author_task_id ?? null, createdAt: c.created_at, editedAt: c.edited_at ?? null }));
export type WikiComment = z.infer<typeof WikiCommentSchema>;

export const WikiThreadSchema = z.object({
  id: z.string(), page_id: z.string(), anchor: WikiCommentAnchorSchema, location: WikiCommentLocationSchema,
  issue_id: z.string().nullish(), identifier: z.string().catch(""),
  resolved_at: z.string().nullish(), resolved_by_type: z.string().nullish(), resolved_by_id: z.string().nullish(),
  created_at: z.string(), updated_at: z.string(), comments: z.array(WikiCommentSchema),
  section: z.object({ anchor: z.string(), title: z.string(), content_markdown: z.string() }).nullish(),
}).transform((t) => ({
  id: t.id, pageId: t.page_id, anchor: t.anchor, location: t.location, issueId: t.issue_id ?? null, identifier: t.identifier,
  resolvedAt: t.resolved_at ?? null, resolvedByType: t.resolved_by_type ?? null, resolvedById: t.resolved_by_id ?? null,
  createdAt: t.created_at, updatedAt: t.updated_at, comments: t.comments,
  section: t.section ? { anchor: t.section.anchor, title: t.section.title, contentMarkdown: t.section.content_markdown } : null,
}));
export type WikiThread = z.infer<typeof WikiThreadSchema>;
export const WikiCommentWriteSchema = z.object({ thread: WikiThreadSchema, woke: z.array(CommentTriggerOutcomeSchema.transform((w) => ({ targetType: w.target_type, targetId: w.target_id, status: w.status, reasonCode: w.reason_code }))).catch([]) });

export function wikiCommentAnchorToWire(a: WikiCommentAnchor) {
  return { kind: a.kind, section_anchor: a.sectionAnchor, section_title: a.sectionTitle, exact: a.exact, prefix: a.prefix, suffix: a.suffix, start: a.start, revision_number: a.revisionNumber };
}
