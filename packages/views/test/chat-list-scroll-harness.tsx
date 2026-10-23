import { act } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { ReactElement } from "react";

// Shared jsdom harness for ChatMessageList scroll suites: the auto-scroll
// wiring must keep the live end visible through streaming growth and composer
// resizes, releasing only on real reader input. The latch decision table is
// canonical in transcript-follow.test.ts and the scroll geometry in
// stick-to-bottom.test.ts; suites built on this harness drive the real
// component through the DOM signals those decisions are wired to. Reader
// gestures here are wheel INPUT followed by the scroll it causes —
// position-only moves model the browser (clamps), input-led moves model the
// reader.
//
// Usage:
//   vi.mock("react-virtuoso", async () => {
//     const { ChatListVirtuosoMock } = await import(
//       "<relative path>/chat-list-scroll-harness"
//     );
//     return { Virtuoso: ChatListVirtuosoMock };
//   });
//   setupChatListScrollDom();  // top level of the suite's describe/module
//
// Every test file gets its own module registry (vitest isolation), so the
// state below is per-suite despite living in a shared module.

// Virtuoso cannot render rows in jsdom's zero-height viewport. The stub keeps
// the row count visible, surfaces `followOutput` verdicts as attributes,
// captures `totalListHeightChanged` so the harness can report content growth
// the way the real Virtuoso does, and answers `scrollToIndex` by moving the
// scroller to the bottom — the real component's job, and the only route the
// bottom-stick may take (MUL-6879).
let reportContentHeightChanged: (() => void) | undefined;
let pinCalls: unknown[] = [];
let scrollToLastItemEnd: (() => void) | undefined;

export function ChatListVirtuosoMock({
  ref,
  data,
  itemContent,
  computeItemKey,
  followOutput,
  totalListHeightChanged,
}: {
  ref?: { current: unknown } | ((handle: unknown) => void);
  data: unknown[];
  itemContent: (i: number, item: unknown) => ReactElement;
  computeItemKey: (i: number, item: unknown) => string;
  followOutput?: (atBottom: boolean) => "smooth" | "auto" | false;
  totalListHeightChanged?: () => void;
}) {
  reportContentHeightChanged = totalListHeightChanged;
  const handle = {
    scrollToIndex: (location: unknown) => {
      pinCalls.push(location);
      scrollToLastItemEnd?.();
    },
  };
  if (typeof ref === "function") ref(handle);
  else if (ref) ref.current = handle;
  return (
    <div
      data-testid="virtuoso-rows"
      data-follow-at-bottom={String(followOutput?.(true))}
      data-follow-away-from-bottom={String(followOutput?.(false))}
    >
      {data.map((item, i) => (
        <div key={computeItemKey(i, item)} data-row-key={computeItemKey(i, item)}>
          {itemContent(i, item)}
        </div>
      ))}
    </div>
  );
}

export const SCROLL_VIEWPORT = 600;

interface FakeObserver {
  targets: Element[];
  fire: () => void;
}

let observers: FakeObserver[] = [];
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;

export function observedTargets(): Element[] {
  return observers.flatMap((o) => o.targets);
}

export function fireResizeObservers() {
  act(() => {
    for (const observer of observers) observer.fire();
  });
}

export function renderFrame() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  now += 16;
  for (const callback of callbacks) callback(now);
}

// Confirmed motion gets a short settle window; tests control that clock.
let now = 0;
export function gestureSettles() {
  now += 301;
}

