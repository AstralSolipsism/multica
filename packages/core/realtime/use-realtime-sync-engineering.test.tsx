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

it.each<{ type: WSEventType; invalidatesWiki: boolean }>([
  { type: "project_engineering:updated", invalidatesWiki: false },
  { type: "project_baseline:changed", invalidatesWiki: true },
])("$type invalidates only the affected project's engineering queries", ({ type, invalidatesWiki }) => {
  const qc = new QueryClient();
  const ws = createMockWs();
  const stores = {
    authStore: { getState: () => ({ user: { id: "user-1" } }) },
  } as unknown as RealtimeSyncStores;
  const overviewKey = projectKeys.engineering("ws-1", "project-1");
  const configKey = projectKeys.engineeringConfig("ws-1", "project-1");
  const wikiKey = projectKeys.wikiTree("ws-1", "project-1", false);
  const otherProjectKey = projectKeys.engineering("ws-1", "project-2");
  const otherWorkspaceKey = projectKeys.engineering("ws-2", "project-1");
  for (const key of [overviewKey, configKey, wikiKey, otherProjectKey, otherWorkspaceKey]) {
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
      ...(type === "project_baseline:changed"
        ? { page_id: "00000000-0000-4000-8000-000000000001", slug: "overview", change: "content", revision_number: 3 }
        : {}),
    });
  });

  expect(qc.getQueryState(overviewKey)?.isInvalidated).toBe(true);
  // Baseline changes leave the configuration-only read alone.
  expect(qc.getQueryState(configKey)?.isInvalidated).toBe(!invalidatesWiki);
  // Page writes refresh the whole wiki subtree for the affected project only.
  expect(qc.getQueryState(wikiKey)?.isInvalidated).toBe(invalidatesWiki);
  expect(qc.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
  expect(qc.getQueryState(otherWorkspaceKey)?.isInvalidated).toBe(false);
  qc.clear();
});

it("project_baseline_comment:changed invalidates the wiki subtree for the affected project", () => {
  const qc = new QueryClient();
  const ws = createMockWs();
  const stores = {
    authStore: { getState: () => ({ user: { id: "user-1" } }) },
  } as unknown as RealtimeSyncStores;
  const wikiKey = projectKeys.wikiTree("ws-1", "project-1", false);
  const pageKey = projectKeys.wikiPageAll("ws-1", "project-1", "overview");
  const otherProjectKey = projectKeys.wikiTree("ws-1", "project-2", false);
  const otherWorkspaceKey = projectKeys.wikiTree("ws-2", "project-1", false);
  for (const key of [wikiKey, pageKey, otherProjectKey, otherWorkspaceKey]) qc.setQueryData(key, null);
  renderHook(() => useRealtimeSync(ws, stores), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  const handler = vi.mocked(ws.on).mock.calls.find(([event]) => event === "project_baseline_comment:changed")?.[1];
  expect(handler).toBeDefined();

  act(() => {
    (handler as (payload: unknown) => void)({
      project_id: "project-1", page_id: "00000000-0000-4000-8000-000000000001", thread_id: "thread-1",
    });
  });

  expect(qc.getQueryState(wikiKey)?.isInvalidated).toBe(true);
  expect(qc.getQueryState(pageKey)?.isInvalidated).toBe(true);
  expect(qc.getQueryState(otherProjectKey)?.isInvalidated).toBe(false);
  expect(qc.getQueryState(otherWorkspaceKey)?.isInvalidated).toBe(false);
  qc.clear();
});

it("reconnect refreshes engineering reads that project-wide invalidation no longer reaches", async () => {
  const qc = new QueryClient();
  const ws = createMockWs();
  const stores = {
    authStore: { getState: () => ({ user: { id: "user-1" } }) },
  } as unknown as RealtimeSyncStores;
  const keys = [
    projectKeys.engineering("ws-1", "project-1"),
    projectKeys.engineeringConfig("ws-1", "project-2"),
    projectKeys.wikiTree("ws-1", "project-1", false),
  ];
  const otherWorkspaceKey = projectKeys.engineering("ws-2", "project-1");
  for (const key of [...keys, otherWorkspaceKey]) qc.setQueryData(key, null);
  renderHook(() => useRealtimeSync(ws, stores), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  const reconnect = vi.mocked(ws.onReconnect).mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
  expect(reconnect).toBeDefined();

  await act(async () => { await reconnect!(); });

  for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  expect(qc.getQueryState(otherWorkspaceKey)?.isInvalidated).toBe(false);
  qc.clear();
});
