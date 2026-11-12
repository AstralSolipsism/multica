// Fork-owned engineering query keys and query options (engineering overview
// and the baseline wiki tree). Spread into `projectKeys` and re-exported from
// `./queries` so upstream files and existing views keep their import paths
// (see docs/engineering/upstream-sync-checklist.md).
//
// This module must not import `./queries`: queries.ts spreads
// engineeringProjectKeys into projectKeys, and a back-import would make module
// initialization order-dependent.

import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "../issues/queries";

export const engineeringProjectKeys = {
  wikiRoot: (wsId: string, projectId: string) =>
    ["project-engineering", wsId, projectId, "wiki"] as const,
  wikiTree: (wsId: string, projectId: string, sections: boolean) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "tree", sections] as const,
  wikiPageAll: (wsId: string, projectId: string, page: string) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "page", page] as const,
  wikiPage: (wsId: string, projectId: string, page: string, options: Record<string, unknown>) =>
    [...engineeringProjectKeys.wikiPageAll(wsId, projectId, page), options] as const,
  wikiHistoryAll: (wsId: string, projectId: string, page: string) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "history", page] as const,
  wikiHistory: (wsId: string, projectId: string, page: string, options: Record<string, unknown>) =>
    [...engineeringProjectKeys.wikiHistoryAll(wsId, projectId, page), options] as const,
  wikiActivity: (wsId: string, projectId: string, options: Record<string, unknown>) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "activity", options] as const,
  wikiDiff: (wsId: string, projectId: string, page: string, from: number, to?: number) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "diff", page, from, to ?? "current"] as const,
  wikiSearch: (wsId: string, projectId: string, q: string) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "search", q] as const,
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

export function projectWikiTreeOptions(wsId: string, projectId: string, sections = false) {
  return queryOptions({
    queryKey: engineeringProjectKeys.wikiTree(wsId, projectId, sections),
    queryFn: () => api.getProjectWikiTree(wsId, projectId, { sections }),
  });
}

export function projectWikiPageOptions(
  wsId: string,
  projectId: string,
  page: string,
  options: { revision?: number; section?: string; with?: ("links" | "backlinks" | "related_issues")[] } = {},
) {
  return queryOptions({
    queryKey: engineeringProjectKeys.wikiPage(wsId, projectId, page, options as Record<string, unknown>),
    queryFn: () => api.getProjectWikiPage(wsId, projectId, page, options),
  });
}

export function projectWikiHistoryOptions(wsId: string, projectId: string, page: string, options: { limit?: number; before?: number } = {}) {
  return queryOptions({
    queryKey: engineeringProjectKeys.wikiHistory(wsId, projectId, page, options as Record<string, unknown>),
    queryFn: () => api.getProjectWikiPageHistory(wsId, projectId, page, options),
  });
}

export function projectWikiRevisionOptions(wsId: string, projectId: string, page: string, revision: number) {
  return queryOptions({
    queryKey: [...engineeringProjectKeys.wikiPageAll(wsId, projectId, page), "revision", revision],
    queryFn: () => api.getProjectWikiPageRevision(wsId, projectId, page, revision),
  });
}

export function projectWikiDiffOptions(wsId: string, projectId: string, page: string, from: number, to?: number) {
  return queryOptions({
    queryKey: engineeringProjectKeys.wikiDiff(wsId, projectId, page, from, to),
    queryFn: () => api.diffProjectWikiPage(wsId, projectId, page, { from, to }),
  });
}

export function projectWikiActivityOptions(wsId: string, projectId: string, options: { limit?: number; before?: string } = {}) {
  return queryOptions({
    queryKey: engineeringProjectKeys.wikiActivity(wsId, projectId, options as Record<string, unknown>),
    queryFn: () => api.getProjectWikiActivity(wsId, projectId, options),
  });
}

export function projectWikiSearchOptions(wsId: string, projectId: string, q: string, limit?: number) {
  return queryOptions({
    queryKey: engineeringProjectKeys.wikiSearch(wsId, projectId, q),
    queryFn: () => api.searchProjectWiki(wsId, projectId, q, { limit }),
  });
}
