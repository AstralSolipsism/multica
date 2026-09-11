/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { WSClient } from "../api/ws-client";
import { setApiInstance, type ApiClient } from "../api";
import { IssueGraphSchema, type IssueGraph } from "../api/issue-graph-schemas";
import referenceGraph from "../api/testdata/issue-graph.json";
import { issueGraphOptions } from "../issues/graph";
import { defaultStorage } from "../platform/storage";
import { issueKeys } from "../issues/queries";
import { chatKeys } from "../chat/queries";
import { runtimeKeys } from "../runtimes/queries";
import { workspaceWorkingAgentsKeys } from "../agents/queries";
import { workspaceKeys } from "../workspace/queries";
import { issueStatusKeys } from "../issue-statuses/queries";
import {
  markWorkspaceDeletePending,
  unmarkWorkspaceDeletePending,
} from "../workspace/pending-delete";
import { useRealtimeSync, type RealtimeSyncStores } from "./use-realtime-sync";

vi.mock("../platform/workspace-storage", () => ({
  getCurrentWsId: () => "ws-1",
  getCurrentSlug: () => "test-ws",
  // Draft stores are now loaded transitively (storage-cleanup → register-all-drafts)
  // so their persist wiring must resolve against this mock.
  createWorkspaceAwareStorage: (adapter: unknown) => adapter,
  registerForWorkspaceRehydration: () => {},
}));

vi.mock("../paths", () => ({
  useHasOnboarded: () => true,
  resolvePostAuthDestination: () => "/",
}));

function createMockWs(): WSClient {
  return {
    on: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  } as unknown as WSClient;
}

function createStores(): RealtimeSyncStores {
  return {
    authStore: Object.assign(() => ({}), {
      getState: () => ({ user: { id: "u1" } }),
      subscribe: () => () => {},
      setState: () => {},
      destroy: () => {},
    }),
  } as unknown as RealtimeSyncStores;
}

