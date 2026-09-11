import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { useIssueTriggerPreview } from "./use-issue-trigger-preview";

vi.mock("@multica/core/api", async () => {
  // The signature identity tests exercise the REAL canonicalizer — its
  // boundary semantics are tested next to the helper in core, not mirrored.
  const { canonicalDependencyMutation } = await vi.importActual<
    typeof import("@multica/core/api")
  >("@multica/core/api");
  return {
    api: {
      previewIssueTrigger: vi.fn(),
    },
    canonicalDependencyMutation,
  };
});

const previewIssueTrigger = vi.mocked(api.previewIssueTrigger);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const blockedEntry = {
  issueId: "issue-1",
  reasonCode: "dependency_unsatisfied",
  dependencies: null,
  confirmation: { requestId: "req-1", challenge: "ch-1", expiresAt: "2099-01-01T00:00:00Z" },
};

describe("useIssueTriggerPreview (OL-44 dependency preview)", () => {
  beforeEach(() => {
    previewIssueTrigger.mockReset();
    previewIssueTrigger.mockResolvedValue({
      triggers: [],
      total_count: 0,
      blocked: [blockedEntry],
    });
  });

  it("passes the full mutation to the preview and exposes blocked + confirmation", async () => {
    const mutation = {
      assignee_type: "agent" as const,
      assignee_id: "agent-1",
      status: "todo",
      blockedBy: ["issue-9"],
    };
    const { result } = renderHook(
      () =>
        useIssueTriggerPreview({
          issueIds: ["issue-1"],
          mutation,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.blocked).toHaveLength(1));
    expect(previewIssueTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ issueIds: ["issue-1"], mutation }),
    );
    expect(result.current.blocked?.[0]?.confirmation?.requestId).toBe("req-1");
  });

  it("keys the query by the mutation's content — a changed body refetches, an equal one shares", async () => {
    const wrapper = createWrapper();
    const base = {
      assignee_type: "agent" as const,
      assignee_id: "agent-1",
      status: "todo",
      blockedBy: ["issue-9", "issue-8"],
    };
    const { rerender } = renderHook(
      ({ mutation }) =>
        useIssueTriggerPreview({ issueIds: ["issue-1"], mutation }),
      { wrapper, initialProps: { mutation: base } },
    );
    await waitFor(() => expect(previewIssueTrigger).toHaveBeenCalledTimes(1));

    // Key order + set order are presentation details, not identity.
    rerender({
      mutation: {
        status: "todo",
        blockedBy: ["issue-8", "issue-9"],
        assignee_id: "agent-1",
        assignee_type: "agent" as const,
      },
    });
    await waitFor(() => expect(previewIssueTrigger).toHaveBeenCalledTimes(1));

    // A changed mutation is a different prospective write: the signed
    // challenge binds it, so it must be its own query.
    rerender({
      mutation: { ...base, blockedBy: ["issue-9"] },
    });
    await waitFor(() => expect(previewIssueTrigger).toHaveBeenCalledTimes(2));
    expect(previewIssueTrigger).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({ blockedBy: ["issue-9"] }),
      }),
    );
  });

  it("marks placeholder answers so a stale challenge is never submitted against new inputs", async () => {
    let resolveSecond: (v: Awaited<ReturnType<typeof api.previewIssueTrigger>>) => void = () => {};
    previewIssueTrigger
      .mockResolvedValueOnce({ triggers: [], total_count: 0, blocked: [blockedEntry] })
      .mockImplementationOnce(
        () =>
          new Promise<Awaited<ReturnType<typeof api.previewIssueTrigger>>>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      ({ status }) =>
        useIssueTriggerPreview({
          issueIds: ["issue-1"],
          mutation: { status, assignee_type: "agent" as const, assignee_id: "agent-1" },
        }),
      { wrapper, initialProps: { status: "todo" } },
    );
    await waitFor(() => expect(result.current.blocked).toHaveLength(1));
    expect(result.current.isPlaceholderData).toBe(false);

    rerender({ status: "in_progress" });
    // keepPreviousData shows the previous answer while the new one loads —
    // isPlaceholderData is the consumer's signal that this confirmation
    // belongs to the OLD mutation.
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.blocked).toHaveLength(1);

    resolveSecond({ triggers: [], total_count: 1, blocked: null });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    await waitFor(() => expect(result.current.blocked).toBeNull());
  });
});
