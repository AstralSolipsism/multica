import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { IssuePullRequestSummary } from "../types";

export const githubKeys = {
  all: (wsId: string) => ["github", wsId] as const,
  installations: (wsId: string) => [...githubKeys.all(wsId), "installations"] as const,
  appInstallations: (wsId: string) => [...githubKeys.all(wsId), "app-installations"] as const,
  repositories: (wsId: string, installationId: string) =>
    [...githubKeys.all(wsId), "installations", installationId, "repositories"] as const,
  pullRequests: (issueId: string) => ["github", "pull-requests", issueId] as const,
  /** Under the same prefix as `pullRequests`, so every `pull_request` realtime
   *  event and link/unlink refreshes the issue views' PR chips too. */
  pullRequestSummaries: (wsId: string) => ["github", "pull-requests", "summaries", wsId] as const,
};

export const githubInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: githubKeys.installations(wsId),
    queryFn: () => api.listGitHubInstallations(wsId),
    enabled: !!wsId,
  });

// Installations the caller manages elsewhere, offered for binding here. They
// change through bindings in OTHER workspaces, which publish no event to this
// one, so the client-wide staleTime: Infinity would keep a list from before
// the App was installed elsewhere. Connecting would then go to GitHub's
// install page, which parks an account that already has the App on its
// Configure page. Re-read on every mount and when the window regains focus
// (the install flow itself runs in another tab).
export const githubAppInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: githubKeys.appInstallations(wsId),
    queryFn: () => api.listGitHubAppInstallations(wsId),
    enabled: !!wsId,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

export const githubInstallationRepositoriesOptions = (
  wsId: string,
  installationId: string,
) =>
  infiniteQueryOptions({
    queryKey: githubKeys.repositories(wsId, installationId),
    queryFn: ({ pageParam }) =>
      api.listGitHubInstallationRepositories(wsId, installationId, {
        page: pageParam,
        per_page: 100,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.next_page ?? undefined,
    enabled: !!wsId && !!installationId,
  });

export type IssuePullRequestSummariesByIssue = Readonly<
  Record<string, readonly IssuePullRequestSummary[]>
>;

/**
 * Every linked PR in the workspace, grouped by issue id (newest first). One
 * workspace-wide read backs the PR chips on board cards, list rows and table
 * cells; enable it only while one of those surfaces shows PRs.
 */
export const issuePullRequestSummariesOptions = (wsId: string) =>
  queryOptions({
    queryKey: githubKeys.pullRequestSummaries(wsId),
    queryFn: async (): Promise<IssuePullRequestSummariesByIssue> => {
      const { pull_requests } = await api.listIssuePullRequestSummaries();
      const byIssue: Record<string, IssuePullRequestSummary[]> = {};
      for (const pr of pull_requests) {
        (byIssue[pr.issue_id] ??= []).push(pr);
      }
      return byIssue;
    },
    enabled: !!wsId,
  });

export const issuePullRequestsOptions = (issueId: string) =>
  queryOptions({
    queryKey: githubKeys.pullRequests(issueId),
    queryFn: () => api.listIssuePullRequests(issueId),
    enabled: !!issueId,
  });
