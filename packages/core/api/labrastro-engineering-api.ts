import type { z } from "zod";
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import { BaselineDecisionSchema, BaselineHistorySchema, BaselineRevisionSchema, EngineeringOverviewSchema, EngineeringUpdatedSchema, type BaselineChapter, type EngineeringStageSchema } from "./labrastro-engineering-schemas";

export interface BaselineHistoryOptions {
  limit?: number;
  before?: number;
  /** false returns an empty contentMarkdown for list views that only need metadata and anchorsDiff. */
  withContent?: boolean;
}

const headers = (workspaceId: string) => ({ "X-Workspace-ID": workspaceId, "X-Workspace-Slug": "" });
const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const labrastroEngineeringApi = {
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
    enabled?: boolean; currentStage?: number; modeSummary?: string; deciderMemberIds?: string[]; stages?: z.input<typeof EngineeringStageSchema>[];
  }) {
    const endpoint = `${projectPath(projectId)}/engineering`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "PATCH", headers: headers(workspaceId), body: JSON.stringify({
      enabled: data.enabled, current_stage: data.currentStage, mode_summary: data.modeSummary, decider_member_ids: data.deciderMemberIds, stages: data.stages,
    }) });
    return parseWithFallback<z.infer<typeof EngineeringUpdatedSchema> | null>(raw, EngineeringUpdatedSchema, null, { endpoint });
  },
  async proposeProjectBaseline(this: ApiClient, workspaceId: string, projectId: string, data: {
    chapter: BaselineChapter; contentMarkdown: string; changeSummary: string; baseRevisionId: string | null; replacesCandidateId?: string; sourceIssueId?: string; section?: string; chapterTitle?: string; deleteSection?: boolean;
  }) {
    const endpoint = `${projectPath(projectId)}/baseline/candidates`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(workspaceId), body: JSON.stringify({
      section: data.section, chapter_title: data.chapterTitle, delete_section: data.deleteSection, chapter: data.chapter, content_markdown: data.contentMarkdown, change_summary: data.changeSummary, base_revision_id: data.baseRevisionId, replaces_candidate_id: data.replacesCandidateId, source_issue_id: data.sourceIssueId,
    }) });
    return parseWithFallback<z.infer<typeof BaselineRevisionSchema> | null>(raw, BaselineRevisionSchema, null, { endpoint });
  },
  async decideProjectBaseline(this: ApiClient, workspaceId: string, projectId: string, action: "adopt" | "reject", revisions: { revisionId: string; expectedAdoptedRevisionId: string | null }[], options: { annotationBatchAction?: "close" | "keep" } = {}) {
    const endpoint = `${projectPath(projectId)}/baseline/decisions`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(workspaceId), body: JSON.stringify({
      action,
      revisions: revisions.map((v) => ({ revision_id: v.revisionId, expected_adopted_revision_id: v.expectedAdoptedRevisionId })),
      ...(options.annotationBatchAction ? { annotation_batch_action: options.annotationBatchAction } : {}),
    }) });
    return parseWithFallback<z.infer<typeof BaselineDecisionSchema> | null>(raw, BaselineDecisionSchema, null, { endpoint });
  },
  async getProjectBaselineHistory(this: ApiClient, workspaceId: string, projectId: string, chapter: BaselineChapter, options: BaselineHistoryOptions = {}) {
    const query = new URLSearchParams({ chapter });
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.before !== undefined) query.set("before", String(options.before));
    if (options.withContent !== undefined) query.set("with_content", String(options.withContent));
    const endpoint = `${projectPath(projectId)}/baseline/revisions?${query}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof BaselineHistorySchema> | null>(raw, BaselineHistorySchema, null, { endpoint });
  },
};
export type LabrastroEngineeringApi = typeof labrastroEngineeringApi;
export function installLabrastroEngineeringApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroEngineeringApi);
}
