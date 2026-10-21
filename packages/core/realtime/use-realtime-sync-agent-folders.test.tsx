/** @vitest-environment jsdom */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { WSClient } from "../api/ws-client";
import { agentFolderKeys } from "../agents/folder-queries";
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

// Derived folders must follow squad and agent changes without a page reload.
it.each<WSEventType>(["squad:created", "squad:updated", "squad:deleted", "agent:created", "agent:status", "agent:archived", "agent:restored"])(
  "%s invalidates the active workspace agent tree",
  async (type) => {
    vi.useFakeTimers();
    const qc = createQueryClient();
    qc.setQueryData(agentFolderKeys.tree("ws-1"), { folders: [], placements: [], squads: [] });
    qc.setQueryData(agentFolderKeys.tree("ws-2"), { folders: [], placements: [], squads: [] });
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

    expect(qc.getQueryState(agentFolderKeys.tree("ws-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(agentFolderKeys.tree("ws-2"))?.isInvalidated).toBe(false);
    qc.clear();
  },
);
