import type { z } from "zod";
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import type { BaselineChapter } from "./labrastro-engineering-schemas";
import {
  BaselineAnnotationBatchClosedSchema,
  BaselineAnnotationBatchesSchema,
  BaselineAnnotationDetailSchema,
  BaselineAnnotationsUpdatedSchema,
  BaselineReviewSubmittedSchema,
} from "./labrastro-baseline-annotation-schemas";

export type BaselineAnnotationBatchListState = "active" | "open" | "closed" | "all";
export type BaselineAnnotationDetailState = "open" | "all";

export interface GetProjectBaselineAnnotationBatchesOptions {
  chapter?: BaselineChapter;
  state?: BaselineAnnotationBatchListState;
  issueId?: string;
}

export interface GetProjectBaselineAnnotationBatchOptions {
  state?: BaselineAnnotationDetailState;
  withSections?: boolean;
}

export interface BaselineReviewAnnotationInput {
  anchorKind: "text" | "lines" | "section";
  targetRevisionId: string;
  parentAnnotationId?: string;
  sectionAnchor: string;
  sectionTitle: string;
  lineStart?: number;
  lineEnd?: number;
  quote?: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  note: string;
}

export interface SubmitProjectBaselineReviewInput {
  clientKey: string;
  chapter: BaselineChapter;
  reviewedRevisionId: string;
  assignee?: { type: "agent"; id: string };
  summary?: string;
  annotations: BaselineReviewAnnotationInput[];
}

export interface ResolveProjectBaselineAnnotationsInput {
  annotationIds: string[];
  resolved: boolean;
}

const headers = (workspaceId: string) => ({ "X-Workspace-ID": workspaceId, "X-Workspace-Slug": "" });
const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/baseline`;

const labrastroBaselineAnnotationApi = {
  async getProjectBaselineAnnotationBatches(
    this: ApiClient,
    workspaceId: string,
    projectId: string,
    options: GetProjectBaselineAnnotationBatchesOptions = {},
  ) {
    const query = new URLSearchParams();
    if (options.chapter) query.set("chapter", options.chapter);
    if (options.state) query.set("state", options.state);
    if (options.issueId) query.set("issue_id", options.issueId);
    const suffix = query.toString();
    const endpoint = `${projectPath(projectId)}/annotation-batches${suffix ? `?${suffix}` : ""}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof BaselineAnnotationBatchesSchema> | null>(raw, BaselineAnnotationBatchesSchema, null, { endpoint });
  },

  async getProjectBaselineAnnotationBatch(
    this: ApiClient,
    workspaceId: string,
    projectId: string,
    batchId: string,
    options: GetProjectBaselineAnnotationBatchOptions = {},
  ) {
    const query = new URLSearchParams();
    if (options.state) query.set("state", options.state);
    if (options.withSections !== undefined) query.set("with_sections", String(options.withSections));
    const suffix = query.toString();
    const endpoint = `${projectPath(projectId)}/annotation-batches/${encodeURIComponent(batchId)}${suffix ? `?${suffix}` : ""}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof BaselineAnnotationDetailSchema> | null>(raw, BaselineAnnotationDetailSchema, null, { endpoint });
  },

  async submitProjectBaselineReview(
    this: ApiClient,
    workspaceId: string,
    projectId: string,
    data: SubmitProjectBaselineReviewInput,
  ) {
    const endpoint = `${projectPath(projectId)}/reviews`;
    const raw = await clientFetch<unknown>(this, endpoint, {
      method: "POST",
      headers: headers(workspaceId),
      body: JSON.stringify({
        client_key: data.clientKey,
        chapter: data.chapter,
        reviewed_revision_id: data.reviewedRevisionId,
        assignee: data.assignee,
        summary: data.summary,
        annotations: data.annotations.map((annotation) => ({
          anchor_kind: annotation.anchorKind,
          target_revision_id: annotation.targetRevisionId,
          parent_annotation_id: annotation.parentAnnotationId,
          section_anchor: annotation.sectionAnchor,
          section_title: annotation.sectionTitle,
          line_start: annotation.lineStart,
          line_end: annotation.lineEnd,
          quote: annotation.quote,
          prefix: annotation.prefix,
          suffix: annotation.suffix,
          start: annotation.start,
          note: annotation.note,
        })),
      }),
    });
    return parseWithFallback<z.infer<typeof BaselineReviewSubmittedSchema> | null>(raw, BaselineReviewSubmittedSchema, null, { endpoint });
  },

  async resolveProjectBaselineAnnotations(
    this: ApiClient,
    workspaceId: string,
    projectId: string,
    data: ResolveProjectBaselineAnnotationsInput,
  ) {
    const endpoint = `${projectPath(projectId)}/annotations/resolve`;
    const raw = await clientFetch<unknown>(this, endpoint, {
      method: "POST",
      headers: headers(workspaceId),
      body: JSON.stringify({ annotation_ids: data.annotationIds, resolved: data.resolved }),
    });
    return parseWithFallback<z.infer<typeof BaselineAnnotationsUpdatedSchema> | null>(raw, BaselineAnnotationsUpdatedSchema, null, { endpoint });
  },

  async closeProjectBaselineAnnotationBatch(
    this: ApiClient,
    workspaceId: string,
    projectId: string,
    batchId: string,
  ) {
    const endpoint = `${projectPath(projectId)}/annotation-batches/${encodeURIComponent(batchId)}/close`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(workspaceId) });
    return parseWithFallback<z.infer<typeof BaselineAnnotationBatchClosedSchema> | null>(raw, BaselineAnnotationBatchClosedSchema, null, { endpoint });
  },
};

export type LabrastroBaselineAnnotationApi = typeof labrastroBaselineAnnotationApi;

export function installLabrastroBaselineAnnotationApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroBaselineAnnotationApi);
}
