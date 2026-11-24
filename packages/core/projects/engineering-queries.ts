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

type ActivityCursor = { before?: string; overlapOf?: string; backfillAt?: string };

const activityItemKey = (item: { pageId: string; number: number }) => `${item.pageId}:${item.number}`;
const afterActivityTimestamp = (timestamp: string) => new Date(Date.parse(timestamp) + 1).toISOString();

export function projectWikiActivityInfiniteOptions(
  wsId: string,
  projectId: string,
  limit = 50,
  pages: readonly { id: string; slug: string; title: string }[] = [],
) {
  return infiniteQueryOptions({
    queryKey: [...engineeringProjectKeys.wikiActivity(wsId, projectId, { limit }), "infinite"],
    queryFn: async ({ pageParam }: { pageParam: ActivityCursor | undefined }) => {
      if (!pageParam?.backfillAt) {
        return api.getProjectWikiActivity(wsId, projectId, { limit, before: pageParam?.before });
      }
      const timestamp = pageParam.backfillAt;
      const histories = await Promise.all(pages.map(async (page) => {
        const matches = [];
        let before: number | undefined;
        for (;;) {
          const history = await api.getProjectWikiPageHistory(wsId, projectId, page.slug, { limit: 200, before });
          const revisions = history?.revisions ?? [];
          for (const revision of revisions) if (revision.createdAt === timestamp) matches.push(revision);
          const oldest = revisions.at(-1)?.createdAt;
          if (!history?.hasMore || !oldest || oldest <= timestamp) break;
          before = history.nextBefore ?? undefined;
          if (!before) break;
        }
        return matches.map((revision) => ({
          pageId: page.id, slug: page.slug, title: page.title, kind: revision.revisionKind, number: revision.revisionNumber,
          createdAt: revision.createdAt, createdByType: revision.createdByType, createdById: revision.createdById,
          changeSummary: revision.changeSummary, sourceIssueId: revision.sourceIssueId,
        }));
      }));
      return { items: histories.flat() };
    },
    initialPageParam: undefined as ActivityCursor | undefined,
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      if (lastPageParam?.backfillAt) return { before: lastPageParam.backfillAt };
      const items = lastPage?.items ?? [];
      if (items.length < limit) return undefined;
      const last = items.at(-1);
      if (!last) return undefined;
      if (lastPageParam?.overlapOf === last.createdAt) {
        const previous = new Set(allPages.slice(0, -1).flatMap((page) => (page?.items ?? []).map(activityItemKey)));
        if (!items.some((item) => !previous.has(activityItemKey(item)))) {
          // A full overlap with no new key means at least 50 rows share this
          // timestamp. Reconcile just that transaction through page histories,
          // then continue strictly before it instead of looping forever.
          return { backfillAt: last.createdAt };
        }
      }
      return { before: afterActivityTimestamp(last.createdAt), overlapOf: last.createdAt };
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
