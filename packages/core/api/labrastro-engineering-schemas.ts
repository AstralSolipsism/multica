import { z } from "zod";

const id = z.string().uuid();
const actor = z.enum(["member", "agent", "unknown"]).catch("unknown");

const wikiPageBase = z.object({
  id,
  slug: z.string(),
  title: z.string(),
  parent_id: id.nullable().default(null),
  position: z.number().int().nonnegative(),
  archived_at: z.string().nullable().default(null),
  current_revision_number: z.number().int().nonnegative().default(0),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
});
const wikiPageTransform = (v: z.infer<typeof wikiPageBase>) => ({
  id: v.id, slug: v.slug, title: v.title, parentId: v.parent_id, position: v.position,
  archivedAt: v.archived_at, currentRevisionNumber: v.current_revision_number,
  createdAt: v.created_at, updatedAt: v.updated_at,
});
export const WikiPageSchema = wikiPageBase.transform(wikiPageTransform);
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiTreeCurrentSchema = z.object({
  number: z.number().int().nonnegative(),
  kind: z.string().default("content"),
  created_at: z.string().default(""),
  created_by_type: actor,
  created_by_id: id,
  change_summary: z.string().default(""),
  source_issue_id: id.nullable().default(null),
}).transform((v) => ({
  number: v.number, kind: v.kind, createdAt: v.created_at, createdByType: v.created_by_type,
  createdById: v.created_by_id, changeSummary: v.change_summary, sourceIssueId: v.source_issue_id,
}));
export type WikiTreeCurrent = z.infer<typeof WikiTreeCurrentSchema>;

export const WikiTreeSectionSchema = z.object({
  anchor: z.string(), title: z.string().default(""), level: z.number().int().default(2),
}).transform((v) => ({ anchor: v.anchor, title: v.title, level: v.level }));
export type WikiTreeSection = z.infer<typeof WikiTreeSectionSchema>;

export const WikiTreePageSchema = wikiPageBase.extend({
  depth: z.number().int().positive().default(1),
  current: WikiTreeCurrentSchema.nullable().default(null),
  revision_count: z.number().int().nonnegative().default(0),
  sections: z.array(WikiTreeSectionSchema).default([]),
}).transform((v) => ({
  ...wikiPageTransform(v),
  depth: v.depth, current: v.current, revisionCount: v.revision_count, sections: v.sections,
}));
export type WikiTreePage = z.infer<typeof WikiTreePageSchema>;

export const WikiTreeSchema = z.object({
  pages: z.array(WikiTreePageSchema).default([]),
  limits: z.object({ max_depth: z.number().int(), max_pages: z.number().int() }).default({ max_depth: 6, max_pages: 500 }),
}).transform((v) => ({ pages: v.pages, limits: { maxDepth: v.limits.max_depth, maxPages: v.limits.max_pages } }));
export type WikiTree = z.infer<typeof WikiTreeSchema>;

const revisionKind = z.enum(["create", "content", "rename", "move", "archive", "restore", "rollback", "unknown"]).catch("unknown");

export const WikiRevisionSchema = z.object({
  id,
  page_id: id,
  revision_number: z.number().int().positive(),
  revision_kind: revisionKind,
  title: z.string().default(""),
  slug: z.string().default(""),
  parent_id: id.nullable().default(null),
  position: z.number().int().nonnegative().default(0),
  archived_at: z.string().nullable().default(null),
  content_markdown: z.string().default(""),
  change_summary: z.string().default(""),
  base_revision_id: id.nullable().default(null),
  restored_from_revision_id: id.nullable().default(null),
  source_issue_id: id.nullable().default(null),
  created_by_type: actor,
  created_by_id: id,
  created_by_task_id: id.nullable().default(null),
  created_at: z.string().default(""),
}).transform((v) => ({
  id: v.id, pageId: v.page_id, revisionNumber: v.revision_number, revisionKind: v.revision_kind,
  title: v.title, slug: v.slug, parentId: v.parent_id, position: v.position, archivedAt: v.archived_at,
  contentMarkdown: v.content_markdown, changeSummary: v.change_summary, baseRevisionId: v.base_revision_id,
  restoredFromRevisionId: v.restored_from_revision_id, sourceIssueId: v.source_issue_id,
  createdByType: v.created_by_type, createdById: v.created_by_id, createdByTaskId: v.created_by_task_id,
  createdAt: v.created_at,
}));
export type WikiRevision = z.infer<typeof WikiRevisionSchema>;

