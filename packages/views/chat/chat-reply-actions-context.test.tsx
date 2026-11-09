import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockNativeDialog } from "../editor/test-utils/native-dialog";

// vi.mock factories are hoisted above the static imports, so the locale JSON
// can only be pulled in dynamically here (same idiom as html-block-preview.test.tsx).
vi.mock("../i18n", async () => {
  const editor = (await import("../locales/en/editor.json")).default;
  return {
    useT: () => ({
      t: (select: (bundle: typeof editor) => string, values?: Record<string, unknown>) =>
        select(editor).replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? "")),
    }),
  };
});

vi.mock("../editor/code-block-static", () => ({
  CodeBlockStatic: ({ body }: { body: string }) => (
    <pre data-testid="code-block-static">{body}</pre>
  ),
}));

// The provider only reads activeSessionId (for the attempt key); a plain
// in-memory store mock is enough and lets tests switch sessions.
vi.mock("@multica/core/chat", () => {
  const state = { activeSessionId: "session-1" as string | null };
  return {
    useChatStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

import { HtmlBlockPreview } from "../editor/html-block-preview";
import { HTML_BLOCK_MESSAGE_KEY } from "../editor/utils/html-block-document";
import { CurrentIssueRenderContextProvider } from "../issues/current-issue-render-context";
import {
  ChatReplyActionsProvider,
  useChatReplyActions,
  useChatReplyAdoptRequest,
  type ChatReplyActions,
  type ChatSurfaceSend,
} from "./chat-reply-actions-context";
import { useChatStore } from "@multica/core/chat";

type MockSend = ReturnType<typeof vi.fn<ChatSurfaceSend>>;

let restoreDialog: () => void;
beforeEach(() => {
  window.sessionStorage.clear();
  restoreDialog = mockNativeDialog();
  useChatStore.getState().activeSessionId = "session-1";
});
afterEach(() => {
  cleanup();
  restoreDialog();
  vi.restoreAllMocks();
});

function inlineFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>('[data-dynamic-block="html"] iframe');
  expect(frame).not.toBeNull();
  return frame!;
}

/** What the bridge inside the sandbox posts to the page. */
function post(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { [HTML_BLOCK_MESSAGE_KEY]: 1, ...data },
        source: frame.contentWindow,
      }),
    );
  });
}

const result = (action: string, ok: boolean) => ({
  __multicaHtmlBlock: 1,
  type: "action-result",
  action,
  ok,
});

/** Exposes the context actions to the test. */
function ActionsProbe({ ref }: { ref: { current: ChatReplyActions | null } }) {
  ref.current = useChatReplyActions();
  return null;
}

function renderActionsProbe(handleSend: MockSend, extra?: React.ReactElement) {
  const ref: { current: ChatReplyActions | null } = { current: null };
  const view = render(
    <ChatReplyActionsProvider handleSend={handleSend}>
      <ActionsProbe ref={ref} />
      {extra}
    </ChatReplyActionsProvider>,
  );
  return { ...view, ref };
}

/** A decision card inside a chat conversation, as both surfaces mount it. */
function mountCard(handleSend: MockSend) {
  const view = render(
    <ChatReplyActionsProvider handleSend={handleSend}>
      <HtmlBlockPreview html="<p>decision</p>" />
    </ChatReplyActionsProvider>,
  );
  const frame = inlineFrame();
  const reply = vi.spyOn(frame.contentWindow!, "postMessage");
  return { ...view, frame, reply };
}