function createWrapper(qc: QueryClient) {
  // Named function (not arrow) so react/display-name lint rule passes —
  // anonymous render-fn components break that rule even in test files.
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useRealtimeSync — ws instance change", () => {
  let qc: QueryClient;
  let stores: RealtimeSyncStores;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stores = createStores();
    invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  });

  it("skips invalidation on first non-null ws instance", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });

    // The main effect calls invalidateQueries for its own setup, but the
    // ws-instance-change effect should NOT have fired invalidation.
    // The only invalidateQueries calls should come from the main effect's
    // event handlers, not from the instance-change effect.
    // We verify by checking that no call was made with workspaceKeys.list()
    // pattern from the instance-change path (it logs a specific message).
    // Simpler: count calls — first mount with a ws should not trigger the
    // workspace-scoped bulk invalidation.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not invalidate when ws goes from instance to null", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    rerender({ ws: null });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates exactly once when a new ws instance appears after null gap", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    // Simulate workspace switch: ws -> null -> new ws
    invalidateSpy.mockClear();
    rerender({ ws: null });
    expect(invalidateSpy).not.toHaveBeenCalled();

    const ws2 = createMockWs();
    rerender({ ws: ws2 });

    // Should have called invalidateQueries for all workspace-scoped keys
    // (16 workspace-scoped [incl. property definitions] + 6 per-issue
    // prefixes + the workspace working-agents projection + 5 per-chat
    // prefixes + 1 workspaceKeys.list() + 1 cross-workspace inbox unread
    // summary + 1 dependency-projection prefix = 32 calls)
    expect(invalidateSpy).toHaveBeenCalledTimes(32);
  });

  it("does not re-invalidate when rerendered with the same ws instance", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    // Rerender with same instance
    rerender({ ws: ws1 });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates chat, pins, labels, and invitations queries on ws instance change", () => {
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    rerender({ ws: null });

    const ws2 = createMockWs();
    rerender({ ws: ws2 });

    const calls = invalidateSpy.mock.calls.map((call: [{ queryKey?: unknown }, ...unknown[]]) => call[0].queryKey);
    expect(calls).toContainEqual(["chat", "ws-1"]);
    expect(calls).toContainEqual(["labels", "ws-1"]);
    expect(calls).toContainEqual(["workspaces", "ws-1", "invitations"]);
    // A catalog edit made while this client was disconnected is otherwise
    // invisible for the query's whole 5-minute staleTime.
    expect(calls).toContainEqual(issueStatusKeys.all("ws-1"));
  });

  it("invalidates agent projections when a daemon changes liveness", () => {
    vi.useFakeTimers();
    try {
      const ws = createMockWs();
      renderHook(() => useRealtimeSync(ws, stores), {
        wrapper: createWrapper(qc),
      });
      const onAny = vi.mocked(ws.onAny).mock.calls[0]?.[0];
      expect(onAny).toBeDefined();

      invalidateSpy.mockClear();
      onAny!({ type: "daemon:register", payload: {} } as never);
      vi.advanceTimersByTime(100);

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: runtimeKeys.all("ws-1"),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: workspaceKeys.agents("ws-1"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates per-issue caches (no wsId in key) on ws instance change", () => {
    // These keys are not under the ["issues", wsId] prefix, so they need
    // their own invalidation on recovery — otherwise events missed while
    // disconnected leave them stale forever (staleTime: Infinity, #3953).
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    rerender({ ws: null });

    const ws2 = createMockWs();
    rerender({ ws: ws2 });

    const calls = invalidateSpy.mock.calls.map((call: [{ queryKey?: unknown }, ...unknown[]]) => call[0].queryKey);
    expect(calls).toContainEqual(["issues", "timeline"]);
    expect(calls).toContainEqual(["issues", "reactions"]);
    expect(calls).toContainEqual(["issues", "subscribers"]);
    expect(calls).toContainEqual(["issues", "usage"]);
    expect(calls).toContainEqual(["issues", "attachments"]);
    expect(calls).toContainEqual(["issues", "tasks"]);
  });

  it("invalidates per-chat-session caches (no wsId in key) on ws instance change", () => {
    // These keys are not under the ["chat", wsId] prefix, so they need their
    // own recovery invalidation when reconnecting after missed chat/task events.
    const ws1 = createMockWs();
    const { rerender } = renderHook(
      ({ ws }) => useRealtimeSync(ws, stores),
      { initialProps: { ws: ws1 as WSClient | null }, wrapper: createWrapper(qc) },
    );

    invalidateSpy.mockClear();
    rerender({ ws: null });

    const ws2 = createMockWs();
    rerender({ ws: ws2 });

    const calls = invalidateSpy.mock.calls.map((call: [{ queryKey?: unknown }, ...unknown[]]) => call[0].queryKey);
    expect(calls).toContainEqual(["chat", "messages"]);
    expect(calls).toContainEqual(["chat", "messages-page"]);
    expect(calls).toContainEqual(["chat", "pending-task"]);
    expect(calls).toContainEqual(["task-messages"]);
  });

  it("invalidates per-chat-session caches after an established ws reconnects", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    const reconnect = vi.mocked(ws.onReconnect).mock.calls[0]?.[0];
    expect(reconnect).toBeDefined();

    invalidateSpy.mockClear();
    reconnect!();

    const calls = invalidateSpy.mock.calls.map((call: [{ queryKey?: unknown }, ...unknown[]]) => call[0].queryKey);
    expect(calls).toContainEqual(chatKeys.messagesAll());
    expect(calls).toContainEqual(chatKeys.messagesPageAll());
    expect(calls).toContainEqual(chatKeys.pendingTaskAll());
  });

  it("invalidates one issue attachment cache after detached channel media binds", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    const attachmentChanged = vi
      .mocked(ws.on)
      .mock.calls.find(([event]) => event === "issue_attachments:changed")?.[1];
    expect(attachmentChanged).toBeDefined();

    (attachmentChanged as (payload: unknown) => void)({ issue_id: "issue-1" });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: issueKeys.attachments("issue-1"),
    });
  });
  it("refetches the status catalog after an admin changes it elsewhere", async () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    const onAny = vi.mocked(ws.onAny).mock.calls[0]?.[0];
    expect(onAny).toBeDefined();

    onAny!({ type: "issue_status:changed", payload: { action: "created" } } as never);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: issueStatusKeys.all("ws-1"),
    });
    // Deliberately NOT the issue caches. A row stores the status KEY; its name,
    // color and category are resolved from the catalog at render time, so no
    // cached issue field can go stale here. Dragging every board and list along
    // would turn one admin rename into a workspace-wide refetch storm on every
    // connected client. (MUL-6458)
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: issueKeys.all("ws-1"),
    });
  });

  it("ignores removed DingTalk group-route events", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    const onAny = vi.mocked(ws.onAny).mock.calls[0]?.[0];
    expect(onAny).toBeDefined();

    onAny!({ type: "dingtalk_group_route:updated", payload: {} } as never);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates the current workspace chat list when a channel creates a session", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    const sessionCreated = vi
      .mocked(ws.on)
      .mock.calls.find(([event]) => event === "chat:session_created")?.[1];
    expect(sessionCreated).toBeDefined();

    (sessionCreated as (payload: unknown) => void)({
      workspace_id: "ws-1",
      chat_session_id: "channel-session-1",
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: chatKeys.sessions("ws-1"),
    });

		invalidateSpy.mockClear();
		(sessionCreated as (payload: unknown) => void)({
			workspace_id: "ws-2",
			chat_session_id: "other-workspace-session",
		});
		expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useRealtimeSync — queued chat promotion", () => {
  it("refetches the transcript when a queued prompt starts running", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ws = createMockWs();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useRealtimeSync(ws, createStores()), {
      wrapper: createWrapper(qc),
    });
    const dispatch = vi
      .mocked(ws.on)
      .mock.calls.find(([event]) => event === "task:dispatch")?.[1];
    expect(dispatch).toBeDefined();

    invalidate.mockClear();
    (dispatch as (payload: unknown) => void)({
      task_id: "task-follow-up",
      chat_session_id: "session-1",
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: chatKeys.messages("session-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: chatKeys.messagesPage("session-1"),
    });
  });
});

