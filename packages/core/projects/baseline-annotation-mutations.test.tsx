/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  useCloseProjectBaselineAnnotationBatch,
  useRejectProjectBaseline,
  useResolveProjectBaselineAnnotations,
  useSubmitProjectBaselineReview,
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

const reviewInput = {
  projectId: "project-1",
  clientKey: "client-1",
  chapter: "domain_rules",
  reviewedRevisionId: "revision-1",
  annotations: [{
    anchorKind: "section",
    targetRevisionId: "revision-1",
    sectionAnchor: "RULE-1",
    sectionTitle: "Settlement",
    note: "Clarify this",
  }],
} as const;

const cases = [
  {
    name: "review",
    method: "submitProjectBaselineReview",
    useHook: useSubmitProjectBaselineReview,
    input: reviewInput,
    args: ["ws-1", "project-1", {
      clientKey: "client-1",
      chapter: "domain_rules",
      reviewedRevisionId: "revision-1",
      annotations: reviewInput.annotations,
    }],
    invalidatesEngineering: true,
  },
  {
    name: "resolve",
    method: "resolveProjectBaselineAnnotations",
    useHook: useResolveProjectBaselineAnnotations,
    input: { projectId: "project-1", annotationIds: ["annotation-1"], resolved: true },
    args: ["ws-1", "project-1", { annotationIds: ["annotation-1"], resolved: true }],
    invalidatesEngineering: false,
  },
  {
    name: "close",
    method: "closeProjectBaselineAnnotationBatch",
    useHook: useCloseProjectBaselineAnnotationBatch,
    input: { projectId: "project-1", batchId: "batch-1" },
    args: ["ws-1", "project-1", "batch-1"],
    invalidatesEngineering: false,
  },
] as const;

describe("baseline annotation mutations", () => {
  let qc: QueryClient;
  let listKey: ReturnType<typeof projectKeys.baselineAnnotationBatches>;
  let detailKey: ReturnType<typeof projectKeys.baselineAnnotationBatch>;
  let engineeringKey: ReturnType<typeof projectKeys.engineeringHistoryAll>;
  let otherProjectKey: ReturnType<typeof projectKeys.baselineAnnotationBatches>;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: 2, retryDelay: 0 } },
    });
    listKey = projectKeys.baselineAnnotationBatches("ws-1", "project-1", { state: "active" });
    detailKey = projectKeys.baselineAnnotationBatch("ws-1", "project-1", "batch-1", {
      state: "all", withSections: true,
    });
    engineeringKey = projectKeys.engineeringHistoryAll("ws-1", "project-1");
    otherProjectKey = projectKeys.baselineAnnotationBatches("ws-1", "project-2");
    for (const key of [listKey, detailKey, engineeringKey, otherProjectKey]) qc.setQueryData(key, null);
  });

  afterEach(() => {
    cleanup();
    qc.clear();
    vi.restoreAllMocks();
  });

  it.each(cases)("sends the exact $name input and settles precise invalidations", async (testCase) => {
    const mutation = vi.fn().mockResolvedValue(null);
    setApiInstance({ [testCase.method]: mutation } as unknown as ApiClient);
    const { result } = renderHook(() => testCase.useHook(), { wrapper: createWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync(testCase.input as never);
    });

    expect(mutation).toHaveBeenCalledWith(...testCase.args);
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(engineeringKey)?.isInvalidated).toBe(testCase.invalidatesEngineering);
    expect(qc.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
  });

  it.each(cases)("does not retry a failed $name mutation and still invalidates on settle", async (testCase) => {
    const mutation = vi.fn().mockRejectedValue(new Error("baseline conflict"));
    setApiInstance({ [testCase.method]: mutation } as unknown as ApiClient);
    const { result } = renderHook(() => testCase.useHook(), { wrapper: createWrapper(qc) });

    await act(async () => {
      await expect(result.current.mutateAsync(testCase.input as never)).rejects.toThrow("baseline conflict");
    });

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(engineeringKey)?.isInvalidated).toBe(testCase.invalidatesEngineering);
    expect(qc.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
  });

  it("forwards the decide annotation batch action and refreshes annotation batches", async () => {
    const decideProjectBaseline = vi.fn().mockResolvedValue(null);
    setApiInstance({ decideProjectBaseline } as unknown as ApiClient);
    const { result } = renderHook(() => useRejectProjectBaseline(), { wrapper: createWrapper(qc) });
    const revisions = [{ revisionId: "revision-1", expectedAdoptedRevisionId: null }];

    await act(async () => {
      await result.current.mutateAsync({
        projectId: "project-1", revisions, annotationBatchAction: "keep",
      });
    });

    expect(decideProjectBaseline).toHaveBeenCalledWith(
      "ws-1", "project-1", "reject", revisions, { annotationBatchAction: "keep" },
    );
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });
});