describe("ChatReplyActionsProvider — retry contract", () => {
  it("reuses the same clientMessageId when an unanswered send is retried unchanged", async () => {
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { ref } = renderActionsProbe(handleSend);

    await act(async () => {
      expect(await ref.current!.submit("拍板：方案 B", "card-1")).toBe(false);
      expect(await ref.current!.submit("拍板：方案 B", "card-1")).toBe(true);
    });
    const [first, second] = handleSend.mock.calls;
    expect(second![4]!.clientMessageId).toBe(first![4]!.clientMessageId);
    // Same record object — handleSend pins attempt.sessionId into it, and the
    // retry must carry that pinned session back.
    expect(second![4]).toBe(first![4]);
  });

  it("passes the card content through with explicit empty-send arguments", async () => {
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(true);
    const { ref } = renderActionsProbe(handleSend);
    await act(async () => {
      await ref.current!.submit("answer", "card-1");
    });
    const [call] = handleSend.mock.calls;
    expect(call![0]).toBe("answer");
    expect(call![1]).toBeUndefined();
    expect(call![2]).toBeUndefined();
    expect(call![3]).toEqual([]);
    expect(typeof call![4]!.clientMessageId).toBe("string");
  });

  it("mints a fresh clientMessageId for a changed answer", async () => {
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(false);
    const { ref } = renderActionsProbe(handleSend);
    await act(async () => {
      await ref.current!.submit("answer A", "card-1");
      await ref.current!.submit("answer B", "card-1");
    });
    const [first, second] = handleSend.mock.calls;
    expect(second![4]!.clientMessageId).not.toBe(first![4]!.clientMessageId);
  });

  it("clears the record on success so a repeat send is a new attempt", async () => {
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(true);
    const { ref } = renderActionsProbe(handleSend);
    await act(async () => {
      await ref.current!.submit("answer", "card-1");
      await ref.current!.submit("answer", "card-1");
    });
    const [first, second] = handleSend.mock.calls;
    expect(second![4]!.clientMessageId).not.toBe(first![4]!.clientMessageId);
  });

  it("keys the attempt per card and per session", async () => {
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(false);
    const { ref } = renderActionsProbe(handleSend);
    await act(async () => {
      await ref.current!.submit("answer", "card-1");
      await ref.current!.submit("answer", "card-2");
      useChatStore.getState().activeSessionId = "session-2";
      await ref.current!.submit("answer", "card-1");
    });
    const ids = handleSend.mock.calls.map((call) => call[4]!.clientMessageId);
    expect(new Set(ids).size).toBe(3);
  });

  it("returns false and retains the attempt when handleSend throws", async () => {
    const handleSend = vi.fn<ChatSurfaceSend>().mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce(true);
    const { ref } = renderActionsProbe(handleSend);
    await act(async () => {
      expect(await ref.current!.submit("answer", "card-1")).toBe(false);
      expect(await ref.current!.submit("answer", "card-1")).toBe(true);
    });
    const [first, second] = handleSend.mock.calls;
    expect(second![4]!.clientMessageId).toBe(first![4]!.clientMessageId);
  });

  it("publishes fill requests the composer can adopt", () => {
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(true);
    let adopted: { id: number; content: string } | null = null;
    function AdoptProbe() {
      adopted = useChatReplyAdoptRequest();
      return null;
    }
    const { ref } = renderActionsProbe(handleSend, <AdoptProbe />);
    expect(adopted).toBeNull();
    act(() => ref.current!.fill("card answer"));
    expect(adopted).toEqual({ id: expect.any(Number), content: "card answer" });
    act(() => ref.current!.fill("second answer"));
    expect(adopted!.content).toBe("second answer");
    expect(adopted!.id).toBeGreaterThan(1);
  });
});

