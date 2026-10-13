/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { WSClient } from "../api/ws-client";
import type { IssueTipList } from "../api/labrastro-ysk-schemas";
import { chatKeys } from "../chat/queries";
import { youShouldKnowKeys } from "./queries";
import { useYouShouldKnowRealtimeSync } from "./realtime";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
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
    qc.setQueryData(youShouldKnowKeys.issue(WS, "i2", "all"), { tips: [makeTip("t9")] });
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

  it("issue_tip:created with an issue_id invalidates only that issue's lists and active", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("issue_tip:created", { tip: makeTip("t3", { issue_id: "i1" }) });
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.issueAnyStatus(WS, "i1") }),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.active(WS) }),
    );
    // other issues' lists are not invalidated
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.issueAnyStatus(WS, "i2") }),
    );
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
  });

  it("issue_tip:updated without a usable tip payload invalidates all YSK queries", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("issue_tip:updated", {});
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: youShouldKnowKeys.all(WS) }),
    );
  });

  it("issue_tip_state:changed patches user_state in every cached list", () => {
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("issue_tip_state:changed", {
        workspace_id: WS,
        issue_id: "i1",
        tip_id: "t1",
        user_id: "u1",
        state: "known",
        feedback: "helpful",
        updated_at: "2026-10-11T00:00:00Z",
      });
    });
    const expected = { state: "known", feedback: "helpful" };
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === "t1")?.user_state,
    ).toEqual(expected);
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.issue(WS, "i1", "all"))?.tips.find((t) => t.id === "t1")?.user_state,
    ).toEqual(expected);
    // other tips untouched
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === "t2")?.user_state,
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
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === "t1")?.user_state,
    ).toBeNull();
  });

  it("task lifecycle events collapse into one debounced active-list invalidation", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(qc, "invalidateQueries");
      renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
        wrapper: Wrapper,
      });
      act(() => {
        ws.emit("task:running", { task_id: "r2" });
        ws.emit("task:completed", { task_id: "r3" });
        ws.emit("task:failed", { task_id: "r4" });
      });
      expect(spy).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(800);
      });
      // all three events produced exactly one invalidation of the active list
      expect(spy).toHaveBeenCalledTimes(1);
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

  it("keeps a side chat's detail entry in step with renames and archiving", () => {
    const detail = {
      id: "s1", workspace_id: WS, agent_id: "a1", creator_id: "u1", title: "LAB-1 · Title",
      status: "active" as const, has_unread: false, created_at: "", updated_at: "",
    };
    qc.setQueryData(chatKeys.session(WS, "s1"), detail);
    renderHook(() => useYouShouldKnowRealtimeSync(ws as unknown as WSClient), {
      wrapper: Wrapper,
    });
    act(() => {
      ws.emit("chat:session_updated", { chat_session_id: "s1", title: "Renamed", updated_at: "u2" });
    });
    expect(qc.getQueryData(chatKeys.session(WS, "s1"))).toEqual({
      ...detail, title: "Renamed", updated_at: "u2",
    });
    act(() => {
      ws.emit("chat:session_updated", { chat_session_id: "s1", title: "Renamed", status: "archived" });
    });
    expect(qc.getQueryData(chatKeys.session(WS, "s1"))).toMatchObject({ status: "archived" });
    // An unrelated session is not created out of an event.
    act(() => {
      ws.emit("chat:session_updated", { chat_session_id: "s2", title: "Other" });
    });
    expect(qc.getQueryData(chatKeys.session(WS, "s2"))).toBeUndefined();

    act(() => {
      ws.emit("chat:session_deleted", { chat_session_id: "s1" });
    });
    expect(qc.getQueryData(chatKeys.session(WS, "s1"))).toBeUndefined();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(
      () => useYouShouldKnowRealtimeSync(ws as unknown as WSClient),
      { wrapper: Wrapper },
    );
    unmount();
    // handlers removed — a later event neither patches the cache nor throws
    expect(() =>
      ws.emit("issue_tip_state:changed", { tip_id: "t1", state: "known" }),
    ).not.toThrow();
    expect(
      qc.getQueryData<IssueTipList>(youShouldKnowKeys.active(WS))?.tips.find((t) => t.id === "t1")?.user_state,
    ).toBeNull();
  });
});
