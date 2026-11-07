import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { BaselineReadingRail } from "./engineering-baseline-reading-rail";
import { parseBaselineChapter } from "./engineering-baseline-utils";

vi.mock("../../i18n", () => ({ useT: () => ({ t: () => "Annotations" }) }));
vi.mock("./engineering-baseline-reading-card", () => ({
  BaselineReadingEntryCard: ({ entry }: { entry: { id: string } }) => <div>{entry.id}</div>,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("measures before writing positions, coalesces events and remeasures resized cards", () => {
  let callback: FrameRequestCallback | undefined;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((next) => {
    callback = next;
    return 1;
  });
  const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  let resized: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(fn: () => void) { resized = fn; }
    observe() {}
    disconnect = disconnect;
  });
  const section = parseBaselineChapter("domain_rules", "## [RULE-1] Rules\nText").sections[0]!;
  const entries = ["first", "second"].map((id) => {
    const item = {
      id, ownerId: "owner", projectId: "project", chapter: "domain_rules" as const,
      note: "note", createdAt: "2026-01-01", anchorKind: "section" as const,
      targetRevisionId: "revision", sectionAnchor: section.anchor, sectionTitle: section.title,
    };
    return { id, kind: "pending" as const, item, anchor: item };
  });
  const props = {
    sections: [section], entries, hoveredId: null,
    adopted: {} as ComponentProps<typeof BaselineReadingRail>["adopted"], candidate: null,
    canDecide: false, limitReached: false, onHover: vi.fn(), onAddAnnotation: vi.fn(),
    onCancelComposer: vi.fn(), onAddReply: vi.fn(), onUpdatePending: vi.fn(),
    onDeletePending: vi.fn(), onResolve: vi.fn(),
  };
  const view = render(<><article data-baseline-section-key={section.key}><h3>Rules</h3></article><BaselineReadingRail {...props} /></>);
  const rail = view.container.querySelector<HTMLElement>("[data-reading-rail]")!;
  const cards = Array.from(rail.querySelectorAll<HTMLElement>("[data-reading-rail-item]"));
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({ top: 10 } as DOMRect);
  vi.spyOn(view.container.querySelector("h3")!, "getBoundingClientRect").mockReturnValue({ top: 110 } as DOMRect);
  let wrotePosition = false;
  let height = 80;
  const reads: number[] = [];
  cards.forEach((card, index) => {
    Object.defineProperty(card, "offsetHeight", { configurable: true, get: () => {
      expect(wrotePosition, "geometry read after a position write").toBe(false);
      reads.push(index);
      return index === 0 ? height : 60;
    } });
    let top = "";
    Object.defineProperty(card.style, "top", { configurable: true,
      get: () => top,
      set: (value: string) => { wrotePosition = true; top = value; },
    });
  });
  const flush = () => act(() => { const next = callback!; callback = undefined; next(0); });
  act(() => {
    document.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    resized();
  });
  expect(requestFrame).toHaveBeenCalledTimes(1);
  flush();
  expect(reads).toEqual([0, 1]);
  expect(cards.map((card) => card.style.top)).toEqual(["100px", "188px"]);
  expect(rail.style.minHeight).toBe("256px");

  wrotePosition = false;
  height = 120;
  act(() => resized());
  flush();
  expect(cards.map((card) => card.style.top)).toEqual(["100px", "228px"]);
  expect(rail.style.minHeight).toBe("296px");
  act(() => resized());
  view.unmount();
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(cancelFrame).toHaveBeenCalledWith(1);
});
