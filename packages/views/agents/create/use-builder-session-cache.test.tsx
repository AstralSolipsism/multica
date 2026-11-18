// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { createElement, type ReactElement, type ReactNode } from "react";

const h = vi.hoisted(() => ({
  sendChatMessage: vi.fn(),
  cancelTaskById: vi.fn(),
  deleteChatSession: vi.fn(),
  listChatMessages: vi.fn(),
  getAttachmentTextContent: vi.fn(),
  getPendingChatTask: vi.fn(),
  listChatDraftRestores: vi.fn(),
  store: {
    appliedDraftRestoreIds: [] as string[],
    markDraftRestoreApplied: vi.fn(),
    forgetDraftRestoreApplied: vi.fn(),
    inputDrafts: {} as Record<string, string>,
    inputDraftAttachments: {} as Record<string, unknown[]>,
    setInputDraft: vi.fn(),
    setInputDraftAttachments: vi.fn(),
    pendingSendRestores: {} as Record<string, unknown[]>,
    enqueuePendingSendRestore: vi.fn(),
    dequeuePendingSendRestore: vi.fn(),
  },
}));

vi.mock("@multica/core/api", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/api")>(
    "@multica/core/api",
  );
  return {
    ...actual,
    api: {
      sendChatMessage: h.sendChatMessage,
      cancelTaskById: h.cancelTaskById,
      deleteChatSession: h.deleteChatSession,
      listChatMessages: h.listChatMessages,
      getAttachmentTextContent: h.getAttachmentTextContent,
      getPendingChatTask: h.getPendingChatTask,
      listChatDraftRestores: h.listChatDraftRestores,
    },
  };
});
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/chat", () => ({
  useChatStore: Object.assign((sel: (s: typeof h.store) => unknown) => sel(h.store), {
    getState: () => h.store,
  }),
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    computeItemKey,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactElement;
    computeItemKey: (index: number, item: unknown) => string;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={computeItemKey(index, item)}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));
vi.mock("../../chat/components/chat-input", () => ({ ChatInput: () => null }));

// `@multica/core/realtime` is deliberately NOT mocked: removeChatMessageFromCaches
// is the behaviour under test.

import { chatKeys } from "@multica/core/chat/queries";
import type { Attachment, ChatMessage, ChatMessagesPage } from "@multica/core/types";
import { useBuilderSession } from "./use-builder-session";
import { BuilderConversation } from "./builder-conversation";
import { renderWithI18n } from "../../test/i18n";

const sessionId = "session-1";

function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(
    () => useBuilderSession({ sessionId, encodeInput: (text: string) => text }),
    { wrapper },
  );
  return { qc, result };
}

function BuilderAttachmentHarness() {
  const builder = useBuilderSession({ sessionId, encodeInput: (text: string) => text });
  return (
    <BuilderConversation
      sessionId={sessionId}
      messages={builder.messages}
      loading={builder.messagesLoading}
      attachmentsStatus={builder.attachmentsStatus}
      pendingTask={builder.pendingTask}
      runtimeOnline
      onSend={async () => true}
      onStop={() => {}}
      restoreDraftRequest={null}
      onRestoreDraftApplied={() => {}}
      error={null}
    />
  );
}

function renderBuilderAttachmentConversation() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderWithI18n(
    <QueryClientProvider client={qc}>
      <BuilderAttachmentHarness />
    </QueryClientProvider>,
  );
  return { qc, view };
}

function pagedIds(qc: QueryClient) {
  return qc
    .getQueryData<InfiniteData<ChatMessagesPage>>(chatKeys.messagesPage(sessionId))
    ?.pages.flatMap((p) => p.messages.map((m) => m.id));
}

function flatIds(qc: QueryClient) {
  return qc
    .getQueryData<ChatMessage[]>(chatKeys.messages(sessionId))
    ?.map((m) => m.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.listChatMessages.mockResolvedValue([]);
  h.getPendingChatTask.mockResolvedValue({ task_id: "task-1", status: "running" });
  h.listChatDraftRestores.mockResolvedValue({ restores: [] });
  h.sendChatMessage.mockResolvedValue({
    message_id: "msg-1",
    task_id: "task-1",
    created_at: "2026-08-07T00:00:00Z",
  });
  h.deleteChatSession.mockResolvedValue(undefined);
});

afterEach(cleanup);