/** Registers the DOM stubs (clock, rAF, ResizeObserver) and per-test reset. */
export function setupChatListScrollDom() {
  beforeEach(() => {
    observers = [];
    animationFrames = new Map();
    nextAnimationFrameId = 1;
    reportContentHeightChanged = undefined;
    pinCalls = [];
    scrollToLastItemEnd = undefined;
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      animationFrames.delete(id);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets: Element[] = [];
        constructor(private callback: () => void) {
          observers.push(this as unknown as FakeObserver);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        unobserve(target: Element) {
          this.targets = this.targets.filter((t) => t !== target);
        }
        disconnect() {
          this.targets = [];
          observers = observers.filter((o) => (o as unknown as this) !== this);
        }
        fire() {
          this.callback();
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

export interface ChatListScroller {
  el: HTMLElement;
  scrollTop: number;
  distanceFromBottom(): number;
  /** A streamed chunk grew the content; Virtuoso reports the new height. */
  grow(px: number): void;
  /** Content shrank (a fold closing); the browser clamps scrollTop. */
  shrinkContent(px: number): void;
  /** The composer collapsed, giving the list `px` back; scrollTop clamps. */
  growViewport(px: number): void;
  /** The composer grew, taking `px` off the list's height. */
  shrinkViewport(px: number): void;
  /** Reader wheel input scrolling up by `px`, and the scroll it causes. */
  readerScrollsUp(px: number): void;
  /** Starts a one-finger touch gesture at `clientY`. */
  touchStart(clientY: number): void;
  /** Moves that finger and then scrolls the list up by `scrollPx`. */
  touchMove(clientY: number, scrollPx: number): void;
  touchEnd(): void;
  /** Touch momentum scrolls the list after the finger lifts. */
  touchMomentumScrollsUp(px: number): void;
  /** Reader wheel input landing `fromBottom` px above the live end. */
  readerScrollsTo(fromBottom: number): void;
  /**
   * Wheel input the list never consumed: it bubbles from a nested scroller
   * (or hits a list with nothing to scroll), so no scroll event follows.
   */
  wheelWithoutScroll(px: number): void;
  /** PageUp bubbling from a focused control inside a row. */
  pageUpFromRowControl(): void;
  /** Shift+Space (pages UP) bubbling from a focused control inside a row. */
  shiftSpaceFromRowControl(): void;
  /** The browser scrolls the list itself (answering a key), no input seen. */
  browserScrollsListUp(px: number): void;
  /**
   * A scrollbar drag: mousedown on the scroller itself, then the thumb's
   * positions as distance-from-bottom, then mouseup on the window.
   */
  scrollbarDrag(fromBottomPath: number[]): void;
  /** Every `scrollToIndex` the bottom-stick asked Virtuoso for. */
  pinCalls(): unknown[];
  /** Writes to `scrollTop` from outside Virtuoso — always a bug (MUL-6879). */
  directScrollTopWrites(): number;
}

export function chatListScroller(
  el: HTMLElement,
  initialContent = 2000,
): ChatListScroller {
  const state = {
    scrollTop: 0,
    contentHeight: initialContent,
    viewportHeight: SCROLL_VIEWPORT,
  };
  // Open at the bottom, matching Virtuoso's `initialTopMostItemIndex: LAST`.
  state.scrollTop = Math.max(0, state.contentHeight - state.viewportHeight);
  let directScrollTopWrites = 0;

  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => state.contentHeight },
    clientHeight: { configurable: true, get: () => state.viewportHeight },
    scrollTop: {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => {
        directScrollTopWrites++;
        state.scrollTop = value;
      },
    },
  });

  // What the mock Virtuoso does for `scrollToIndex({ index: "LAST", align:
  // "end" })`: the list moves its own scroller. Nothing else may write
  // scrollTop, so this bypasses the counted setter.
  scrollToLastItemEnd = () => {
    state.scrollTop = Math.max(0, state.contentHeight - state.viewportHeight);
  };
  pinCalls = [];

  const scrollEvent = () => {
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
  };

  const touchEvent = (type: string, clientY?: number) => {
    const event = new Event(type, { bubbles: true }) as TouchEvent;
    const points =
      clientY === undefined
        ? []
        : [{ identifier: 1, clientY } satisfies Pick<Touch, "identifier" | "clientY">];
    Object.defineProperty(event, "touches", {
      value: points,
    });
    Object.defineProperty(event, "changedTouches", { value: points });
    return event;
  };

  // Reader input: the wheel delta the hook judges intent from, then the
  // scroll it produces. Wheel up is a negative deltaY.
  const wheelBy = (px: number) => {
    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -px }));
    });
    state.scrollTop -= px;
    scrollEvent();
  };

  // Browser clamp after the scrollable extent shrank: scrollTop drops to the
  // new maximum and a scroll event fires, with no input anywhere.
  const clampAfterShrink = () => {
    state.scrollTop = Math.min(
      state.scrollTop,
      Math.max(0, state.contentHeight - state.viewportHeight),
    );
    scrollEvent();
  };

  const contentChanged = () => {
    act(() => {
      reportContentHeightChanged?.();
    });
  };

  return {
    el,
    get scrollTop() {
      return state.scrollTop;
    },
    distanceFromBottom() {
      return Math.max(
        0,
        state.contentHeight - state.scrollTop - state.viewportHeight,
      );
    },
    grow(px) {
      state.contentHeight += px;
      contentChanged();
    },
    shrinkContent(px) {
      state.contentHeight -= px;
      clampAfterShrink();
      contentChanged();
    },
    growViewport(px) {
      state.viewportHeight += px;
      clampAfterShrink();
      fireResizeObservers();
    },
    shrinkViewport(px) {
      state.viewportHeight -= px;
      fireResizeObservers();
    },
    readerScrollsUp(px) {
      wheelBy(px);
    },
    touchStart(clientY) {
      act(() => {
        el.dispatchEvent(touchEvent("touchstart", clientY));
      });
    },
    touchMove(clientY, scrollPx) {
      act(() => {
        el.dispatchEvent(touchEvent("touchmove", clientY));
      });
      state.scrollTop -= scrollPx;
      scrollEvent();
    },
    touchEnd() {
      act(() => {
        el.dispatchEvent(touchEvent("touchend"));
      });
    },
    touchMomentumScrollsUp(px) {
      state.scrollTop -= px;
      scrollEvent();
    },
    readerScrollsTo(fromBottom) {
      wheelBy(fromBottom - this.distanceFromBottom());
    },
    wheelWithoutScroll(px) {
      const nested = document.createElement("pre");
      el.appendChild(nested);
      act(() => {
        nested.dispatchEvent(new WheelEvent("wheel", { deltaY: -px, bubbles: true }));
      });
    },
    pageUpFromRowControl() {
      const control = document.createElement("button");
      el.appendChild(control);
      act(() => {
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
      });
    },
    shiftSpaceFromRowControl() {
      const control = document.createElement("button");
      el.appendChild(control);
      act(() => {
        control.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }),
        );
      });
    },
    browserScrollsListUp(px) {
      state.scrollTop -= px;
      scrollEvent();
    },
    scrollbarDrag(fromBottomPath) {
      // Mousedown lands on the scroller element itself (target === el), which
      // is how the wiring tells the thumb/track from row content.
      act(() => {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      for (const fromBottom of fromBottomPath) {
        state.scrollTop = Math.max(
          0,
          state.contentHeight - state.viewportHeight - fromBottom,
        );
        scrollEvent();
      }
      act(() => {
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
    },
    pinCalls() {
      return pinCalls;
    },
    directScrollTopWrites() {
      return directScrollTopWrites;
    },
  };
}
