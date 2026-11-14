import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { chatKeys } from "@multica/core/chat/queries";
import type { ChatMessage, TaskMessagePayload } from "@multica/core/types";
import {
  chatListScroller,
  setupChatListScrollDom,
} from "../../test/chat-list-scroll-harness";
import { renderWithI18n } from "../../test/i18n";
import { BuilderConversation } from "./builder-conversation";

// OL-420: the studio's preview conversation shares ChatMessageList with the
// chat surfaces, whose follow now releases after one line of upward scrolling
// (OL-272). The builder's send path must bump `resumeFollowNonce` so an
// accepted send re-engages the live-end follow — otherwise a reader who
// peeked up one notch would have their own message and the streaming reply
// growing silently below the fold. The nonce-to-pin behavior itself is
// canonical in chat-message-list.autoscroll.test.tsx; this suite covers the
// builder wiring: detach follow → send → land back at the live end.

vi.mock("react-virtuoso", async () => {
  const { ChatListVirtuosoMock } = await import(
    "../../test/chat-list-scroll-harness"
  );
  return { Virtuoso: ChatListVirtuosoMock };
});

// The composer is not under test — only that the send it triggers goes
// through the nonce-bumping path. A single Send button stands in for it.
vi.mock("../../chat/components/chat-input", () => ({
  ChatInput: ({
    onSend,
  }: {
    onSend: (
      content: string,
      attachmentIds: string[] | undefined,
      commitInput: () => void,
      draftAttachments: never[],
    ) => unknown;
  }) => (
    <button
      type="button"
      onClick={() => void onSend("hello", undefined, () => {}, [])}
    >
      Send
    </button>
  ),
}));

setupChatListScrollDom();
afterEach(cleanup);

const SESSION_ID = "session-1";
const TASK_ID = "6af44cbe-80ab-4dfe-b07d-bd3cfd588f4d";

function taskMsg(seq: number, content: string): TaskMessagePayload {
  return { task_id: TASK_ID, seq, type: "text", content } as TaskMessagePayload;
}

function userMessage(content: string): ChatMessage {
  return {
    id: "m-1",
    chat_session_id: SESSION_ID,
    role: "user",
    content,
    task_id: null,
    created_at: "2026-10-22T00:00:00Z",
  } as ChatMessage;
}

function renderBuilderConversation(onSend: (content: string, commitInput?: () => void) => Promise<boolean>) {
  const qc = new QueryClient();
  qc.setQueryData(chatKeys.taskMessages(TASK_ID), [taskMsg(0, "Looking into it. ")]);

  const view = renderWithI18n(
    <QueryClientProvider client={qc}>
      <BuilderConversation
        sessionId={SESSION_ID}
        messages={[userMessage("Draft a polite agent")]}
        loading={false}
        pendingTask={{ task_id: TASK_ID, status: "running" }}
        runtimeOnline
        onSend={onSend}
        onStop={() => {}}
        restoreDraftRequest={null}
        onRestoreDraftApplied={() => {}}
        error={null}
      />
    </QueryClientProvider>,
  );

  const el = view.container.querySelector<HTMLElement>("[data-tab-scroll-root]");
  if (!el) throw new Error("builder conversation did not render a scroll container");

  return {
    qc,
    view,
    scroll: chatListScroller(el),
    followsAtBottom: () =>
      view.container
        .querySelector("[data-follow-at-bottom]")
        ?.getAttribute("data-follow-at-bottom"),
    streamChunk: (seq: number) => {
      act(() => {
        qc.setQueryData<TaskMessagePayload[]>(
          chatKeys.taskMessages(TASK_ID),
          (old = []) => [...old, taskMsg(seq, `chunk ${seq} `)],
        );
      });
    },
  };
}

describe("BuilderConversation send-follow wiring", () => {
  // Acceptance 1: a send accepted by the server jumps the list to the
  // reader's own message and re-engages the follow, so the streaming reply
  // keeps the live end pinned.
  it("resumes following at the live end once the send is accepted", async () => {
    let resolveSend!: (sent: boolean) => void;
    const onSend = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveSend = resolve)),
    );
    const { scroll, streamChunk, followsAtBottom } = renderBuilderConversation(onSend);

    // One wheel notch up releases the follow (OL-272) — the reader is now
    // parked above the live end while the reply streams on below.
    scroll.readerScrollsUp(100);
    expect(followsAtBottom()).toBe("false");
    expect(scroll.distanceFromBottom()).toBe(100);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello", expect.any(Function));
    // The bump waits for the server to accept the send — a still-pending
    // roundtrip must not move the reader.
    expect(scroll.pinCalls()).toHaveLength(0);
    expect(scroll.distanceFromBottom()).toBe(100);

    await act(async () => {
      resolveSend(true);
    });
    expect(scroll.pinCalls()).toEqual([{ index: "LAST", align: "end" }]);
    expect(scroll.distanceFromBottom()).toBe(0);

    // The reply streaming in after their send keeps them pinned.
    streamChunk(1);
    scroll.grow(180);
    expect(scroll.pinCalls()).toHaveLength(2);
    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // Acceptance 2's builder side: a send the server rejects is not the
  // reader's message arriving — the parked position must not be disturbed.
  it("leaves a scrolled-up reader alone when the send fails", async () => {
    let resolveSend!: (sent: boolean) => void;
    const onSend = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveSend = resolve)),
    );
    const { scroll, streamChunk } = renderBuilderConversation(onSend);

    scroll.readerScrollsUp(100);
    const parked = scroll.scrollTop;

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {
      resolveSend(false);
    });

    expect(scroll.pinCalls()).toHaveLength(0);
    streamChunk(1);
    scroll.grow(180);
    expect(scroll.scrollTop).toBe(parked);
  });
});