describe("HTML block inside a chat conversation", () => {
  const activation = { isActive: false };
  beforeEach(() => {
    activation.isActive = false;
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
  });
  afterEach(() => {
    delete (navigator as { userActivation?: unknown }).userActivation;
    document.documentElement.className = "";
  });

  it("submits through handleSend and acknowledges ok", async () => {
    activation.isActive = true;
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(true);
    const { frame, reply } = mountCard(handleSend);
    post(frame, { type: "submit-comment", content: "拍板：方案 B" });
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith(result("submit-comment", true), "*"));
    expect(handleSend).toHaveBeenCalledExactlyOnceWith(
      "拍板：方案 B", undefined, undefined, [], expect.objectContaining({ clientMessageId: expect.any(String) }),
    );
  });

  it("reuses the clientMessageId when the card is retried after a lost response", async () => {
    activation.isActive = true;
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { frame, reply } = mountCard(handleSend);
    post(frame, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledWith(result("submit-comment", false), "*"));
    post(frame, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledWith(result("submit-comment", true), "*"));
    const [first, second] = handleSend.mock.calls;
    expect(second![4]!.clientMessageId).toBe(first![4]!.clientMessageId);
  });

  it("keeps the card's retry identity across a reload (the document key changes, the card key does not)", async () => {
    activation.isActive = true;
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { frame, reply } = mountCard(handleSend);
    post(frame, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledWith(result("submit-comment", false), "*"));

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const fresh = inlineFrame();
    const freshReply = vi.spyOn(fresh.contentWindow!, "postMessage");
    post(fresh, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(freshReply).toHaveBeenCalledWith(result("submit-comment", true), "*"));
    const [first, second] = handleSend.mock.calls;
    expect(second![4]!.clientMessageId).toBe(first![4]!.clientMessageId);
  });

  it("rejects actions without transient activation, before handleSend", async () => {
    const handleSend = vi.fn<ChatSurfaceSend>();
    const { frame, reply } = mountCard(handleSend);
    post(frame, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith(result("submit-comment", false), "*"));
    expect(handleSend).not.toHaveBeenCalled();
  });

  it("keeps the card's retry identity across a theme rebuild (the srcdoc changes, the card key does not)", async () => {
    activation.isActive = true;
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { frame, reply } = mountCard(handleSend);
    post(frame, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledWith(result("submit-comment", false), "*"));
    const srcDocBefore = frame.getAttribute("srcdoc");

    // Flip the theme the way the app does: a class change on <html> bumps
    // useThemeVersion, and the rebuilt document picks up the new computed
    // tokens — here a different font on the host, exactly what a real theme
    // switch delivers through inheritance.
    const host = frame.closest<HTMLElement>("div.contents")!;
    expect(host).not.toBeNull();
    host.style.fontFamily = "DarkThemeFont";
    act(() => { document.documentElement.className = "theme-dark"; });
    await waitFor(() => expect(inlineFrame().getAttribute("srcdoc")).not.toBe(srcDocBefore));

    const rebuilt = inlineFrame();
    const rebuiltReply = vi.spyOn(rebuilt.contentWindow!, "postMessage");
    post(rebuilt, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(rebuiltReply).toHaveBeenCalledWith(result("submit-comment", true), "*"));
    const [first, second] = handleSend.mock.calls;
    expect(second![4]!.clientMessageId).toBe(first![4]!.clientMessageId);
  });

  it("fills the composer draft and acknowledges ok", async () => {
    activation.isActive = true;
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(true);
    let filled: string | null = null;
    function FillProbe() {
      const adopt = useChatReplyAdoptRequest();
      filled = adopt?.content ?? null;
      return null;
    }
    render(
      <ChatReplyActionsProvider handleSend={handleSend}>
        <FillProbe />
        <HtmlBlockPreview html="<p>decision</p>" />
      </ChatReplyActionsProvider>,
    );
    const frame = inlineFrame();
    const reply = vi.spyOn(frame.contentWindow!, "postMessage");
    post(frame, { type: "fill-comment", content: "card answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith(result("fill-comment", true), "*"));
    expect(filled).toBe("card answer");
    expect(handleSend).not.toHaveBeenCalled();
  });

  it("routes to the issue context when both providers are mounted (issue actions win)", async () => {
    activation.isActive = true;
    const handleSend = vi.fn<ChatSurfaceSend>().mockResolvedValue(true);
    const submitComment = vi.fn().mockResolvedValue(true);
    const fillCommentDraft = vi.fn();
    render(
      <ChatReplyActionsProvider handleSend={handleSend}>
        <CurrentIssueRenderContextProvider
          value={{ id: "issue-1", identifier: "OL-1301", submitComment, fillCommentDraft }}
        >
          <HtmlBlockPreview html="<p>decision</p>" />
        </CurrentIssueRenderContextProvider>
      </ChatReplyActionsProvider>,
    );
    const frame = inlineFrame();
    const reply = vi.spyOn(frame.contentWindow!, "postMessage");
    post(frame, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledWith(result("submit-comment", true), "*"));
    // Second action only after the first reply — one request at a time.
    post(frame, { type: "fill-comment", content: "answer" });
    await waitFor(() => expect(submitComment).toHaveBeenCalledExactlyOnceWith("answer"));
    await waitFor(() => expect(fillCommentDraft).toHaveBeenCalledExactlyOnceWith("answer"));
    expect(handleSend).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(result("fill-comment", true), "*");
  });

  it("does nothing when no provider is mounted", () => {
    activation.isActive = true;
    render(<HtmlBlockPreview html="<p>decision</p>" />);
    const frame = inlineFrame();
    const reply = vi.spyOn(frame.contentWindow!, "postMessage");
    post(frame, { type: "submit-comment", content: "answer" });
    post(frame, { type: "fill-comment", content: "answer" });
    expect(reply).not.toHaveBeenCalled();
  });
});