describe("useRealtimeSync — Table server membership invalidation", () => {
  let qc: QueryClient;
  let stores: RealtimeSyncStores;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stores = createStores();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates Table queries after a task lifecycle event", () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    const onAny = vi.mocked(ws.onAny).mock.calls[0]?.[0];
    expect(onAny).toBeDefined();

    onAny!({ type: "task:completed", payload: {} } as never);
    vi.advanceTimersByTime(100);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: issueKeys.tableAll("ws-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: workspaceWorkingAgentsKeys.all("ws-1"),
    });
  });

  it("invalidates Table queries after a property definition changes", () => {
    const ws = createMockWs();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    const propertyUpdated = vi
      .mocked(ws.on)
      .mock.calls.find(([event]) => event === "property:updated")?.[1];
    expect(propertyUpdated).toBeDefined();

    (propertyUpdated as (payload: unknown) => void)({});

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: issueKeys.tableAll("ws-1"),
    });
  });
});

describe("useRealtimeSync — graph snapshot invalidation", () => {
  it.each(["task:completed", "reconnect"])("supersedes the first graph read on %s", async (event) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const before = IssueGraphSchema.parse(referenceGraph);
    const after = { ...before, snapshotId: "after-event" };
    const signals: AbortSignal[] = [];
    let resolveFirst!: (value: IssueGraph) => void;
    const getIssueGraph = vi.fn((_ws: string, _query: unknown, { signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      if (signals.length === 1) return new Promise<IssueGraph>((resolve) => { resolveFirst = resolve; });
      return Promise.resolve(after);
    });
    setApiInstance({ getIssueGraph } as unknown as ApiClient);
    const ws = createMockWs();
    const { unmount } = renderHook(() => useRealtimeSync(ws, createStores()), { wrapper: createWrapper(qc) });
    const observer = new QueryObserver(qc, issueGraphOptions("ws-1", {
      scope: { kind: "workspace" }, filters: {}, sort: { field: "position", direction: "asc" },
    }));
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(getIssueGraph).toHaveBeenCalledTimes(1);
      if (event === "reconnect") void vi.mocked(ws.onReconnect).mock.calls[0]![0]();
      else vi.mocked(ws.onAny).mock.calls[0]![0]({ type: event, payload: {} } as never);
      // Leave the first snapshot in flight until the actual event handler runs,
      // including the task-prefix debounce. No graph data is pre-seeded.
      await vi.waitFor(() => expect(getIssueGraph).toHaveBeenCalledTimes(2));
      expect(signals[0]!.aborted).toBe(true);
      resolveFirst(before);
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.snapshotId).toBe(after.snapshotId));
    } finally {
      unsubscribe();
      unmount();
      qc.clear();
    }
  });

  it("refreshes committed changes and reconnects without patching topology", () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ws = createMockWs();
    const { unmount } = renderHook(() => useRealtimeSync(ws, createStores()), {
      wrapper: createWrapper(qc),
    });
    const key = [...issueKeys.graphAll("ws-1"), "reference"];
    const otherKey = [...issueKeys.graphAll("ws-2"), "reference"];
    const snapshot = { snapshotId: "before", nodes: [{ id: "issue-1" }] };
    const onAny = vi.mocked(ws.onAny).mock.calls[0]![0];
    const emit = (event: string, payload: unknown) => {
      const handler = vi.mocked(ws.on).mock.calls.find(([name]) => name === event)?.[1];
      expect(handler).toBeDefined();
      (handler as (payload: unknown) => void)(payload);
    };
    try {
      const changes = [
        // Compound dependency writes also publish issue:updated.
        () => emit("issue:updated", { issue: { id: "issue-1", revision: 9, parent_issue_id: "new-parent", project_id: "new-project" } }),
        () => emit("property:updated", {}),
        () => emit("issue_attachments:changed", { issue_id: "issue-1", issue_revision: 10 }),
        () => emit("comment:created", { comment: { issue_id: "issue-1" }, issue_revision: 11 }),
        ...["project:updated", "issue_status:changed", "member:removed", "task:dispatch", "task:completed"].map(
          (type) => () => { onAny({ type, payload: {} } as never); vi.advanceTimersByTime(100); },
        ),
        () => { void vi.mocked(ws.onReconnect).mock.calls[0]![0](); },
      ];
      for (const change of changes) {
        qc.setQueryData(key, snapshot);
        qc.setQueryData(otherKey, snapshot);
        change();
        expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
        expect(qc.getQueryData(key)).toBe(snapshot);
        expect(qc.getQueryState(otherKey)?.isInvalidated).toBe(false);
      }
      qc.setQueryData(key, snapshot);
      onAny({ type: "task:message", payload: {} } as never);
      vi.advanceTimersByTime(100);
      expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    } finally {
      unmount();
      qc.clear();
      vi.useRealTimers();
    }
  });
});

