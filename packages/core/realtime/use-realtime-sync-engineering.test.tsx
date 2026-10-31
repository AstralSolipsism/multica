/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { WSClient } from "../api/ws-client";
import { projectKeys } from "../projects/queries";
import type { WSEventType } from "../types/events";
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
  vi.restoreAllMocks();
});

function createMockWs(): WSClient {
  return {
    on: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  } as unknown as WSClient;
}

it.each<{ type: WSEventType; invalidatesHistory: boolean }>([
  { type: "project_engineering:updated", invalidatesHistory: false },
  { type: "project_baseline:changed", invalidatesHistory: true },
])("$type invalidates only the affected project's engineering queries", ({ type, invalidatesHistory }) => {
  const qc = new QueryClient();
  const ws = createMockWs();
  const stores = {
    authStore: { getState: () => ({ user: { id: "user-1" } }) },
  } as unknown as RealtimeSyncStores;
  const overviewKey = projectKeys.engineering("ws-1", "project-1");
  const historyKey = projectKeys.engineeringHistory("ws-1", "project-1", "overview", {});
  const otherProjectKey = projectKeys.engineering("ws-1", "project-2");
  const otherWorkspaceKey = projectKeys.engineering("ws-2", "project-1");
  for (const key of [overviewKey, historyKey, otherProjectKey, otherWorkspaceKey]) {
    qc.setQueryData(key, null);
  }
  renderHook(() => useRealtimeSync(ws, stores), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  const handler = vi.mocked(ws.on).mock.calls.find(([event]) => event === type)?.[1];
  expect(handler).toBeDefined();

  act(() => {
    (handler as (payload: unknown) => void)({
      project_id: "project-1",
      ...(type === "project_baseline:changed" ? { chapter: "overview" } : {}),
    });
  });

  expect(qc.getQueryState(overviewKey)?.isInvalidated).toBe(true);
  expect(qc.getQueryState(historyKey)?.isInvalidated).toBe(invalidatesHistory);
  expect(qc.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
  expect(qc.getQueryState(otherWorkspaceKey)?.isInvalidated).toBe(false);
  qc.clear();
});