// Regression (MUL-5711 review): the Builder send seeds BOTH message caches, so
// every Builder cleanup path has to clear both. `messagesPage` is
// staleTime: Infinity — a copy left behind there stays fresh forever, and any
// chat surface opening the same session reads it instead of the server.
describe("useBuilderSession cache cleanup", () => {
  it("seeds both caches on send", async () => {
    // Server truth once the send is accepted. The Builder holds an active
    // observer on the flat cache, so its reconciling refetch lands on top of the
    // seed within the test — the paged cache has no observer here and keeps the
    // seeded row until something reads it.
    h.listChatMessages.mockResolvedValue([
      {
        id: "msg-1",
        chat_session_id: sessionId,
        role: "user",
        content: "hello",
        task_id: "task-1",
        created_at: "2026-08-07T00:00:00Z",
      },
    ]);
    const { qc, result } = harness();

    await result.current.send("hello");

    await waitFor(() => expect(pagedIds(qc)).toEqual(["msg-1"]));
    await waitFor(() => expect(flatIds(qc)).toEqual(["msg-1"]));
  });

  it("drops both caches when the conversation is discarded", async () => {
    const { qc, result } = harness();

    await result.current.send("hello");
    await waitFor(() => expect(pagedIds(qc)).toEqual(["msg-1"]));

    await result.current.destroy();

    expect(qc.getQueryData(chatKeys.messages(sessionId))).toBeUndefined();
    expect(qc.getQueryData(chatKeys.messagesPage(sessionId))).toBeUndefined();
  });

  it("removes a restored prompt from both caches on stop", async () => {
    const { qc, result } = harness();
    h.cancelTaskById.mockResolvedValue({
      cancelled_chat_message: {
        chat_session_id: sessionId,
        message_id: "msg-1",
        content: "hello",
        restore_to_input: true,
      },
    });

    await result.current.send("hello");
    await waitFor(() => expect(pagedIds(qc)).toEqual(["msg-1"]));

    await result.current.stop();

    // The server deleted this prompt; neither cache may keep serving it.
    expect(pagedIds(qc) ?? []).toEqual([]);
    expect(flatIds(qc) ?? []).toEqual([]);
  });

  it("marks both caches stale when stop fails", async () => {
    const { qc, result } = harness();
    h.cancelTaskById.mockRejectedValue(new Error("nope"));

    await result.current.send("hello");
    await waitFor(() => expect(pagedIds(qc)).toEqual(["msg-1"]));

    // Clear the flag the send's own invalidate raised, so this asserts what
    // STOP did rather than what send did (setQueryData settles the query).
    qc.setQueryData(
      chatKeys.messagesPage(sessionId),
      qc.getQueryData(chatKeys.messagesPage(sessionId)),
    );
    expect(qc.getQueryState(chatKeys.messagesPage(sessionId))?.isInvalidated).toBe(false);

    await result.current.stop();

    // A failed cancel may still have landed server-side, so both caches have to
    // be re-read rather than left pinned by staleTime: Infinity.
    await waitFor(() => {
      expect(qc.getQueryState(chatKeys.messagesPage(sessionId))?.isInvalidated).toBe(true);
    });
  });
});

describe("Builder attachment metadata handoff", () => {
  const content = [
    '```html src="decision.html" title="Builder attachment"',
    "<p>Builder fallback</p>",
    "```",
  ].join("\n");
  const attachment = {
    id: "att-builder",
    filename: "decision.html",
    content_type: "text/html",
    url: "/uploads/decision.html",
    download_url: "/api/attachments/att-builder/download",
    markdown_url: "/api/attachments/att-builder/download",
    size_bytes: 100,
    created_at: "2026-11-18T10:00:00Z",
  } as Attachment;

  function message(attachments?: Attachment[]): ChatMessage {
    return {
      id: "msg-html",
      chat_session_id: sessionId,
      role: "assistant",
      task_id: null,
      content,
      attachments,
      created_at: "2026-11-18T10:00:00Z",
    };
  }

  function startRefetch(qc: QueryClient) {
    act(() => {
      qc.setQueryData(chatKeys.messages(sessionId), [message()]);
    });
    void qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
  }

  async function renderPendingRefetch() {
    h.getPendingChatTask.mockResolvedValue({});
    const pending = Promise.withResolvers<ChatMessage[]>();
    h.listChatMessages
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => pending.promise);
    const { qc } = renderBuilderAttachmentConversation();
    await waitFor(() => {
      expect(qc.getQueryState(chatKeys.messages(sessionId))?.status).toBe("success");
    });
    startRefetch(qc);
    await screen.findByText("Loading preview…");
    expect(screen.queryByText(/Couldn't find HTML attachment/)).toBeNull();
    return { qc, pending };
  }

  it("keeps waiting through a slow refetch and renders the attachment on success", async () => {
    const { pending } = await renderPendingRefetch();
    const contentNode = document.querySelector("[data-rich-content]");

    vi.useFakeTimers();
    try {
      act(() => vi.advanceTimersByTime(2_100));
      expect(screen.getByText("Loading preview…")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    h.getAttachmentTextContent.mockResolvedValue({
      text: "<h1>Builder attachment loaded</h1>",
      originalContentType: "text/html",
    });
    pending.resolve([message([attachment])]);

    const frame = await screen.findByTitle("HTML preview");
    expect(frame.getAttribute("srcdoc")).toContain("Builder attachment loaded");
    expect(frame.getAttribute("srcdoc")).not.toContain("Builder fallback");
    expect(document.querySelector("[data-rich-content]")).toBe(contentNode);
  });

  it("shows a read failure rather than missing when the refetch rejects", async () => {
    const { pending } = await renderPendingRefetch();
    pending.reject(new Error("offline"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load preview");
    expect(alert).not.toHaveTextContent("Couldn't find HTML attachment");
    const frame = screen.getByTitle("HTML preview");
    expect(frame.getAttribute("srcdoc")).toContain("Builder fallback");
    expect(h.getAttachmentTextContent).not.toHaveBeenCalled();
  });
});
