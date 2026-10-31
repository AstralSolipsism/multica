import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadingAnchor } from "./use-reading-anchor";

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
beforeEach(() => {
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });
function frame() {
  const queued = [...frames.values()];
  frames.clear();
  act(() => queued.forEach((callback) => callback(0)));
}
function setup() {
  const root = document.createElement("div");
  root.innerHTML = '<div data-chat-message-row><p>Reading line</p></div>';
  document.body.append(root);
  const text = root.querySelector("p")!;
  root.scrollTop = 500;
  let position = 20;
  root.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect;
  text.getBoundingClientRect = () => ({ top: position, bottom: position + 100 }) as DOMRect;
  let following = false;
  const scrollBy = vi.fn((delta: number) => { root.scrollTop += delta; position -= delta; });
  const hook = renderHook(({ active }) => useReadingAnchor(root, () => following, scrollBy, active), {
    initialProps: { active: true },
  });
  return {
    root, hook, scrollBy,
    grow: (delta: number, notify = true) => { position += delta; if (notify) act(() => hook.result.current()); },
    follow: () => { following = true; },
    compensate: (delta: number) => { root.scrollTop += delta; position -= delta; fireEvent.scroll(root); },
  };
}

describe("reading anchor", () => {
  it("corrects delayed growth above a visible paragraph inside the same message", () => {
    const h = setup();
    h.grow(300);
    frame(); frame();
    expect(h.scrollBy).toHaveBeenCalledExactlyOnceWith(300);
  });
  it("only corrects displacement left after Virtuoso's own compensation", () => {
    const h = setup();
    h.grow(300);
    h.compensate(240);
    frame(); frame();
    expect(h.scrollBy).toHaveBeenCalledExactlyOnceWith(60);
  });
  it("does not double compensate a prepend already handled by Virtuoso", () => {
    const h = setup();
    h.grow(900);
    h.compensate(900);
    frame(); frame();
    expect(h.scrollBy).not.toHaveBeenCalled();
  });
  it("preserves the anchor when Virtuoso scrolls before the height notification", () => {
    const h = setup();
    h.grow(300, false);
    h.compensate(240);
    frame(); frame();
    expect(h.scrollBy).toHaveBeenCalledExactlyOnceWith(60);
  });
  it("captures the reader's new position after an ordinary scroll", () => {
    const h = setup();
    h.compensate(80);
    h.grow(300);
    frame(); frame();
    expect(h.scrollBy).toHaveBeenCalledExactlyOnceWith(300);
  });
  it.each(["pointerdown", "keydown"])("keeps a top fold in place after %s and delayed expansion", (event) => {
    const h = setup();
    const trigger = document.createElement("button");
    trigger.dataset.slot = "collapsible-trigger";
    trigger.textContent = "Execution process";
    trigger.getBoundingClientRect = () => ({ top: 4, bottom: 24 }) as DOMRect;
    h.root.querySelector("[data-chat-message-row]")!.prepend(trigger);
    fireEvent(trigger, new Event(event, { bubbles: true }));
    frame(); frame();

    // The loading state has settled before the transcript pushes the answer
    // down. The trigger above the new steps must retain the viewport.
    h.grow(676);
    frame(); frame();
    expect(h.scrollBy).not.toHaveBeenCalled();
  });
  it.each(["wheel", "keydown", "touchstart", "pointerdown"])("yields to %s before a queued correction", (event) => {
    const h = setup();
    h.grow(200);
    fireEvent(h.root, new Event(event));
    frame(); frame();
    expect(h.scrollBy).not.toHaveBeenCalled();
  });
  it("leaves live-end following to the existing bottom-stick", () => {
    const h = setup();
    h.follow();
    h.grow(200);
    frame(); frame();
    expect(h.scrollBy).not.toHaveBeenCalled();
  });
  it("cancels pending corrections when a chat window becomes inactive", () => {
    const h = setup();
    h.grow(200);
    h.hook.rerender({ active: false });
    frame(); frame();
    expect(h.scrollBy).not.toHaveBeenCalled();
  });
});
