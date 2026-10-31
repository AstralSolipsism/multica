/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { issueKeys } from "../issues/queries";
import {
  useAdoptProjectBaseline,
  useRejectProjectBaseline,
  useUpdateProjectEngineering,
} from "./mutations";
import { projectKeys } from "./queries";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("project engineering mutations", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: 2 } },
    });
  });

  afterEach(() => {
    cleanup();
    qc.clear();
    vi.restoreAllMocks();
  });

  it("patches engineering config and settles by refreshing overview and decider issues", async () => {
    const updateProjectEngineering = vi.fn().mockResolvedValue(null);
    setApiInstance({ updateProjectEngineering } as unknown as ApiClient);
    const overviewKey = projectKeys.engineering("ws-1", "project-1");
    const decisionsKey = projectKeys.engineeringDecisionIssues("ws-1", "project-1", "member-1");
    qc.setQueryData(overviewKey, null);
    qc.setQueryData(decisionsKey, []);
    const { result } = renderHook(() => useUpdateProjectEngineering(), {
      wrapper: createWrapper(qc),
    });
    const input = {
      projectId: "project-1",
      currentStage: 3,
      modeSummary: "Deliver the core slice",
      deciderMemberIds: ["member-1"],
      agentDecisionsEnabled: false,
    };

    await act(async () => {
      await result.current.mutateAsync(input);
    });

    expect(updateProjectEngineering).toHaveBeenCalledWith("ws-1", "project-1", {
      currentStage: 3,
      modeSummary: "Deliver the core slice",
      deciderMemberIds: ["member-1"],
      agentDecisionsEnabled: false,
    });
    expect(qc.getQueryState(overviewKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(decisionsKey)?.isInvalidated).toBe(true);
  });

  it.each([
    ["adopt", useAdoptProjectBaseline],
    ["reject", useRejectProjectBaseline],
  ] as const)("sends the exact %s revisions and refreshes engineering and issue projections", async (action, useMutationHook) => {
    const decideProjectBaseline = vi.fn().mockResolvedValue(null);
    setApiInstance({ decideProjectBaseline } as unknown as ApiClient);
    const engineeringKey = projectKeys.engineeringHistoryAll("ws-1", "project-1");
    const issueListKey = [...issueKeys.list("ws-1"), "engineering-test"];
    const graphKey = [...issueKeys.graphAll("ws-1"), "engineering-test"];
    const timelineKey = issueKeys.timeline("issue-1");
    for (const key of [engineeringKey, issueListKey, graphKey, timelineKey]) {
      qc.setQueryData(key, null);
    }
    const { result } = renderHook(() => useMutationHook(), {
      wrapper: createWrapper(qc),
    });
    const revisions = [
      { revisionId: "candidate-1", expectedAdoptedRevisionId: "adopted-1" },
      { revisionId: "candidate-2", expectedAdoptedRevisionId: null },
    ];

    await act(async () => {
      await result.current.mutateAsync({ projectId: "project-1", revisions });
    });

    expect(decideProjectBaseline).toHaveBeenCalledWith("ws-1", "project-1", action, revisions);
    for (const key of [engineeringKey, issueListKey, graphKey, timelineKey]) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("does not retry a baseline conflict and still settles invalidations", async () => {
    const decideProjectBaseline = vi.fn().mockRejectedValue(new Error("baseline conflict"));
    setApiInstance({ decideProjectBaseline } as unknown as ApiClient);
    const overviewKey = projectKeys.engineering("ws-1", "project-1");
    const timelineKey = issueKeys.timeline("issue-1");
    qc.setQueryData(overviewKey, null);
    qc.setQueryData(timelineKey, []);
    const { result } = renderHook(() => useAdoptProjectBaseline(), {
      wrapper: createWrapper(qc),
    });

    await act(async () => {
      await expect(result.current.mutateAsync({
        projectId: "project-1",
        revisions: [{ revisionId: "reviewed-candidate", expectedAdoptedRevisionId: null }],
      })).rejects.toThrow("baseline conflict");
    });

    expect(decideProjectBaseline).toHaveBeenCalledTimes(1);
    expect(qc.getQueryState(overviewKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(timelineKey)?.isInvalidated).toBe(true);
  });
});
