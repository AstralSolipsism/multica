import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { chatKeys } from "@multica/core/chat/queries";
import type { TaskMessagePayload } from "@multica/core/types";
import {
  chatListScroller,
  gestureSettles,
  observedTargets,
  renderFrame,
  setupChatListScrollDom,
  SCROLL_VIEWPORT as VIEWPORT,
} from "../../test/chat-list-scroll-harness";
import enChat from "../../locales/en/chat.json";
import { ChatMessageList } from "./chat-message-list";

// Auto-scroll wiring: the list must keep the live end visible through streaming
// growth and composer resizes, releasing only on real reader input. The latch
// decision table is canonical in transcript-follow.test.ts and the scroll
// geometry in stick-to-bottom.test.ts; this suite drives the real component
// through the DOM signals those decisions are wired to. Reader gestures here
// are wheel INPUT followed by the scroll it causes — position-only moves model
// the browser (clamps), input-led moves model the reader.

vi.mock("react-virtuoso", async () => {
  const { ChatListVirtuosoMock } = await import(
    "../../test/chat-list-scroll-harness"
  );
  return { Virtuoso: ChatListVirtuosoMock };
});

setupChatListScrollDom();

const TEST_RESOURCES = { en: { chat: enChat } };
const TASK_ID = "6af44cbe-80ab-4dfe-b07d-bd3cfd588f4d";

function taskMsg(seq: number, content: string): TaskMessagePayload {
  return { task_id: TASK_ID, seq, type: "text", content } as TaskMessagePayload;
}