export const WikiLinkSchema = z.object({
  raw: z.string(),
  display: z.string().default(""),
  target: z.string().default(""),
  section: z.string().default(""),
  kind: z.enum(["page", "stage", "unknown"]).catch("unknown"),
  state: z.enum(["resolved", "ambiguous", "missing", "unknown"]).catch("unknown"),
  target_slug: z.string().nullable().default(null),
  section_anchor: z.string().nullable().default(null),
  candidates: z.array(z.string()).nullable().default(null),
}).transform((v) => ({
  raw: v.raw, display: v.display || v.raw, target: v.target, section: v.section,
  kind: v.kind, state: v.state, targetSlug: v.target_slug, sectionAnchor: v.section_anchor, candidates: v.candidates ?? [],
}));
export type WikiLink = z.infer<typeof WikiLinkSchema>;

export const WikiBacklinkSchema = z.object({
  slug: z.string(), title: z.string().default(""), section_anchor: z.string().default(""), snippet: z.string().default(""),
}).transform((v) => ({ slug: v.slug, title: v.title, sectionAnchor: v.section_anchor, snippet: v.snippet }));
export type WikiBacklink = z.infer<typeof WikiBacklinkSchema>;

export const WikiRelatedIssueSchema = z.object({
  id, identifier: z.string(), title: z.string().default(""), status: z.string().default(""),
}).transform((v) => ({ id: v.id, identifier: v.identifier, title: v.title, status: v.status }));
export type WikiRelatedIssue = z.infer<typeof WikiRelatedIssueSchema>;

const WikiSectionSliceSchema = z.object({
  page: z.string().default(""), anchor: z.string(), title: z.string().default(""), level: z.number().int().default(2),
  content_markdown: z.string().default(""),
}).transform((v) => ({ page: v.page, anchor: v.anchor, title: v.title, level: v.level, contentMarkdown: v.content_markdown }));
export type WikiSectionSlice = z.infer<typeof WikiSectionSliceSchema>;

const WikiReferencedSectionSchema = z.object({
  page: z.string().default(""), anchor: z.string(), title: z.string().default(""), level: z.number().int().default(2),
  definition: z.string().default(""), why: z.string().default(""),
}).transform((v) => ({ page: v.page, anchor: v.anchor, title: v.title, level: v.level, definition: v.definition, why: v.why }));
export type WikiReferencedSection = z.infer<typeof WikiReferencedSectionSchema>;

export const WikiPageReadSchema = z.object({
  page: WikiPageSchema,
  revision: WikiRevisionSchema,
  content_markdown: z.string().optional(),
  sections: z.array(WikiSectionSliceSchema).optional(),
  referenced_sections: z.array(WikiReferencedSectionSchema).optional(),
  links: z.array(WikiLinkSchema).default([]),
  backlinks: z.array(WikiBacklinkSchema).default([]),
  related_issues: z.array(WikiRelatedIssueSchema).default([]),
}).transform((v) => ({
  page: v.page, revision: v.revision,
  contentMarkdown: v.content_markdown ?? null,
  sections: v.sections ?? [], referencedSections: v.referenced_sections ?? [],
  links: v.links, backlinks: v.backlinks, relatedIssues: v.related_issues,
}));
export type WikiPageRead = z.infer<typeof WikiPageReadSchema>;

export const WikiWriteResultSchema = z.object({
  page: WikiPageSchema,
  revision: WikiRevisionSchema,
  rebased: z.boolean().default(false),
}).transform((v) => ({ page: v.page, revision: v.revision, rebased: v.rebased }));
export type WikiWriteResult = z.infer<typeof WikiWriteResultSchema>;

export const WikiArchiveResultSchema = z.object({
  pages: z.array(z.object({ page: WikiPageSchema, revision: WikiRevisionSchema })).default([]),
}).transform((v) => ({ pages: v.pages }));
export type WikiArchiveResult = z.infer<typeof WikiArchiveResultSchema>;

