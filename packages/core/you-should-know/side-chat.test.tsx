/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ApiError } from "../api/labrastro-api-error";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { chatKeys } from "../chat/queries";
import type { ChatSession } from "../types/chat";
import { tipChatBlockReason, useOpenTipChat, useTipSideChatLookup } from "./side-chat";

vi.mock("../hooks", () => ({ useWorkspaceId: () => "ws-1" }));

const WS = "ws-1";

const source = {
  tip_id: "tip-1",
  issue_id: "issue-1",
  issue_identifier: "OL-123",
  source_task_id: "run-1",
  tip: {
    tag: "heads_up" as const,
    line: "Kept the old API",
    title: "Old API kept",
    explanation: "Clients still call it.",
    status: "valid" as const,
    overturned_reason: null,
    overturned_by_comment_id: null,
  },
};

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "side-1",
    workspace_id: WS,
    agent_id: "agent-1",
    creator_id: "user-1",
    project_id: "project-1",
    title: "OL-123 · Old API kept",
    status: "active",
    has_unread: false,
    created_at: "2026-10-13T00:00:00Z",
    updated_at: "2026-10-13T00:00:00Z",
    ...overrides,
  };
}

function refusal(status: number, code: string) {
  return new ApiError("refused", status, "", { error: "refused", code });
}

let qc: QueryClient;
const apiMock = {
  openTipChat: vi.fn(),
  getChatSession: vi.fn(),
  setTipState: vi.fn(),
};

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of Object.values(apiMock)) fn.mockReset();
  setApiInstance(apiMock as unknown as ApiClient);
});

afterEach(() => qc.clear());

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useOpenTipChat", () => {
  it("opens through the API and seeds the detail entry, leaving the tip's state alone", async () => {
    const opened = session({ tip_source: source });
    apiMock.openTipChat.mockResolvedValueOnce(opened);
    const { result } = renderHook(() => useOpenTipChat(), { wrapper: Wrapper });

    let returned: ChatSession | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync("tip-1");
    });

    expect(returned).toEqual(opened);
    expect(apiMock.openTipChat).toHaveBeenCalledExactlyOnceWith("tip-1");
    expect(qc.getQueryData(chatKeys.session(WS, "side-1"))).toEqual(opened);
    expect(apiMock.setTipState).not.toHaveBeenCalled();
  });

  it("refreshes a listed chat the server just unarchived", async () => {
    const listedRow = session({ status: "archived", title: "Renamed", unread_count: 0, pinned: true });
    qc.setQueryData(chatKeys.sessions(WS), [session({ id: "other" }), listedRow]);
    apiMock.openTipChat.mockResolvedValueOnce(
      session({ status: "active", title: "Renamed", tip_source: source }),
    );
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useOpenTipChat(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync("tip-1");
    });

    const rows = qc.getQueryData<ChatSession[]>(chatKeys.sessions(WS))!;
    // List-only fields survive; status follows the server.
    expect(rows[1]).toEqual({ ...listedRow, status: "active", tip_source: source });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.sessions(WS) });
  });

  it("retries once when the issue changed projects while opening", async () => {
    apiMock.openTipChat
      .mockRejectedValueOnce(refusal(409, "tip_source_changed"))
      .mockResolvedValueOnce(session({ tip_source: source }));
    const { result } = renderHook(() => useOpenTipChat(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync("tip-1");
    });
    expect(apiMock.openTipChat).toHaveBeenCalledTimes(2);
  });

  it.each(["invocation_not_allowed", "agent_archived", "agent_no_runtime"] as const)(
    "surfaces the refusal %s without retrying",
    async (code) => {
      apiMock.openTipChat.mockRejectedValue(refusal(code === "invocation_not_allowed" ? 403 : 409, code));
      const { result } = renderHook(() => useOpenTipChat(), { wrapper: Wrapper });

      let error: unknown;
      await act(async () => {
        await result.current.mutateAsync("tip-1").catch((err: unknown) => {
          error = err;
        });
      });
      expect(apiMock.openTipChat).toHaveBeenCalledTimes(1);
      expect(tipChatBlockReason(error)).toBe(code);
    },
  );

  it("reads no refusal from other failures", () => {
    expect(tipChatBlockReason(refusal(404, "not_found"))).toBeNull();
    expect(tipChatBlockReason(new Error("network"))).toBeNull();
    expect(tipChatBlockReason(null)).toBeNull();
  });
});

