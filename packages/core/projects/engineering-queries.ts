// Fork-owned engineering query keys and query options (engineering overview,
// baseline wiki, baseline annotations). Spread into `projectKeys` and
// re-exported from `./queries` so upstream files and existing views keep their
// import paths (see docs/engineering/upstream-sync-checklist.md).
//
// This module must not import `./queries`: queries.ts spreads
// engineeringProjectKeys into projectKeys, and a back-import would make module
// initialization order-dependent. baselineAnnotationsAll therefore re-creates
// the projects/{wsId}/detail/{id} prefix by value; queries.test.ts pins it to
// projectKeys.detail so an upstream key reshape cannot pass silently.

import { queryOptions } from "@tanstack/react-query";
import {
  api,
  type BaselineChapter,
  type BaselineHistoryOptions,
  type GetProjectBaselineAnnotationBatchOptions,
  type GetProjectBaselineAnnotationBatchesOptions,
} from "../api";
import { issueKeys } from "../issues/queries";

export const engineeringProjectKeys = {
  baselineAnnotationsAll: (wsId: string, projectId: string) =>
    ["projects", wsId, "detail", projectId, "baseline-annotations"] as const,
  baselineAnnotationBatches: (
    wsId: string,
    projectId: string,
    options: GetProjectBaselineAnnotationBatchesOptions = {},
  ) => [...engineeringProjectKeys.baselineAnnotationsAll(wsId, projectId), "batches", options] as const,
  baselineAnnotationBatch: (
    wsId: string,
    projectId: string,
    batchId: string,
    options: GetProjectBaselineAnnotationBatchOptions = {},
  ) => [...engineeringProjectKeys.baselineAnnotationsAll(wsId, projectId), "batch", batchId, options] as const,
  // Rooted outside projects/{wsId}: issue and project events invalidate that
  // prefix, and engineering reads carry every chapter body. They refresh via
  // their own realtime events, mutations and reconnect instead.
  engineeringRoot: (wsId: string) => ["project-engineering", wsId] as const,
  engineeringAll: (wsId: string, projectId: string) =>
    [...engineeringProjectKeys.engineeringRoot(wsId), projectId] as const,
  engineering: (wsId: string, projectId: string) =>
    [...engineeringProjectKeys.engineeringAll(wsId, projectId), "overview"] as const,
  engineeringConfig: (wsId: string, projectId: string) =>
    [...engineeringProjectKeys.engineeringAll(wsId, projectId), "config"] as const,
  engineeringHistoryAll: (wsId: string, projectId: string) =>
    [...engineeringProjectKeys.engineeringAll(wsId, projectId), "history"] as const,
  engineeringHistory: (
    wsId: string,
    projectId: string,
    chapter: BaselineChapter,
    options: BaselineHistoryOptions,
  ) =>
    [...engineeringProjectKeys.engineeringHistoryAll(wsId, projectId), chapter, options] as const,
  engineeringDecisionIssuesAll: (wsId: string, projectId: string) =>
    [...issueKeys.all(wsId), "engineering-decisions", projectId] as const,
  engineeringDecisionIssues: (wsId: string, projectId: string, deciderMemberId: string) =>
    [...engineeringProjectKeys.engineeringDecisionIssuesAll(wsId, projectId), deciderMemberId] as const,
};

export function projectEngineeringOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: engineeringProjectKeys.engineering(wsId, projectId),
    queryFn: () => api.getProjectEngineering(wsId, projectId),
  });
}

/** Configuration only, for entry points that never render the baseline. */
export function projectEngineeringConfigOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: engineeringProjectKeys.engineeringConfig(wsId, projectId),
    queryFn: () => api.getProjectEngineeringConfig(wsId, projectId),
  });
}

export function projectBaselineHistoryOptions(
  wsId: string,
  projectId: string,
  chapter: BaselineChapter,
  options: BaselineHistoryOptions = {},
) {
  return queryOptions({
    queryKey: engineeringProjectKeys.engineeringHistory(wsId, projectId, chapter, options),
    queryFn: () => api.getProjectBaselineHistory(wsId, projectId, chapter, options),
  });
}

export function projectBaselineAnnotationBatchesOptions(
  wsId: string,
  projectId: string,
  options: GetProjectBaselineAnnotationBatchesOptions = {},
) {
  return queryOptions({
    queryKey: engineeringProjectKeys.baselineAnnotationBatches(wsId, projectId, options),
    queryFn: () => api.getProjectBaselineAnnotationBatches(wsId, projectId, options),
  });
}

export function projectBaselineAnnotationBatchOptions(
  wsId: string,
  projectId: string,
  batchId: string,
  options: GetProjectBaselineAnnotationBatchOptions = {},
) {
  const query = { state: options.state ?? "all", withSections: options.withSections ?? false } as const;
  return queryOptions({
    queryKey: engineeringProjectKeys.baselineAnnotationBatch(wsId, projectId, batchId, query),
    queryFn: () => api.getProjectBaselineAnnotationBatch(wsId, projectId, batchId, query),
  });
}

export function projectEngineeringDecisionIssuesOptions(
  wsId: string,
  projectId: string,
  deciderMemberId: string,
) {
  return queryOptions({
    queryKey: engineeringProjectKeys.engineeringDecisionIssues(wsId, projectId, deciderMemberId),
    queryFn: () => api.listIssues({
      workspace_id: wsId,
      project_id: projectId,
      statuses: ["blocked"],
      assignee_types: ["member"],
      assignee_ids: [deciderMemberId],
    }),
    select: (data) => data.issues,
    enabled: Boolean(wsId && projectId && deciderMemberId),
  });
}
