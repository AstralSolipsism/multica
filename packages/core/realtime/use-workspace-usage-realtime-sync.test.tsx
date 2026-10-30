/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WSClient } from "../api/ws-client";
import { issueKeys } from "../issues/queries";
import { useWorkspaceUsageRealtimeSync } from "./use-workspace-usage-realtime-sync";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
  createWorkspaceAwareStorage: (adapter: unknown) => adapter,
  registerForWorkspaceRehydration: () => {},
}));

type Handler = () => void;

function createMockWs() {
  const handlers = new Map<string, Handler>();
  return {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    emit: (event: string) => handlers.get(event)?.(),
    subscribedEvents: () => [...handlers.keys()],
  };
}

describe("useWorkspaceUsageRealtimeSync", () => {
  let qc: QueryClient;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    ws = createMockWs();
  });

  afterEach(() => {
    cleanup();
    qc.clear();
    vi.useRealTimers();
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  function mount() {
    return renderHook(() => useWorkspaceUsageRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
  }

  it("subscribes only to terminal task events", () => {
    mount();
    expect(ws.subscribedEvents()).toEqual([
      "task:completed",
      "task:failed",
      "task:cancelled",
    ]);
  });

  it("coalesces terminal events into refreshes at least 30 seconds apart", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    mount();

    act(() => {
      ws.emit("task:completed");
      ws.emit("task:failed");
      ws.emit("task:cancelled");
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenLastCalledWith({
      queryKey: issueKeys.workspaceUsage("ws-1"),
    });

    act(() => {
      vi.advanceTimersByTime(29_900);
      ws.emit("task:completed");
    });
    expect(invalidate).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);

    act(() => {
      ws.emit("task:failed");
      vi.advanceTimersByTime(1_000);
      ws.emit("task:cancelled");
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("cancels a trailing refresh on unmount", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { unmount } = mount();

    act(() => {
      ws.emit("task:completed");
      ws.emit("task:failed");
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    unmount();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
