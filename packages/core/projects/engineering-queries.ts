// Fork-owned engineering query keys and query options (engineering overview
// and the baseline wiki tree). Spread into `projectKeys` and re-exported from
// `./queries` so upstream files and existing views keep their import paths
// (see docs/engineering/upstream-sync-checklist.md).
//
// This module must not import `./queries`: queries.ts spreads
// engineeringProjectKeys into projectKeys, and a back-import would make module
// initialization order-dependent.

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, type WikiActivityItem } from "../api";
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

type ActivityCursor = { before?: string; overlapOf?: string; backfillAt?: string; newerPageIds?: string[] };
type ActivityPage = { id: string; slug: string; title: string; createdAt?: string };

const activityItemKey = (item: WikiActivityItem) => `${item.pageId}:${item.number}`;

function parseRfc3339Nano(timestamp: string): bigint {
  const fraction = /\.(\d{1,9})(?=Z$|[+-]\d{2}:\d{2}$)/.exec(timestamp);
  const seconds = Date.parse(fraction ? timestamp.replace(fraction[0], "") : timestamp);
  if (!Number.isFinite(seconds)) return 0n;
  return BigInt(seconds) * 1_000_000n + BigInt((fraction?.[1] ?? "").padEnd(9, "0"));
}

export function compareRfc3339Nano(a: string, b: string): number {
  const difference = parseRfc3339Nano(a) - parseRfc3339Nano(b);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function afterActivityTimestamp(timestamp: string): string {
  // The exclusive activity cursor is limited to PostgreSQL microsecond precision.
  const nextMicros = parseRfc3339Nano(timestamp) / 1_000n + 1n;
  const second = nextMicros >= 0n ? nextMicros / 1_000_000n : (nextMicros - 999_999n) / 1_000_000n;
  const utc = new Date(Number(second) * 1_000).toISOString().slice(0, -5);
  const fraction = (nextMicros - second * 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${utc}.${fraction}Z` : `${utc}Z`;
}

async function findActivityRevisions(wsId: string, projectId: string, page: ActivityPage, timestamp: string): Promise<WikiActivityItem[]> {
  const items: WikiActivityItem[] = [];
  let before: number | undefined;
  for (;;) {
    const history = await api.getProjectWikiPageHistory(wsId, projectId, page.slug, { limit: 200, before });
    if (!history) throw new Error("Unable to read Wiki page history");
    for (const revision of history.revisions) {
      if (compareRfc3339Nano(revision.createdAt, timestamp) !== 0) continue;
      items.push({
        pageId: page.id, slug: page.slug, title: page.title, kind: revision.revisionKind, number: revision.revisionNumber,
        createdAt: revision.createdAt, createdByType: revision.createdByType, createdById: revision.createdById,
        changeSummary: revision.changeSummary, sourceIssueId: revision.sourceIssueId,
      });
    }
    const oldest = history.revisions.at(-1)?.createdAt;
    if (!history.hasMore || !history.nextBefore || !oldest || compareRfc3339Nano(oldest, timestamp) < 0) return items;
    before = history.nextBefore;
  }
}

function nextActivityCursor(
  items: WikiActivityItem[],
  previousPages: readonly ({ items: WikiActivityItem[] } | null)[],
  cursor: ActivityCursor | undefined,
): ActivityCursor | undefined {
  const last = items.at(-1);
  if (!last) return undefined;

  const timestamp = last.createdAt;
  const before = afterActivityTimestamp(timestamp);
  const wouldRepeat = cursor?.before && compareRfc3339Nano(before, cursor.before) >= 0;
  const isOverlap = cursor?.overlapOf && compareRfc3339Nano(timestamp, cursor.overlapOf) === 0;
  const overlapCursor = { before, overlapOf: timestamp };
  if (!wouldRepeat && !isOverlap) return overlapCursor;

  const loaded = previousPages.flatMap((page) => page?.items ?? []);
  if (!wouldRepeat) {
    const loadedKeys = new Set(loaded.map(activityItemKey));
    if (items.some((item) => !loadedKeys.has(activityItemKey(item)))) return overlapCursor;
  }

  // Recover rows hidden by the per-request limit at this timestamp.
  const newerPageIds = new Set([...loaded, ...items]
    .filter((item) => item.kind === "create" && compareRfc3339Nano(item.createdAt, timestamp) > 0)
    .map((item) => item.pageId));
  return { backfillAt: timestamp, newerPageIds: [...newerPageIds] };
}

export function projectWikiActivityInfiniteOptions(
  wsId: string,
  projectId: string,
  limit = 50,
  pages?: readonly ActivityPage[],
) {
  return infiniteQueryOptions({
    queryKey: [...engineeringProjectKeys.wikiActivity(wsId, projectId, { limit }), "infinite"],
    queryFn: async ({ pageParam, client }) => {
      if (!pageParam?.backfillAt) {
        return api.getProjectWikiActivity(wsId, projectId, { limit, before: pageParam?.before });
      }
      const timestamp = pageParam.backfillAt;
      const inventory = pages ?? (await client.fetchQuery(projectWikiTreeOptions(wsId, projectId, false)))?.pages;
      if (!inventory) throw new Error("Unable to read Wiki page tree");
      const newerPageIds = new Set(pageParam.newerPageIds);
      const eligible = inventory.filter((page) =>
        !newerPageIds.has(page.id) && (!page.createdAt || compareRfc3339Nano(page.createdAt, timestamp) <= 0),
      );
      const histories = await Promise.all(eligible.map((page) => findActivityRevisions(wsId, projectId, page, timestamp)));
      return { items: histories.flat() };
    },
    initialPageParam: undefined as ActivityCursor | undefined,
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      if (lastPageParam?.backfillAt) return { before: lastPageParam.backfillAt };
      const items = lastPage?.items ?? [];
      if (items.length < limit) return undefined;
      return nextActivityCursor(items, allPages.slice(0, -1), lastPageParam);
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
