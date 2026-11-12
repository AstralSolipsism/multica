import { z } from "zod";
import { labrastroBaselineCommentApi } from "./labrastro-baseline-comment-api";
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import {
  EngineeringOverviewSchema, EngineeringUpdatedSchema, WikiArchiveResultSchema, WikiActivityItemSchema, WikiDiffSchema,
  WikiHistorySchema, WikiPageReadSchema, WikiSearchHitSchema, WikiTreeSchema, WikiWriteResultSchema,
  WikiBacklinkSchema,
} from "./labrastro-engineering-schemas";

const headers = (workspaceId: string) => ({ "X-Workspace-ID": workspaceId, "X-Workspace-Slug": "" });
const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const baselinePath = (projectId: string) => `${projectPath(projectId)}/baseline`;

const labrastroEngineeringApi = {
 ...labrastroBaselineCommentApi,
  async getProjectEngineering(this: ApiClient, workspaceId: string, projectId: string) {
    const endpoint = `${projectPath(projectId)}/engineering`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof EngineeringOverviewSchema> | null>(raw, EngineeringOverviewSchema, null, { endpoint });
  },
  async getProjectEngineeringConfig(this: ApiClient, workspaceId: string, projectId: string) {
    const endpoint = `${projectPath(projectId)}/engineering?with_chapters=false`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof EngineeringUpdatedSchema> | null>(raw, EngineeringUpdatedSchema, null, { endpoint });
  },
  async updateProjectEngineering(this: ApiClient, workspaceId: string, projectId: string, data: {
    enabled?: boolean; currentStage?: number; modeSummary?: string; deciderMemberIds?: string[]; stages?: { stage: number; title: string; goal?: string }[];
  }) {
    const endpoint = `${projectPath(projectId)}/engineering`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "PATCH", headers: headers(workspaceId), body: JSON.stringify({
      enabled: data.enabled, current_stage: data.currentStage, mode_summary: data.modeSummary, decider_member_ids: data.deciderMemberIds,
      stages: data.stages?.map((stage) => ({ stage: stage.stage, title: stage.title, goal: stage.goal ?? "" })),
    }) });
    return parseWithFallback<z.infer<typeof EngineeringUpdatedSchema> | null>(raw, EngineeringUpdatedSchema, null, { endpoint });
  },

  async getProjectWikiTree(this: ApiClient, workspaceId: string, projectId: string, options: { sections?: boolean } = {}) {
    const query = new URLSearchParams();
    if (options.sections !== undefined) query.set("sections", String(options.sections));
    const endpoint = `${baselinePath(projectId)}/tree?${query}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof WikiTreeSchema> | null>(raw, WikiTreeSchema, null, { endpoint });
  },
  async getProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, options: {
    revision?: number; section?: string; with?: ("links" | "backlinks" | "related_issues")[];
  } = {}) {
    const query = new URLSearchParams();
    if (options.revision !== undefined) query.set("revision", String(options.revision));
    if (options.section !== undefined) query.set("section", options.section);
    if (options.with?.length) query.set("with", options.with.join(","));
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}?${query}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof WikiPageReadSchema> | null>(raw, WikiPageReadSchema, null, { endpoint });
  },
  async createProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, data: {
    title: string; slug?: string; parent?: string; after?: string; contentMarkdown?: string; changeSummary?: string; sourceIssueId?: string;
  }) {
    const endpoint = `${baselinePath(projectId)}/pages`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(workspaceId), body: JSON.stringify({
      title: data.title, slug: data.slug, parent: data.parent, after: data.after,
      content_markdown: data.contentMarkdown, change_summary: data.changeSummary, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof WikiWriteResultSchema> | null>(raw, WikiWriteResultSchema, null, { endpoint });
  },
  async writeProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, data: {
    baseRevisionNumber: number; contentMarkdown?: string; section?: string; deleteSection?: string; changeSummary?: string; sourceIssueId?: string;
  }) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/content`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "PUT", headers: headers(workspaceId), body: JSON.stringify({
      base_revision_number: data.baseRevisionNumber, content_markdown: data.contentMarkdown,
      section: data.section, delete_section: data.deleteSection, change_summary: data.changeSummary, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof WikiWriteResultSchema> | null>(raw, WikiWriteResultSchema, null, { endpoint });
  },
  async renameProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, data: {
    baseRevisionNumber: number; title?: string; slug?: string; changeSummary?: string; sourceIssueId?: string;
  }) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "PATCH", headers: headers(workspaceId), body: JSON.stringify({
      base_revision_number: data.baseRevisionNumber, title: data.title, slug: data.slug,
      change_summary: data.changeSummary, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof WikiWriteResultSchema> | null>(raw, WikiWriteResultSchema, null, { endpoint });
  },
  async moveProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, data: {
    baseRevisionNumber: number; parent?: string | null; after?: string; changeSummary?: string; sourceIssueId?: string;
  }) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "PATCH", headers: headers(workspaceId), body: JSON.stringify({
      base_revision_number: data.baseRevisionNumber, parent: data.parent, after: data.after,
      change_summary: data.changeSummary, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof WikiWriteResultSchema> | null>(raw, WikiWriteResultSchema, null, { endpoint });
  },
  async archiveProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, data: {
    baseRevisionNumber: number; recursive?: boolean; changeSummary?: string; sourceIssueId?: string;
  }) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/archive`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(workspaceId), body: JSON.stringify({
      base_revision_number: data.baseRevisionNumber, recursive: data.recursive, change_summary: data.changeSummary, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof WikiArchiveResultSchema> | null>(raw, WikiArchiveResultSchema, null, { endpoint });
  },
  async restoreProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, data: {
    baseRevisionNumber: number; recursive?: boolean; parent?: string; changeSummary?: string; sourceIssueId?: string;
  }) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/restore`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(workspaceId), body: JSON.stringify({
      base_revision_number: data.baseRevisionNumber, recursive: data.recursive, parent: data.parent, change_summary: data.changeSummary, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof WikiArchiveResultSchema> | null>(raw, WikiArchiveResultSchema, null, { endpoint });
  },
  async getProjectWikiPageHistory(this: ApiClient, workspaceId: string, projectId: string, page: string, options: { limit?: number; before?: number } = {}) {
    const query = new URLSearchParams({ with_content: "false" });
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.before !== undefined) query.set("before", String(options.before));
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/revisions?${query}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof WikiHistorySchema> | null>(raw, WikiHistorySchema, null, { endpoint });
  },
  async getProjectWikiPageRevision(this: ApiClient, workspaceId: string, projectId: string, page: string, revision: number) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/revisions/${revision}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof WikiPageReadSchema> | null>(raw, WikiPageReadSchema, null, { endpoint });
  },
  async diffProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, options: { from: number; to?: number }) {
    const query = new URLSearchParams({ from: String(options.from) });
    if (options.to !== undefined) query.set("to", String(options.to));
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/diff?${query}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof WikiDiffSchema> | null>(raw, WikiDiffSchema, null, { endpoint });
  },
  async rollbackProjectWikiPage(this: ApiClient, workspaceId: string, projectId: string, page: string, data: {
    revisionNumber: number; baseRevisionNumber: number; contentOnly?: boolean; changeSummary?: string; sourceIssueId?: string;
  }) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/rollback`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(workspaceId), body: JSON.stringify({
      revision_number: data.revisionNumber, base_revision_number: data.baseRevisionNumber,
      content_only: data.contentOnly, change_summary: data.changeSummary, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof WikiWriteResultSchema> | null>(raw, WikiWriteResultSchema, null, { endpoint });
  },
  async getProjectWikiActivity(this: ApiClient, workspaceId: string, projectId: string, options: { limit?: number; before?: string } = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.before !== undefined) query.set("before", options.before);
    const endpoint = `${baselinePath(projectId)}/activity?${query}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<{ items: z.infer<typeof WikiActivityItemSchema>[] } | null>(raw, z.object({ items: z.array(WikiActivityItemSchema) }), null, { endpoint });
  },
  async searchProjectWiki(this: ApiClient, workspaceId: string, projectId: string, q: string, options: { limit?: number } = {}) {
    const query = new URLSearchParams({ q });
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const endpoint = `${baselinePath(projectId)}/search?${query}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<{ results: z.infer<typeof WikiSearchHitSchema>[] } | null>(raw, z.object({ results: z.array(WikiSearchHitSchema) }), null, { endpoint });
  },
  async getProjectWikiBacklinks(this: ApiClient, workspaceId: string, projectId: string, page: string) {
    const endpoint = `${baselinePath(projectId)}/pages/${encodeURIComponent(page)}/backlinks`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<{ backlinks: z.infer<typeof WikiBacklinkSchema>[] } | null>(raw, z.object({ backlinks: z.array(WikiBacklinkSchema) }), null, { endpoint });
  },
};
export type LabrastroEngineeringApi = typeof labrastroEngineeringApi;
export function installLabrastroEngineeringApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroEngineeringApi);
}
