// Shared keys for engineering and baseline comment queries. Keep this module
// independent of the project query barrels to avoid initialization cycles.
import { issueKeys } from "../issues/queries";

export const engineeringProjectKeys = {
  wikiThreads: (wsId: string, projectId: string, pageId: string) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "threads", pageId] as const,
  wikiThread: (wsId: string, projectId: string, threadId: string) =>
    [...engineeringProjectKeys.wikiRoot(wsId, projectId), "thread", threadId] as const,
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
