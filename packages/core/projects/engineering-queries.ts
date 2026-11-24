// Fork-owned engineering query keys and query options (engineering overview
// and the baseline wiki tree). Spread into `projectKeys` and re-exported from
// `./queries` so upstream files and existing views keep their import paths
// (see docs/engineering/upstream-sync-checklist.md).
//
// This module must not import `./queries`: queries.ts spreads
// engineeringProjectKeys into projectKeys, and a back-import would make module
// initialization order-dependent.

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { engineeringProjectKeys } from "./engineering-query-keys";

export { engineeringProjectKeys } from "./engineering-query-keys";

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

export function projectEngineeringDecisionIssuesOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: engineeringProjectKeys.engineeringDecisionIssues(wsId, projectId),
    queryFn: async () => {
      const issues = [];
      let total = 0;
      for (;;) {
        const response = await api.listIssues({
          workspace_id: wsId,
          project_id: projectId,
          statuses: ["blocked"],
          limit: 100,
          offset: issues.length,
        });
        total = response.total;
        if (!response.issues.length) break;
        issues.push(...response.issues);
        if (issues.length >= total) break;
      }
      return { issues, total };
    },
    select: (data) => data.issues,
    enabled: Boolean(wsId && projectId),
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

export function projectWikiActivityInfiniteOptions(wsId: string, projectId: string, limit = 50) {
  return infiniteQueryOptions({
    queryKey: [...engineeringProjectKeys.wikiActivity(wsId, projectId, { limit }), "infinite"],
    queryFn: ({ pageParam }) => api.getProjectWikiActivity(wsId, projectId, { limit, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      const items = lastPage?.items ?? [];
      return items.length === limit ? items.at(-1)?.createdAt : undefined;
    },
  });
}

export function projectWikiSearchOptions(wsId: string, projectId: string, q: string, limit?: number) {
  return queryOptions({
    queryKey: engineeringProjectKeys.wikiSearch(wsId, projectId, q),
    queryFn: () => api.searchProjectWiki(wsId, projectId, q, { limit }),
  });
}

export * from "./baseline-comment-queries";
export * from "./baseline-comment-anchors";
