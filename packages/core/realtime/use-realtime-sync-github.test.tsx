/** @vitest-environment jsdom */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { WSClient } from "../api/ws-client";
import { githubKeys } from "../github/queries";
import { createQueryClient } from "../query-client";
import type { WSEventType, WSMessage } from "../types/events";
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Another manager connecting or disconnecting an account in this workspace
// also changes which installations are still offered for reuse here.
it.each<WSEventType>(["github_installation:created", "github_installation:deleted"])(
  "%s refreshes both the connected and the reusable installation lists",
  async (type) => {
    vi.useFakeTimers();
    const qc = createQueryClient();
    qc.setQueryData(githubKeys.installations("ws-1"), { installations: [] });
    qc.setQueryData(githubKeys.appInstallations("ws-1"), { installations: [] });
    let dispatch: ((msg: WSMessage) => void) | undefined;
    const ws = {
      on: () => () => {},
      onAny: (handler: (msg: WSMessage) => void) => {
        dispatch = handler;
        return () => {};
      },
      onReconnect: () => () => {},
    } as unknown as WSClient;
    const stores = {
      authStore: { getState: () => ({ user: { id: "u1" } }) },
    } as unknown as RealtimeSyncStores;
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });

    act(() => dispatch!({ type, payload: {} }));
    // Prefix refreshes are debounced.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(qc.getQueryState(githubKeys.installations("ws-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(githubKeys.appInstallations("ws-1"))?.isInvalidated).toBe(true);
  },
);
