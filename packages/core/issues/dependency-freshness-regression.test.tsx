// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createQueryClient } from "../query-client";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { Issue } from "../types";
import { issueKeys } from "./queries";
import { onIssueUpdated } from "./ws-updaters";
import { useBatchUpdateIssues } from "./mutations";

vi.mock("../hooks", () => ({ useWorkspaceId: () => "review-ws" }));

const upstream: Issue = {
  id: "upstream", workspace_id: "review-ws", number: 1,
  identifier: "REV-1", title: "Prerequisite", description: null,
  status: "done", status_category: "done", priority: "none",
  assignee_type: null, assignee_id: null, creator_type: "member",
  creator_id: "review-user", parent_issue_id: null, project_id: null,
  position: 0, stage: null, start_date: null, due_date: null,
  metadata: {}, properties: {}, revision: 1,
  created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z",
};

it("REREVIEW replaces a first dependency read overtaken by an upstream event", async () => {
  const client = createQueryClient();
  const key = issueKeys.dependencies("review-ws", "dependent");
  let release!: (value: { unsatisfied: string[] }) => void;
  const oldResponse = new Promise<{ unsatisfied: string[] }>((resolve) => { release = resolve; });
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => ++reads === 1 ? oldResponse : Promise.resolve({ unsatisfied: ["upstream"] }),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(reads).toBe(1);
    client.setQueryData(issueKeys.detail("review-ws", "upstream"), upstream);
    onIssueUpdated(client, "review-ws", {
      ...upstream, status: "todo", status_category: "todo", revision: 2,
    }, { statusChanged: true });
    release({ unsatisfied: [] });
    await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe("idle"));
    await waitFor(() => expect(client.getQueryData(key), "An obsolete first response must not become permanently fresh").toEqual({ unsatisfied: ["upstream"] }));
    expect(reads).toBeGreaterThan(1);
  } finally {
    release({ unsatisfied: [] });
    unsubscribe();
    client.clear();
  }
});

it("REREVIEW refreshes dependencies after a normal batch status write without a WS event", async () => {
  const client = createQueryClient();
  const key = issueKeys.dependencies("review-ws", "dependent");
  client.setQueryData(key, { unsatisfied: [] });
  client.setQueryData(issueKeys.detail("review-ws", "upstream"), upstream);
  const batchUpdateIssues = vi.fn().mockResolvedValue({ updated: 1, results: null });
  setApiInstance({ batchUpdateIssues } as unknown as ApiClient);
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => { reads += 1; return { unsatisfied: ["upstream"] }; },
  });
  const unsubscribe = observer.subscribe(() => {});
  const hook = renderHook(() => useBatchUpdateIssues(), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  try {
    await act(async () => {
      await hook.result.current.mutateAsync({ ids: ["upstream"], updates: { status: "todo" } });
    });
    expect(batchUpdateIssues).toHaveBeenCalledWith(["upstream"], { status: "todo" });
    await waitFor(() => expect(reads, "A successful batch must refresh readiness even while WS is disconnected").toBeGreaterThan(0));
    expect(client.getQueryData(key)).toEqual({ unsatisfied: ["upstream"] });
  } finally {
    hook.unmount();
    unsubscribe();
    client.clear();
  }
});