describe("useRealtimeSync — workspace:deleted self-initiated suppression", () => {
  let qc: QueryClient;
  let stores: RealtimeSyncStores;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stores = createStores();
  });

  afterEach(() => {
    unmarkWorkspaceDeletePending("ws-2");
    localStorage.clear();
  });

  // getCurrentWsId is mocked to "ws-1" at module level, so deleting "ws-2"
  // never enters the relocate branch — these tests only exercise the
  // storage-cleanup path, which is the observable difference between a
  // handled and a suppressed event.
  const dispatchWorkspaceDeleted = (ws: WSClient, workspaceId: string) => {
    const call = vi
      .mocked(ws.on)
      .mock.calls.find(([event]) => event === "workspace:deleted");
    expect(call).toBeDefined();
    (call![1] as (p: unknown) => void)({ workspace_id: workspaceId });
  };

  it("ignores the event for a delete this client initiated", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    qc.setQueryData(workspaceKeys.list(), [{ id: "ws-2", slug: "delete-me" }]);
    defaultStorage.setItem("multica_issue_draft:delete-me", "draft");

    markWorkspaceDeletePending("ws-2");
    dispatchWorkspaceDeleted(ws, "ws-2");

    // useDeleteWorkspace.onSuccess owns cleanup for self-initiated deletes;
    // the handler must not have touched storage.
    expect(defaultStorage.getItem("multica_issue_draft:delete-me")).toBe("draft");
  });

  it("still cleans up for a delete initiated elsewhere", () => {
    const ws = createMockWs();
    renderHook(() => useRealtimeSync(ws, stores), {
      wrapper: createWrapper(qc),
    });
    qc.setQueryData(workspaceKeys.list(), [{ id: "ws-2", slug: "delete-me" }]);
    defaultStorage.setItem("multica_issue_draft:delete-me", "draft");

    dispatchWorkspaceDeleted(ws, "ws-2");

    expect(defaultStorage.getItem("multica_issue_draft:delete-me")).toBeNull();
  });
});
