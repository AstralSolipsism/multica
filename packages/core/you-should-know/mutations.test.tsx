/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { IssueTipList } from "../api/labrastro-ysk-schemas";
import { useSetTipState } from "./mutations";
import { youShouldKnowKeys } from "./queries";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const WS = "ws-1";

function makeTip(id: string, overrides: Partial<IssueTipList["tips"][number]> = {}) {
  return {
    id,
    workspace_id: WS,
    issue_id: "i1",
    issue_identifier: "LAB-1",
    task_id: "r1",
    agent_id: "a1",
    anchor_comment_id: null,
    tag: "you_should_know" as const,
    line: "line",
    title: null,
    explanation: null,
    status: "valid" as const,
    overturned_by_task_id: null,
    overturned_by_comment_id: null,
    overturned_reason: null,
    user_state: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSetTipState", () => {
  let qc: QueryClient;
  let setTipState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setTipState = vi.fn(async () => undefined);
    setApiInstance({ setTipState } as unknown as ApiClient);
    qc.setQueryData(youShouldKnowKeys.active(WS), { tips: [makeTip("t1"), makeTip("t2")] });
    qc.setQueryData(youShouldKnowKeys.issue(WS, "i1", "all"), { tips: [makeTip("t1")] });
    qc.setQueryData(youShouldKnowKeys.issue(WS, "i1", "valid"), { tips: [makeTip("t1")] });
  });

  afterEach(() => {
    qc.clear();
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  function activeTip(id: string) {
    return qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === id);
  }

  it("optimistically writes user_state into every cached list", async () => {
    const { result } = renderHook(() => useSetTipState(), { wrapper: Wrapper });
    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "known", feedback: null } });
    });
    const expected = { state: "known", feedback: null };
    for (const key of [
      youShouldKnowKeys.active(WS),
      youShouldKnowKeys.issue(WS, "i1", "all"),
      youShouldKnowKeys.issue(WS, "i1", "valid"),
    ]) {
      const tips = qc.getQueryData<IssueTipList>(key)?.tips;
      expect(tips?.find((t) => t.id === "t1")?.user_state).toEqual(expected);
      // other tips untouched (only the active list has t2)
      if (tips?.some((t) => t.id === "t2")) {
        expect(tips.find((t) => t.id === "t2")?.user_state).toBeNull();
      }
    }
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back on failure", async () => {
    setTipState.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useSetTipState(), { wrapper: Wrapper });
    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "dismissed", feedback: null } });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    for (const key of [
      youShouldKnowKeys.active(WS),
      youShouldKnowKeys.issue(WS, "i1", "all"),
    ]) {
      expect(
        qc.getQueryData<IssueTipList>(key)?.tips.find((t) => t.id === "t1")?.user_state,
      ).toBeNull();
    }
    // error surfaces to the caller
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("a queued second mutation overwrites the first and failure of the first does not clobber it", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    setTipState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useSetTipState(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "known", feedback: null } });
    });
    // first optimistic patch visible immediately
    expect(activeTip("t1")?.user_state).toEqual({ state: "known", feedback: null });

    // queue the second mutation while the first is in flight (scope serializes)
    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "dismissed", feedback: "not_relevant" } });
    });
    // second optimistic patch lands while first still pending
    expect(activeTip("t1")?.user_state).toEqual({ state: "dismissed", feedback: "not_relevant" });

    // first fails — its rollback must not revert the second mutation's value
    await act(async () => {
      first.reject(new Error("first failed"));
    });
    expect(activeTip("t1")?.user_state).toEqual({ state: "dismissed", feedback: "not_relevant" });

    await act(async () => {
      second.resolve(undefined);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("dismiss then feedback keeps the second optimistic value when the first request fails", async () => {
    // OL-187 §6 flow: "Dismiss" first, then pick a feedback — both requests
    // carry state "dismissed" and differ only in feedback.
    const first = deferred<void>();
    const second = deferred<void>();
    setTipState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useSetTipState(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "dismissed", feedback: null } });
    });
    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "dismissed", feedback: "helpful" } });
    });
    expect(activeTip("t1")?.user_state).toEqual({ state: "dismissed", feedback: "helpful" });

    await act(async () => {
      first.reject(new Error("first failed"));
    });
    expect(activeTip("t1")?.user_state).toEqual({ state: "dismissed", feedback: "helpful" });

    await act(async () => {
      second.resolve(undefined);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("serializes queued requests and invalidates once after both settle", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    setTipState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useSetTipState(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "dismissed", feedback: null } });
    });
    await act(async () => {
      result.current.mutate({ tipId: "t1", request: { state: "dismissed", feedback: "helpful" } });
    });

    // scope: the second request is not sent until the first completes
    expect(setTipState).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(undefined);
    });
    // first settled while the second is still queued — no invalidation yet,
    // a refetch now would clobber the queued optimistic value
    expect(spy).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve(undefined);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
  });

  it("refetches active + issue queries after settle", async () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useSetTipState(), { wrapper: Wrapper });
    await act(async () => {
      result.current.mutate({ tipId: "t2", request: { state: "known", feedback: null } });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
  });
});