function renderStreamingChat({ contentHeight = 2000 } = {}) {
  const qc = new QueryClient();
  qc.setQueryData(chatKeys.taskMessages(TASK_ID), [taskMsg(0, "Looking into it. ")]);

  const tree = (resumeFollowNonce = 0) => (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>
        <ChatMessageList
          messages={[]}
          pendingTask={{ task_id: TASK_ID, status: "running" }}
          availability={undefined}
          resumeFollowNonce={resumeFollowNonce}
        />
      </QueryClientProvider>
    </I18nProvider>
  );
  const view = render(tree());

  const el = view.container.querySelector<HTMLElement>("[data-tab-scroll-root]");
  if (!el) throw new Error("chat list did not render a scroll container");

  return {
    qc,
    view,
    scroll: chatListScroller(el, contentHeight),
    rowCount: () => view.container.querySelectorAll("[data-row-key]").length,
    followsAtBottom: () =>
      view.container
        .querySelector("[data-follow-at-bottom]")
        ?.getAttribute("data-follow-at-bottom"),
    /** The surface's send path bumping the resume-follow nonce. */
    sendOwnMessage: (nonce = 1) => {
      act(() => {
        view.rerender(tree(nonce));
      });
    },
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

describe("ChatMessageList auto-scroll", () => {
  it("follows a streaming reply whose row count never changes", () => {
    const { scroll, streamChunk, rowCount } = renderStreamingChat();

    const rowsBefore = rowCount();
    for (let seq = 1; seq <= 30; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(rowCount()).toBe(rowsBefore);
    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // MUL-6879: the pin used to write `scrollTop = scrollHeight - clientHeight`
  // on the container. In a virtualised list that height is an estimate over
  // the unrendered rows, so the pin landed Virtuoso somewhere it then
  // re-measured, moving the estimate — and the next height change pinned
  // again. The loop swallowed the reader's wheel scrolls, leaving the list
  // shaking and immovable. Corrections must go through Virtuoso.
  it("corrects through Virtuoso rather than writing scrollTop on the container", () => {
    const { scroll } = renderStreamingChat();

    scroll.grow(180);
    scroll.shrinkViewport(72);

    expect(scroll.pinCalls()).toEqual([
      { index: "LAST", align: "end" },
      { index: "LAST", align: "end" },
    ]);
    expect(scroll.directScrollTopWrites()).toBe(0);
  });

  // MUL-6879: Virtuoso opens the list by scrolling to where it PREDICTS the
  // newest message is, paints there, and only then measures the rows and
  // corrects — so the first painted frame showed the wrong part of the
  // conversation and the next one jumped. Readiness is judged from the
  // newest row's own box, because during the estimate the scroll geometry
  // reports the viewport as being at the live end.
  it("stays hidden until the newest message has actually landed at the bottom", () => {
    const { view, scroll } = renderStreamingChat();

    const box = (el: Element, top: number, bottom: number) => {
      el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
    };
    box(scroll.el, 0, VIEWPORT);
    const liveEndRow = view.container.querySelector("[data-chat-live-end]");
    if (!liveEndRow) throw new Error("the newest row is not marked as the live end");

    const frames = (count: number) => {
      for (let i = 0; i < count; i++) act(() => renderFrame());
    };

    expect(scroll.el.className).toContain("invisible");

    // Rows are on screen, but sitting where the estimate put them: below the
    // fold, still to be corrected. This is the frame that used to flicker.
    box(liveEndRow, 4600, 5200);
    frames(20);
    expect(scroll.el.className).toContain("invisible");

    // The correction lands and the newest row reaches the bottom — but the
    // list holds until the content has stopped moving there.
    box(liveEndRow, VIEWPORT - 200, VIEWPORT - 16);
    frames(2);
    expect(scroll.el.className).toContain("invisible");

    frames(20);
    expect(scroll.el.className).not.toContain("invisible");
  });

  // A row settling after its first paint — an image decoding, a code block
  // highlighting — moves the content under a reader pinned to the bottom.
  // Reaching the live end once is not enough to reveal (MUL-6879).
  it("keeps waiting while rows are still changing size at the live end", () => {
    const { view, scroll } = renderStreamingChat();

    const box = (el: Element, top: number, bottom: number) => {
      el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
    };
    box(scroll.el, 0, VIEWPORT);
    const liveEndRow = view.container.querySelector("[data-chat-live-end]");
    if (!liveEndRow) throw new Error("the newest row is not marked as the live end");
    box(liveEndRow, VIEWPORT - 200, VIEWPORT - 16);

    // Content keeps arriving: every settle window restarts.
    for (let i = 0; i < 6; i++) {
      scroll.grow(120);
      act(() => renderFrame());
      act(() => renderFrame());
    }
    expect(scroll.el.className).toContain("invisible");

    // It stops, and the list appears.
    for (let i = 0; i < 20; i++) act(() => renderFrame());
    expect(scroll.el.className).not.toContain("invisible");
  });

  it("keeps the newest content clear of a composer that grew", () => {
    const { scroll } = renderStreamingChat();

    scroll.shrinkViewport(72);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("stays pinned when the composer collapses", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    streamChunk(1);
    scroll.grow(180);
    scroll.growViewport(72);

    for (let seq = 2; seq <= 3; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("stays pinned when content shrinks", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    streamChunk(1);
    scroll.grow(180);
    scroll.shrinkContent(400);

    for (let seq = 2; seq <= 3; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // The base behavior `atBottomThreshold` always granted: a trackpad nudge
  // inside the edge zone is not the reader leaving.
  it("keeps following after a small trackpad nudge near the live end", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.readerScrollsUp(2);
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("releases when touch momentum carries a flick past the threshold", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.touchStart(100);
    scroll.touchMove(180, 80);
    scroll.touchEnd();
    scroll.touchMomentumScrollsUp(80);
    const parked = scroll.scrollTop;

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  it("leaves a fractional touch drag in progress", () => {
    const { scroll, streamChunk, followsAtBottom } = renderStreamingChat();

    scroll.touchStart(100);
    scroll.touchMove(180, 30.5);
    streamChunk(1);

    expect(scroll.distanceFromBottom()).toBe(30.5);
    expect(followsAtBottom()).toBe("auto");
    scroll.touchEnd();
  });

  it("releases when a touch drag passes one line of displacement", () => {
    const { scroll, streamChunk, followsAtBottom } = renderStreamingChat();

    scroll.touchStart(100);
    scroll.touchMove(200, 100);
    streamChunk(1);

    // The follow is off, so an append stops auto-scrolling; the drag itself
    // was never fought (pins stay suppressed while the finger is down).
    expect(scroll.distanceFromBottom()).toBe(100);
    expect(followsAtBottom()).toBe("false");
    scroll.touchEnd();
  });

  it("resumes pinning after a sub-threshold touch ends", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.touchStart(100);
    scroll.touchMove(130, 30);
    scroll.touchEnd();
    gestureSettles();
    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // OL-272 acceptance: having just landed at the bottom of a session, the
  // FIRST wheel notch must leave the live end for good — no pull-back while
  // rows are still settling (image decodes, code highlighting) and no second
  // notch needed.
  it("releases on the first wheel notch while content is still settling", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.readerScrollsUp(100);
    expect(scroll.distanceFromBottom()).toBe(100);
    expect(scroll.pinCalls()).toHaveLength(0);

    for (let seq = 1; seq <= 4; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    // Every growth lands below the fold, exactly where the reader left it.
    expect(scroll.distanceFromBottom()).toBe(100 + 4 * 180);
    expect(scroll.pinCalls()).toHaveLength(0);
  });

  it("accumulates sub-threshold scrolls across pins during a fast stream", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    streamChunk(1);
    scroll.grow(180);

    // 30px wheel ticks, each under the release threshold on its own and each
    // answered by a chunk that pins the reader back — but the displacement
    // they actually took accumulates across the pins, so the second tick
    // crosses the threshold and releases.
    for (let seq = 2; seq <= 4; seq++) {
      scroll.readerScrollsUp(30);
      streamChunk(seq);
      scroll.grow(180);
    }
    gestureSettles();
    streamChunk(5);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(600);
  });

  // Discrete mouse wheel at reading pace: one notch per event, spaced past
  // the intent window. A single notch already exceeds the one-line release
  // threshold, so the very first one lets go (OL-272).
  it("releases for the first spaced wheel notch", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.readerScrollsUp(100);
    gestureSettles();
    const parked = scroll.scrollTop;

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  // A reply's final chunk always exists and has a whole intent window to land
  // in after any small nudge; no later event will re-evaluate a declined pin.
  it("pins a chunk that lands inside the reader's intent window", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.readerScrollsUp(2);
    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("honors Shift+Space paging from a focused row control", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.shiftSpaceFromRowControl();
    scroll.browserScrollsListUp(VIEWPORT);
    const parked = scroll.scrollTop;
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  it("leaves the viewport alone once the reader scrolls up to read history", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.readerScrollsTo(900);
    gestureSettles();
    const parked = scroll.scrollTop;

    streamChunk(1);
    scroll.grow(500);
    scroll.shrinkViewport(72);

    expect(scroll.scrollTop).toBe(parked);
  });

  // Wheel over a capped code block scrolls the block; the event bubbles to
  // the list without moving it. Unconsumed input must not release the follow.
  it("keeps following through wheel input the list never consumed", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.wheelWithoutScroll(200);
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("pins a system shift after nested scrolling left input unconsumed", () => {
    const { scroll } = renderStreamingChat();

    scroll.wheelWithoutScroll(300);
    renderFrame();
    scroll.browserScrollsListUp(200);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  it("keeps following after a flick on a conversation too short to scroll", () => {
    const { scroll, streamChunk } = renderStreamingChat({ contentHeight: 400 });

    scroll.wheelWithoutScroll(200);
    gestureSettles();

    for (let seq = 1; seq <= 8; seq++) {
      streamChunk(seq);
      scroll.grow(180);
    }

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // Focus sits on a row control, the reader presses PageUp, and the browser
  // scrolls the list. The scroll confirms the staged key intent: the reader
  // is released, not pinned back over their own keypress.
  it("honors keyboard paging from a focused row control", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.pageUpFromRowControl();
    scroll.browserScrollsListUp(VIEWPORT);
    const parked = scroll.scrollTop;
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.scrollTop).toBe(parked);
  });

  it("re-engages when the reader scrolls back down to the live end", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.readerScrollsTo(900);
    scroll.readerScrollsTo(0);
    gestureSettles();

    streamChunk(1);
    scroll.grow(500);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // OL-272 review regression: the release threshold sits INSIDE the edge
  // zone, so a scrollbar drag releases without ever leaving the zone — and
  // the at-edge transition (which only fires on re-entry) cannot re-engage
  // it. Reaching the live end has to do it.
  it("re-engages after a short scrollbar drag back to the bottom", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.scrollbarDrag([50, 100, 50, 0]);
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // OL-272 review regression: on the way back from far out, re-entering the
  // edge zone re-engages mid-drag — the latch must not re-release on the
  // toward-motion frames that follow.
  it("stays engaged when a long scrollbar drag re-enters the edge zone", () => {
    const { scroll, streamChunk } = renderStreamingChat();

    scroll.scrollbarDrag([100, 300, 500, 300, 110, 80, 30, 0]);
    gestureSettles();

    streamChunk(1);
    scroll.grow(180);

    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // OL-272 review: the follow releases after one line of scrolling now, so a
  // reader who peeked up a notch and hit send would otherwise watch nothing —
  // their bubble and the streaming reply would grow below the fold. An
  // accepted send re-engages the follow and jumps to the live end.
  it("resumes following when the reader sends from a scrolled-up position", () => {
    const { scroll, streamChunk, sendOwnMessage, followsAtBottom } = renderStreamingChat();

    scroll.readerScrollsUp(100);
    expect(followsAtBottom()).toBe("false");

    sendOwnMessage();
    // The jump to the live end fires immediately…
    expect(scroll.pinCalls()).toEqual([{ index: "LAST", align: "end" }]);
    expect(scroll.distanceFromBottom()).toBe(0);

    // …and the stream that follows their send keeps them pinned (a released
    // latch would leave this growth unpinned).
    streamChunk(9);
    scroll.grow(180);
    expect(scroll.pinCalls()).toHaveLength(2);
    expect(scroll.distanceFromBottom()).toBe(0);
  });

  // `followOutput` is `atBottom && isFollowing()`: a released follow must turn
  // it off even while Virtuoso still reports the reader at the bottom.
  it("turns followOutput off while released, even when Virtuoso reports atBottom", () => {
    const { scroll, streamChunk, followsAtBottom } = renderStreamingChat();

    expect(followsAtBottom()).toBe("auto");

    scroll.readerScrollsTo(900);
    streamChunk(1);

    expect(followsAtBottom()).toBe("false");
  });

  it("stops measuring once the list unmounts", () => {
    const { view } = renderStreamingChat();

    view.unmount();

    expect(observedTargets()).toHaveLength(0);
  });
});
