import { queryOptions } from "@tanstack/react-query";
import { api, type BaselineChapter } from "../api";
import { issueKeys } from "../issues/queries";

export const projectKeys = {
  all: (wsId: string) => ["projects", wsId] as const,
  list: (wsId: string) => [...projectKeys.all(wsId), "list"] as const,
  detail: (wsId: string, id: string) =>
    [...projectKeys.all(wsId), "detail", id] as const,
  engineeringAll: (wsId: string, projectId: string) =>
    [...projectKeys.detail(wsId, projectId), "engineering"] as const,
  engineering: (wsId: string, projectId: string) =>
    [...projectKeys.engineeringAll(wsId, projectId), "overview"] as const,
  engineeringHistoryAll: (wsId: string, projectId: string) =>
    [...projectKeys.engineeringAll(wsId, projectId), "history"] as const,
  engineeringHistory: (
    wsId: string,
    projectId: string,
    chapter: BaselineChapter,
    options: { limit?: number; before?: number },
  ) =>
    [...projectKeys.engineeringHistoryAll(wsId, projectId), chapter, options] as const,
  engineeringHistoryDiff: (
    wsId: string,
    projectId: string,
    chapter: BaselineChapter,
    from: number,
    to: number,
  ) =>
    [...projectKeys.engineeringHistoryAll(wsId, projectId), chapter, "diff", from, to] as const,
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

export function projectBaselineHistoryOptions(
  wsId: string,
  projectId: string,
  chapter: BaselineChapter,
  options: { limit?: number; before?: number } = {},
) {
  return queryOptions({
    queryKey: projectKeys.engineeringHistory(wsId, projectId, chapter, options),
    queryFn: () => api.getProjectBaselineHistory(wsId, projectId, chapter, options),
  });
}

export function projectBaselineDiffOptions(
  wsId: string,
  projectId: string,
  chapter: BaselineChapter,
  from: number,
  to: number,
) {
  return queryOptions({
    queryKey: projectKeys.engineeringHistoryDiff(wsId, projectId, chapter, from, to),
    queryFn: () => api.diffProjectBaselineHistory(wsId, projectId, chapter, from, to),
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