describe("useTipSideChatLookup", () => {
  function lookup(activeSessionId: string | null, sessions: ChatSession[], sessionsLoaded = true) {
    return renderHook(
      ({ id, rows, loaded }) => useTipSideChatLookup(WS, id, rows, loaded),
      { wrapper: Wrapper, initialProps: { id: activeSessionId, rows: sessions, loaded: sessionsLoaded } },
    );
  }

  it("uses a listed row without asking the server", () => {
    const row = session({ id: "listed" });
    const { result } = lookup("listed", [row]);
    expect(result.current).toEqual({ currentSession: row, pending: false, pinsAgent: false });
    expect(apiMock.getChatSession).not.toHaveBeenCalled();
  });

  it("pins the agent of a listed side chat", () => {
    const row = session({ id: "listed", tip_source: source });
    const { result } = lookup("listed", [row]);
    expect(result.current.pinsAgent).toBe(true);
  });

  it("answers from a just-opened side chat at once, even before the list loads", () => {
    const opened = session({ tip_source: source });
    qc.setQueryData(chatKeys.session(WS, opened.id), opened);
    const { result } = lookup(opened.id, [], false);
    expect(result.current).toEqual({ currentSession: opened, pending: false, pinsAgent: true });
    expect(apiMock.getChatSession).not.toHaveBeenCalled();
  });

  it("looks up an unlisted id once the list has loaded, pinning the agent meanwhile", async () => {
    let answer!: (value: ChatSession) => void;
    apiMock.getChatSession.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { result } = lookup("side-1", [session({ id: "listed" })]);

    expect(result.current).toEqual({ currentSession: null, pending: true, pinsAgent: true });
    expect(apiMock.getChatSession).toHaveBeenCalledExactlyOnceWith("side-1");

    const fetched = session({ tip_source: source });
    await act(async () => answer(fetched));
    await waitFor(() =>
      expect(result.current).toEqual({ currentSession: fetched, pending: false, pinsAgent: true }),
    );
  });

  it("does not ask while the list is still loading", () => {
    const { result } = lookup("side-1", [], false);
    expect(result.current).toEqual({ currentSession: null, pending: false, pinsAgent: false });
    expect(apiMock.getChatSession).not.toHaveBeenCalled();
  });

  it("neither looks up nor pins a chat this client just created by sending", () => {
    // The send seeds the new chat's pending task before publishing its id;
    // the list refetch that will carry it may still be on its way.
    qc.setQueryData(chatKeys.pendingTask("new-1"), {
      task_id: "11111111-1111-4111-8111-111111111111",
      status: "queued",
    });
    const { result } = lookup("new-1", [session({ id: "listed" })]);
    expect(result.current).toEqual({ currentSession: null, pending: false, pinsAgent: false });
    expect(apiMock.getChatSession).not.toHaveBeenCalled();
  });

  it("holds on, pinned, after a failure other than gone", async () => {
    apiMock.getChatSession.mockRejectedValue(new ApiError("unavailable", 503, "Service Unavailable"));
    const { result } = lookup("side-1", []);
    await waitFor(() => expect(apiMock.getChatSession).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() =>
      expect(qc.getQueryState(chatKeys.session(WS, "side-1"))?.status).toBe("error"),
    );
    expect(result.current).toEqual({ currentSession: null, pending: true, pinsAgent: true });
  });

  it("leaves an ordinary unlisted session to the surface's own handling", async () => {
    apiMock.getChatSession.mockResolvedValueOnce(session({ id: "plain" }));
    const { result } = lookup("plain", []);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current).toEqual({ currentSession: null, pending: false, pinsAgent: false });
  });

  it("treats a 404 as gone, without a retry", async () => {
    qc = new QueryClient();
    apiMock.getChatSession.mockRejectedValue(new ApiError("not found", 404, "Not Found"));
    const { result } = lookup("deleted", []);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.currentSession).toBeNull();
    expect(apiMock.getChatSession).toHaveBeenCalledTimes(1);
  });

  it("drops a cached side chat the server no longer has", async () => {
    qc.setQueryData(chatKeys.session(WS, "side-1"), session({ tip_source: source }));
    apiMock.getChatSession.mockRejectedValue(new ApiError("not found", 404, "Not Found"));
    const { result } = lookup("side-1", []);
    expect(result.current.currentSession?.id).toBe("side-1");

    await act(async () => {
      await qc.refetchQueries({ queryKey: chatKeys.session(WS, "side-1") });
    });
    await waitFor(() =>
      expect(result.current).toEqual({ currentSession: null, pending: false, pinsAgent: false }),
    );
  });
});
