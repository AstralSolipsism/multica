import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { IssueTipList } from "../api/labrastro-ysk-schemas";

/** Query keys for You Should Know data; every key carries wsId. */
export const youShouldKnowKeys = {
  all: (wsId: string) => ["you-should-know", wsId] as const,
  active: (wsId: string) => ["you-should-know", wsId, "active"] as const,
  issue: (wsId: string, issueId: string, status: "valid" | "all") =>
    ["you-should-know", wsId, "issue", issueId, status] as const,
};

export function activeTipsOptions(wsId: string) {
  return queryOptions({
    queryKey: youShouldKnowKeys.active(wsId),
    queryFn: () => api.listActiveTips(),
  });
}

export function issueTipsOptions(
  wsId: string,
  issueId: string,
  status: "valid" | "all",
) {
  return queryOptions({
    queryKey: youShouldKnowKeys.issue(wsId, issueId, status),
    queryFn: () => api.listIssueTips(issueId, status),
  });
}

export type { IssueTipList };
