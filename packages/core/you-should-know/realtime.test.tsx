/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { WSClient } from "../api/ws-client";
import type { IssueTipList } from "../api/labrastro-ysk-schemas";
import { youShouldKnowKeys } from "./queries";
import { useYouShouldKnowRealtimeSync } from "./realtime";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
}));

const WS = "ws-1";

function makeTip(id: string) {
  return {
    id,
    issue_id: "i1",
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
    overturn_reason: null,
    my_state: null,
    created_at: "",
    updated_at: "",
  };
}

type Handler = (payload: unknown) => void;

function createMockWs() {
  const handlers = new Map<string, Handler>();
  const reconnectCallbacks: (() => void)[] = [];
  return {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    onReconnect: vi.fn((cb: () => void) => {
      reconnectCallbacks.push(cb);
      return () => {
        const i = reconnectCallbacks.indexOf(cb);
        if (i >= 0) reconnectCallbacks.splice(i, 1);
      };
    }),
    emit: (event: string, payload: unknown) => handlers.get(event)?.(payload),
    reconnect: () => reconnectCallbacks.forEach((cb) => cb()),
    subscribedEvents: () => [...handlers.keys()],
  };
}

describe("useYouShouldKnowRealtimeSync", () => {
  let qc: QueryClient;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    ws = createMockWs();
    qc.setQueryData(youShouldKnowKeys.active(WS), { tips: [makeTip("t1"), makeTip("t2")] });
    qc.setQueryData(youShouldKnowKeys.issue(WS, "i1", "all"), { tips: [makeTip("t1")] });
  });

  afterEach(() => {
    qc.clear();
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it("subscribes to the tip and task lifecycle events", () => {
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    expect(ws.subscribedEvents()).toEqual(
      expect.arrayContaining([
        "issue_tip:created",
        "issue_tip:updated",
        "issue_tip_state:changed",
        "task:running",
        "task:completed",
        "task:failed",
        "task:cancelled",
      ]),
    );
  });

  it("issue_tip:created with issue_id invalidates YSK queries", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("issue_tip:created", { tip_id: "t3", issue_id: "i1" });
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
  });

  it("issue_tip:updated without issue_id invalidates all YSK queries", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("issue_tip:updated", { tip_id: "t3" });
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
  });

  it("issue_tip_state:changed patches my_state in every cached list", () => {
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("issue_tip_state:changed", {
        tip_id: "t1",
        state: "known",
        feedback: "helpful",
      });
    });
    const expected = { state: "known", feedback: "helpful" };
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === "t1")?.my_state,
    ).toEqual(expected);
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.issue(WS, "i1", "all"))?.tips.find((t) => t.id === "t1")?.my_state,
    ).toEqual(expected);
    // other tips untouched
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === "t2")?.my_state,
    ).toBeNull();
  });

  it("issue_tip_state:changed without state falls back to invalidation", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("issue_tip_state:changed", { tip_id: "t1" });
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
    // cache not patched
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === "t1")?.my_state,
    ).toBeNull();
  });

  it("task lifecycle events debounce an active-list invalidation", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(qc, "invalidateQueries");
      renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
        wrapper: Wrapper,
      });
      act(() => {
        ws.emit("task:running", { task_id: "r2" });
        ws.emit("task:completed", { task_id: "r3" });
      });
      expect(spy).not.toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: youShouldKnowKeys.active(WS) }),
      );
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: youShouldKnowKeys.active(WS) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnect invalidates all YSK queries", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.reconnect();
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(
      () => useYouShouldKnowRealtimeSync(ws as unknown as WSClient),
      { wrapper: Wrapper },
    );
    unmount();
    // handlers removed — a later event does not throw or patch
    expect(() =>
      ws.emit("issue_tip_state:changed", { tip_id: "t1", state: "known" }),
    ).not.toThrow();
  });
});
