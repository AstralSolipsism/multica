import { queryOptions } from "@tanstack/react-query";
import {
  api,
  type BaselineChapter,
  type BaselineHistoryOptions,
  type GetProjectBaselineAnnotationBatchOptions,
  type GetProjectBaselineAnnotationBatchesOptions,
} from "../api";
import { issueKeys } from "../issues/queries";

export const projectKeys = {
  all: (wsId: string) => ["projects", wsId] as const,
  list: (wsId: string) => [...projectKeys.all(wsId), "list"] as const,
  detail: (wsId: string, id: string) =>
    [...projectKeys.all(wsId), "detail", id] as const,
  baselineAnnotationsAll: (wsId: string, projectId: string) =>
    [...projectKeys.detail(wsId, projectId), "baseline-annotations"] as const,
  baselineAnnotationBatches: (
    wsId: string,
    projectId: string,
    options: GetProjectBaselineAnnotationBatchesOptions = {},
  ) => [...projectKeys.baselineAnnotationsAll(wsId, projectId), "batches", options] as const,
  baselineAnnotationBatch: (
    wsId: string,
    projectId: string,
    batchId: string,
    options: GetProjectBaselineAnnotationBatchOptions = {},
  ) => [...projectKeys.baselineAnnotationsAll(wsId, projectId), "batch", batchId, options] as const,
  // Rooted outside projects/{wsId}: issue and project events invalidate that
  // prefix, and engineering reads carry every chapter body. They refresh via
  // their own realtime events, mutations and reconnect instead.
  engineeringRoot: (wsId: string) => ["project-engineering", wsId] as const,
  engineeringAll: (wsId: string, projectId: string) =>
    [...projectKeys.engineeringRoot(wsId), projectId] as const,
  engineering: (wsId: string, projectId: string) =>
    [...projectKeys.engineeringAll(wsId, projectId), "overview"] as const,
  engineeringConfig: (wsId: string, projectId: string) =>
    [...projectKeys.engineeringAll(wsId, projectId), "config"] as const,
  engineeringHistoryAll: (wsId: string, projectId: string) =>
    [...projectKeys.engineeringAll(wsId, projectId), "history"] as const,
  engineeringHistory: (
    wsId: string,
    projectId: string,
    chapter: BaselineChapter,
    options: BaselineHistoryOptions,
  ) =>
    [...projectKeys.engineeringHistoryAll(wsId, projectId), chapter, options] as const,
  engineeringDecisionIssuesAll: (wsId: string, projectId: string) =>
    [...issueKeys.all(wsId), "engineering-decisions", projectId] as const,
  engineeringDecisionIssues: (wsId: string, projectId: string, deciderMemberId: string) =>
    [...projectKeys.engineeringDecisionIssuesAll(wsId, projectId), deciderMemberId] as const,
};

export function projectListOptions(wsId: string) {
  return queryOptions({
    queryKey: projectKeys.list(wsId),
    queryFn: () => api.listProjects(),
    select: (data) => data.projects,
  });
}

export function projectDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: projectKeys.detail(wsId, id),
    queryFn: () => api.getProject(id),
  });
}

export function projectEngineeringOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: projectKeys.engineering(wsId, projectId),
    queryFn: () => api.getProjectEngineering(wsId, projectId),
  });
}

/** Configuration only, for entry points that never render the baseline. */
export function projectEngineeringConfigOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: projectKeys.engineeringConfig(wsId, projectId),
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
    queryKey: projectKeys.engineeringHistory(wsId, projectId, chapter, options),
    queryFn: () => api.getProjectBaselineHistory(wsId, projectId, chapter, options),
  });
}

export function projectBaselineAnnotationBatchesOptions(
  wsId: string,
  projectId: string,
  options: GetProjectBaselineAnnotationBatchesOptions = {},
) {
  return queryOptions({
    queryKey: projectKeys.baselineAnnotationBatches(wsId, projectId, options),
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
    queryKey: projectKeys.baselineAnnotationBatch(wsId, projectId, batchId, query),
    queryFn: () => api.getProjectBaselineAnnotationBatch(wsId, projectId, batchId, query),
  });
}

export function projectEngineeringDecisionIssuesOptions(
  wsId: string,
  projectId: string,
  deciderMemberId: string,
) {
  return queryOptions({
    queryKey: projectKeys.engineeringDecisionIssues(wsId, projectId, deciderMemberId),
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
