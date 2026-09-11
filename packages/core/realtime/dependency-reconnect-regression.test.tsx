// @vitest-environment jsdom
import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { setApiInstance, type ApiClient } from "../api";
import type { DependencyView } from "../api/dependency-schemas";
import type { WSClient } from "../api/ws-client";
import { issueDependenciesOptions } from "../issues/queries";
import { createQueryClient } from "../query-client";
import { useRealtimeSync, type RealtimeSyncStores } from "./use-realtime-sync";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
  getCurrentSlug: () => "test-ws",
  createWorkspaceAwareStorage: (adapter: unknown) => adapter,
  registerForWorkspaceRehydration: () => {},
}));
vi.mock("../paths", () => ({
  useHasOnboarded: () => true,
  resolvePostAuthDestination: () => "/",
}));

it("THIRDREVIEW replaces a first prerequisite response overtaken by reconnect", async () => {
  const qc = createQueryClient();
  const before: DependencyView = {
    blockedBy: [], inheritedBlockedBy: [], blocking: [], unsatisfied: [],
    hasRestrictedBlockers: false, dependencyVersion: "before-reopen",
  };
  const reopened = {
    issueId: "upstream", status: "todo", statusCategory: "todo", satisfied: false,
    sourceEdges: ["edge-1"], inheritedFrom: [],
    title: "Prerequisite", identifier: "REV-1", descendantCount: 0,
  };
  const after: DependencyView = {
    ...before, blockedBy: [reopened], unsatisfied: [reopened],
    dependencyVersion: "after-reopen",
  };
  let resolveFirst!: (view: DependencyView) => void;
  const getIssueDependencies = vi.fn()
    .mockImplementationOnce(() => new Promise<DependencyView>((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValue(after);
  setApiInstance({ getIssueDependencies } as unknown as ApiClient);
  const ws = {
    on: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  } as unknown as WSClient;
  const stores = {
    authStore: Object.assign(() => ({}), {
      getState: () => ({ user: { id: "u1" } }),
      subscribe: () => () => {}, setState: () => {}, destroy: () => {},
    }),
  } as unknown as RealtimeSyncStores;
  const { unmount } = renderHook(() => useRealtimeSync(ws, stores), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  const observer = new QueryObserver(qc, issueDependenciesOptions("ws-1", "dependent"));
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(getIssueDependencies).toHaveBeenCalledTimes(1);
    // The upstream reopened while the socket was unavailable; reconnect is
    // the only signal. The initial GET still carries the older ready view.
    void vi.mocked(ws.onReconnect).mock.calls[0]![0]();
    resolveFirst(before);
    await waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe("idle"));
    await waitFor(() => expect(observer.getCurrentResult().data,
      "Reconnect must not freeze the obsolete ready response under staleTime: Infinity",
    ).toEqual(after));
    expect(getIssueDependencies).toHaveBeenCalledTimes(2);
  } finally {
    resolveFirst(before);
    unsubscribe();
    unmount();
    qc.clear();
  }
});