export const WikiHistorySchema = z.object({
  revisions: z.array(WikiRevisionSchema).default([]),
  has_more: z.boolean().default(false),
  next_before: z.number().int().positive().nullable().default(null),
}).transform((v) => ({ revisions: v.revisions, hasMore: v.has_more, nextBefore: v.next_before }));
export type WikiHistory = z.infer<typeof WikiHistorySchema>;

const WikiDiffChangeSchema = z.object({
  anchor: z.string(), title: z.string().default(""),
  before: z.string().default(""), after: z.string().default(""),
}).transform((v) => ({ anchor: v.anchor, title: v.title, before: v.before, after: v.after }));

export const WikiDiffSchema = z.object({
  structure: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })).default({}),
  sections: z.object({
    base_revision_number: z.number().int().default(0),
    added: z.array(WikiDiffChangeSchema).default([]),
    modified: z.array(WikiDiffChangeSchema).default([]),
    removed: z.array(WikiDiffChangeSchema).default([]),
    unchanged_count: z.number().int().default(0),
    warnings: z.array(z.object({ code: z.string(), anchor: z.string() })).default([]),
  }),
}).transform((v) => ({ structure: v.structure, sections: v.sections }));
export type WikiDiff = z.infer<typeof WikiDiffSchema>;

export const WikiActivityItemSchema = z.object({
  page_id: id, slug: z.string(), title: z.string().default(""),
  kind: revisionKind, number: z.number().int(),
  created_at: z.string(), created_by_type: actor, created_by_id: id,
  change_summary: z.string().default(""), source_issue_id: id.nullable().default(null),
}).transform((v) => ({
  pageId: v.page_id, slug: v.slug, title: v.title, kind: v.kind, number: v.number,
  createdAt: v.created_at, createdByType: v.created_by_type, createdById: v.created_by_id,
  changeSummary: v.change_summary, sourceIssueId: v.source_issue_id,
}));
export type WikiActivityItem = z.infer<typeof WikiActivityItemSchema>;

export const WikiSearchHitSchema = z.object({
  page_id: id, slug: z.string(), title: z.string().default(""),
  section_anchor: z.string().default(""), section_title: z.string().default(""),
  snippet: z.string().default(""), match: z.enum(["title", "section", "body", "unknown"]).catch("unknown"),
}).transform((v) => ({
  pageId: v.page_id, slug: v.slug, title: v.title, sectionAnchor: v.section_anchor,
  sectionTitle: v.section_title, snippet: v.snippet, match: v.match,
}));
export type WikiSearchHit = z.infer<typeof WikiSearchHitSchema>;

export const WikiConflictSchema = z.object({
  code: z.literal("baseline_conflict"),
  current: z.object({
    revision_number: z.number().int().positive(),
    kind: revisionKind,
    created_at: z.string(),
    created_by_type: actor,
    created_by_id: id,
    change_summary: z.string().default(""),
    source_issue_id: id.nullable().default(null),
  }).transform((v) => ({
    revisionNumber: v.revision_number, kind: v.kind, createdAt: v.created_at,
    createdByType: v.created_by_type, createdById: v.created_by_id,
    changeSummary: v.change_summary, sourceIssueId: v.source_issue_id,
  })),
});
export type WikiConflict = z.infer<typeof WikiConflictSchema>;

export const EngineeringStageSchema = z.object({
  stage: z.number().int().positive(), title: z.string(), goal: z.string().default(""),
});
export type EngineeringStage = z.infer<typeof EngineeringStageSchema>;

export const EngineeringConfigSchema = z.object({
  project_id: id, workspace_id: id, enabled: z.boolean().default(false),
  current_stage: z.number().int().positive().default(1), mode_summary: z.string().default(""),
  decider_member_ids: z.array(id).default([]), stages: z.array(EngineeringStageSchema).catch([]),
}).transform((v) => ({ projectId: v.project_id, workspaceId: v.workspace_id, enabled: v.enabled, currentStage: v.current_stage, modeSummary: v.mode_summary, deciderMemberIds: v.decider_member_ids, stages: v.stages }));

export const EngineeringOverviewSchema = z.object({
  engineering: EngineeringConfigSchema,
  chapters: z.array(z.unknown()).default([]),
});
export const EngineeringUpdatedSchema = z.object({ engineering: EngineeringConfigSchema });

export type EngineeringConfig = z.infer<typeof EngineeringConfigSchema>;
export type EngineeringOverview = z.infer<typeof EngineeringOverviewSchema>;
