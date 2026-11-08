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

function setupRealtime() {
  vi.useFakeTimers();
  const qc = createQueryClient();
  qc.setQueryData(agentFolderKeys.tree("ws-1"), { folders: [], placements: [], squads: [] });
  qc.setQueryData(agentFolderKeys.tree("ws-2"), { folders: [], placements: [], squads: [] });
  let dispatch: ((msg: WSMessage) => void) | undefined;
  let reconnect: (() => void | Promise<void>) | undefined;
  const ws = {
    on: () => () => {},
    onAny: (handler: (msg: WSMessage) => void) => {
      dispatch = handler;
      return () => {};
    },
    onReconnect: (handler: () => void | Promise<void>) => {
      reconnect = handler;
      return () => {};
    },
  } as unknown as WSClient;
  const stores = {
    authStore: { getState: () => ({ user: { id: "u1" } }) },
  } as unknown as RealtimeSyncStores;
  renderHook(() => useRealtimeSync(ws, stores), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  return { qc, dispatch: dispatch!, reconnect: reconnect! };
}

// Derived folders must follow structural squad and agent changes without a reload.
it.each<WSEventType>(["squad:created", "squad:updated", "squad:deleted", "agent:created", "agent:archived", "agent:restored"])(
  "%s invalidates the active workspace agent tree",
  async (type) => {
    const { qc, dispatch } = setupRealtime();
    act(() => dispatch({ type, payload: {} }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(qc.getQueryState(agentFolderKeys.tree("ws-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(agentFolderKeys.tree("ws-2"))?.isInvalidated).toBe(false);
    qc.clear();
  },
);

it("does not refetch static folder membership for agent presence status", async () => {
  const { qc, dispatch } = setupRealtime();
  act(() => dispatch({
    type: "agent:status",
    payload: { agent_id: "a-1", status: "working" },
  } as WSMessage));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(qc.getQueryState(agentFolderKeys.tree("ws-1"))?.isInvalidated).toBe(false);
  qc.clear();
});

it("invalidates the active workspace tree after a websocket reconnect", async () => {
  const { qc, reconnect } = setupRealtime();
  await act(async () => {
    await reconnect();
  });
  expect(qc.getQueryState(agentFolderKeys.tree("ws-1"))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(agentFolderKeys.tree("ws-2"))?.isInvalidated).toBe(false);
  qc.clear();
});
