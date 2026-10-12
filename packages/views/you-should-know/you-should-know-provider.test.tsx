// @vitest-environment jsdom

/**
 * Page-level You-should-know bubble (OL-194): switches, single bubble and
 * primary-position priority over real AgentAvatarStack anchors, rotation
 * rhythm, pausing, overlays, motion, and the settings hint. Fake timers drive
 * the dwell clock; `[data-test-rect]` boxes stand in for layout.
 */

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tipDisplayLedger, youShouldKnowKeys } from "@multica/core/you-should-know";
import type { TipAnchorDescriptor } from "@multica/core/you-should-know/anchors";
import { TIP_SYNC_SETTLE_MS } from "./bubble/tip-bubble-host";
import {
  createYskQueryClient,
  elapse,
  getBubble,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
  WS_ID,
} from "../test/you-should-know";

const apiMock = vi.hoisted(() => ({
  listActiveTips: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listWorkspaces: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

import { AgentAvatarStack } from "../agents/components/agent-avatar-stack";
import { useHoldTipRotation } from ".";

const SCOPE = { "issue-1": "OL-1", "issue-2": "OL-2", "issue-3": "OL-3" };

function Anchor({
  testId,
  rect,
  descriptor,
}: {
  testId: string;
  rect: string;
  descriptor: TipAnchorDescriptor;
}) {
  return (
    <div data-testid={testId} data-test-rect={rect}>
      <AgentAvatarStack agentIds={["agent-1"]} tipAnchor={descriptor} />
    </div>
  );
}

function RowAnchor({ issueId, top = 300 }: { issueId: string; top?: number }) {
  return (
    <Anchor
      testId={`row-${issueId}`}
      rect={`100,${top},40,16`}
      descriptor={{ level: "row", issueId }}
    />
  );
}

function bubbleText(): string {
  return getBubble()?.textContent ?? "";
}

function dotIn(testId: string): HTMLElement | null {
  return within(screen.getByTestId(testId)).queryByTestId("tip-anchor-dot");
}

function serveTips(...tips: ReturnType<typeof makeTip>[]) {
  apiMock.listActiveTips.mockResolvedValue({ tips });
}

/**
 * IntersectionObserver stand-in whose entries the test emits: anchors stay
 * invisible until `showAll()` reports every observed element as on screen.
 */
function controllableIntersectionObserver() {
  const live = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element> }>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly entry: { callback: IntersectionObserverCallback; targets: Set<Element> };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: new Set() };
        live.add(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        live.delete(this.entry);
      }
    },
  );
  const emit = (visible: boolean, matches: (target: Element) => boolean) => {
    act(() => {
      for (const { callback, targets } of live) {
        const hits = [...targets].filter(matches);
        if (hits.length === 0) continue;
        callback(
          hits.map(
            (target) => ({ isIntersecting: visible, target }) as IntersectionObserverEntry,
          ),
          {} as IntersectionObserver,
        );
      }
    });
  };
  return {
    showAll: () => emit(true, () => true),
    /** Report the anchor inside `[data-testid=testId]` as on or off screen. */
    set: (testId: string, visible: boolean) =>
      emit(visible, (target) => target.closest(`[data-testid="${testId}"]`) !== null),
  };
}

/** Counts IntersectionObservers — one per registered anchor. Never reports. */
function stubIntersectionObserver() {
  const counter = { created: 0 };
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor() {
        counter.created += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return counter;
}

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  apiMock.listActiveTips.mockReset();
  apiMock.getNotificationPreferences.mockReset();
  apiMock.listWorkspaces.mockReset();
  localStorage.clear();
  tipDisplayLedger.setState({ users: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.innerWidth = originalInnerWidth;
  window.matchMedia = originalMatchMedia;
});

describe("YouShouldKnowProvider — switches", () => {
  it("shows the bubble when the workspace and personal switches are both on", async () => {
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(apiMock.listActiveTips).toHaveBeenCalledTimes(1);
    expect(getBubble()).not.toBeNull();
    expect(bubbleText()).toContain("The agent put the feature behind a flag");
  });

  it.each([
    ["the workspace switch is off", { workspaceEnabled: false }],
    ["the personal switch is muted", { personal: "muted" as const }],
  ])("renders nothing and requests nothing when %s", async (_label, switches) => {
    const observers = stubIntersectionObserver();
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />, {
      queryClient: createYskQueryClient(switches),
    });
    await settle();
    await elapse(10_000);
    expect(apiMock.listActiveTips).not.toHaveBeenCalled();
    expect(getBubble()).toBeNull();
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
    // The registry is withheld, so anchors never register or observe.
    expect(observers.created).toBe(0);
  });

  it("renders nothing and requests nothing on a narrow (mobile-width) window", async () => {
    const observers = stubIntersectionObserver();
    window.innerWidth = 500;
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(apiMock.listActiveTips).not.toHaveBeenCalled();
    expect(getBubble()).toBeNull();
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
    expect(observers.created).toBe(0);
  });

  it("lets anchors register (and observe visibility) once the feature is on", async () => {
    const observers = stubIntersectionObserver();
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(observers.created).toBe(1);
  });

  it("treats a failing tips request as no tips, without surfacing an error", async () => {
    apiMock.listActiveTips.mockRejectedValue(new Error("404 page not found"));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(apiMock.listActiveTips).toHaveBeenCalled();
    expect(getBubble()).toBeNull();
    expect(screen.getByTestId("row-issue-1")).toBeInTheDocument();
  });

  it("drops cached tips when a refetch fails, and brings them back once it succeeds", async () => {
    serveTips(makeTip());
    const { queryClient } = renderWithYsk(
      <>
        <Anchor
          testId="summary"
          rect="900,10,60,20"
          descriptor={{ level: "summary", scope: SCOPE }}
        />
        <RowAnchor issueId="issue-1" />
      </>,
    );
    await settle();
    expect(getBubble()).not.toBeNull();
    expect(dotIn("summary")).not.toBeNull();

    // The server stops answering. TanStack Query keeps the cached tips, but the
    // query is in error: nothing may rotate on data it no longer vouches for.
    apiMock.listActiveTips.mockRejectedValue(new Error("server unavailable"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: youShouldKnowKeys.active(WS_ID) });
    });
    await settle();
    expect(queryClient.getQueryState(youShouldKnowKeys.active(WS_ID))?.status).toBe("error");
    expect(getBubble()).toBeNull();
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();

    // It answers again (a realtime invalidation, a reconnect): the tip returns.
    serveTips(makeTip());
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: youShouldKnowKeys.active(WS_ID) });
    });
    await settle();
    expect(bubbleText()).toContain("The agent put the feature behind a flag");
    expect(dotIn("summary")).not.toBeNull();
  });

  it("rotates only valid tips the viewer has not acted on", async () => {
    serveTips(
      makeTip({ id: "known", line: "Known line", user_state: { state: "known", feedback: null } }),
      makeTip({ id: "overturned", line: "Overturned line", status: "overturned" }),
      makeTip({ id: "fresh", line: "Fresh line" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(bubbleText()).toContain("Fresh line");
    await elapse(8_000);
    expect(bubbleText()).toContain("Fresh line");
    expect(bubbleText()).not.toMatch(/Known line|Overturned line/);
  });
});

describe("YouShouldKnowProvider — placement", () => {
  it("shows a single bubble, on the most specific anchor, and dots the rest", async () => {
    serveTips(
      makeTip({ id: "t1", issue_id: "issue-1", line: "Header line" }),
      makeTip({ id: "t2", issue_id: "issue-2", line: "Row line" }),
      makeTip({ id: "t3", issue_id: "issue-3", line: "Summary line" }),
    );
    renderWithYsk(
      <>
        <Anchor
          testId="summary"
          rect="900,10,60,20"
          descriptor={{ level: "summary", scope: SCOPE }}
        />
        <Anchor
          testId="header-issue-1"
          rect="1000,40,60,20"
          descriptor={{ level: "detail_header", issueId: "issue-1" }}
        />
        <RowAnchor issueId="issue-1" top={300} />
        <RowAnchor issueId="issue-2" top={340} />
      </>,
    );
    await settle();

    // Detail header beats the row and the summary for issue-1's tip. The
    // bubble hangs below the header chip, growing toward the window's middle.
    expect(document.querySelectorAll("[data-ysk-bubble]")).toHaveLength(1);
    expect(getBubble()).toHaveAttribute("data-level", "detail_header");
    expect(getBubble()).toHaveAttribute("data-placement", "bottom-end");
    expect(bubbleText()).toContain("Header line");
    expect(dotIn("header-issue-1")).toBeNull();
    expect(dotIn("row-issue-1")).not.toBeNull();
    expect(dotIn("row-issue-2")).not.toBeNull();
    expect(dotIn("summary")).not.toBeNull();

    // Then the row (above it), then the summary — still one bubble at a time.
    await elapse(8_000);
    expect(document.querySelectorAll("[data-ysk-bubble]")).toHaveLength(1);
    expect(getBubble()).toHaveAttribute("data-level", "row");
    expect(getBubble()).toHaveAttribute("data-placement", "top-start");
    expect(bubbleText()).toContain("Row line");
    expect(dotIn("row-issue-2")).toBeNull();
    expect(dotIn("header-issue-1")).not.toBeNull();

    await elapse(8_000);
    expect(document.querySelectorAll("[data-ysk-bubble]")).toHaveLength(1);
    expect(getBubble()).toHaveAttribute("data-level", "summary");
    expect(bubbleText()).toContain("Summary line");
  });

  it("prefixes summary tips with the issue identifier and keeps issues with a visible row out of the summary", async () => {
    serveTips(
      makeTip({ id: "t1", issue_id: "issue-1", line: "Row line" }),
      makeTip({ id: "t2", issue_id: "issue-2", line: "Summary line" }),
    );
    renderWithYsk(
      <>
        <Anchor
          testId="summary"
          rect="900,10,60,20"
          descriptor={{ level: "summary", scope: SCOPE }}
        />
        <RowAnchor issueId="issue-1" />
      </>,
    );
    await settle();

    const seen: { level: string | null; text: string }[] = [];
    for (let step = 0; step < 4; step += 1) {
      seen.push({ level: getBubble()!.getAttribute("data-level"), text: bubbleText() });
      await elapse(8_000);
    }
    // issue-1 has a visible row: its tip always rides the row, unprefixed.
    for (const display of seen.filter((d) => d.text.includes("Row line"))) {
      expect(display.level).toBe("row");
      expect(display.text).not.toContain("OL-1");
    }
    // issue-2 only has the summary: its tip shows there, prefixed.
    const summary = seen.find((d) => d.text.includes("Summary line"));
    expect(summary?.level).toBe("summary");
    expect(summary?.text).toContain("OL-2");
  });
});

describe("YouShouldKnowProvider — re-scheduling", () => {
  it("never interrupts the tip on screen: a heads-up arriving mid-dwell waits its turn", async () => {
    const light = makeTip({ id: "light", line: "Light line" });
    serveTips(light);
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    await elapse(3_000);
    expect(bubbleText()).toContain("Light line");

    // A heads-up lands (realtime refetch) — it sorts first, but the current
    // tip keeps the bubble for the rest of its 8s.
    act(() => {
      queryClient.setQueryData(youShouldKnowKeys.active(WS_ID), {
        tips: [light, makeTip({ id: "heads", tag: "heads_up", line: "Heads line" })],
      });
    });
    await settle();
    expect(bubbleText()).toContain("Light line");
    await elapse(8_000 - 3_000 - TIP_SYNC_SETTLE_MS - 1);
    expect(bubbleText()).toContain("Light line");
    await elapse(1);
    expect(bubbleText()).toContain("Heads line");
  });

  it("keeps the tip whose anchor is only re-mounting, and counts nothing else as shown", async () => {
    const observers = controllableIntersectionObserver();
    serveTips(
      makeTip({ id: "first", issue_id: "issue-1", line: "First line" }),
      makeTip({ id: "second", issue_id: "issue-2", line: "Second line" }),
    );
    const view = renderWithYsk(
      <>
        <RowAnchor key="a" issueId="issue-1" top={300} />
        <RowAnchor issueId="issue-2" top={340} />
      </>,
    );
    observers.showAll();
    await settle();
    expect(bubbleText()).toContain("First line");

    // A view switch: issue-1's anchor unmounts and a fresh one mounts, which
    // only reports visible a moment later.
    view.rerender(
      <>
        <RowAnchor key="b" issueId="issue-1" top={300} />
        <RowAnchor issueId="issue-2" top={340} />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    observers.showAll();
    await settle();

    expect(bubbleText()).toContain("First line");
    expect(tipDisplayLedger.getState().users["user-1"]).toMatchObject({ count: 1 });
  });

  it("still re-schedules promptly while anchor changes keep coming (scrolling)", async () => {
    const observers = controllableIntersectionObserver();
    serveTips(
      makeTip({ id: "first", issue_id: "issue-1", line: "First line" }),
      makeTip({ id: "second", issue_id: "issue-2", line: "Second line" }),
    );
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" top={300} />
        <RowAnchor issueId="issue-2" top={340} />
        <RowAnchor issueId="issue-3" top={380} />
      </>,
    );
    observers.showAll();
    await settle();
    expect(bubbleText()).toContain("First line");

    // issue-1's row scrolls out while other rows keep flipping visibility.
    observers.set("row-issue-1", false);
    for (let step = 0; step < 4; step += 1) {
      observers.set("row-issue-3", step % 2 === 1);
      await elapse(50);
    }
    // Within one settle window of the first change — not after the stream.
    expect(bubbleText()).toContain("Second line");
  });
});

describe("YouShouldKnowProvider — rhythm", () => {
  it("puts heads-up first for 15s, then you-should-know for 8s", async () => {
    serveTips(
      makeTip({ id: "light", line: "Light line", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "heads", tag: "heads_up", line: "Heads line", created_at: "2026-10-11T09:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();

    expect(bubbleText()).toContain("Heads up");
    expect(bubbleText()).toContain("Heads line");
    await elapse(14_999);
    expect(bubbleText()).toContain("Heads line");
    await elapse(1);
    expect(bubbleText()).toContain("You should know");
    expect(bubbleText()).toContain("Light line");
    await elapse(7_999);
    expect(bubbleText()).toContain("Light line");
    await elapse(1);
    expect(bubbleText()).toContain("Heads line");
  });
});

describe("YouShouldKnowProvider — pausing", () => {
  function servePair() {
    serveTips(
      makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
    );
  }

  it("pauses while the pointer rests on the bubble and resumes with the time left", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    await elapse(3_000);
    fireEvent.pointerEnter(getBubble()!);
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");
    fireEvent.pointerLeave(getBubble()!);
    await elapse(4_999);
    expect(bubbleText()).toContain("First line");
    await elapse(1);
    expect(bubbleText()).toContain("Second line");
  });

  it("pauses while keyboard focus is on the bubble and resumes with the time left", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    await elapse(3_000);
    const button = within(getBubble()!).getByRole("button");
    act(() => button.focus());
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");
    act(() => button.blur());
    await elapse(4_999);
    expect(bubbleText()).toContain("First line");
    await elapse(1);
    expect(bubbleText()).toContain("Second line");
  });

  it("pauses while the user is typing in an input", async () => {
    servePair();
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <input aria-label="Comment" />
      </>,
    );
    await settle();
    await elapse(2_000);
    act(() => screen.getByLabelText("Comment").focus());
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");
    act(() => screen.getByLabelText("Comment").blur());
    await elapse(5_999);
    expect(bubbleText()).toContain("First line");
    await elapse(1);
    expect(bubbleText()).toContain("Second line");
  });

  it("pauses while the page is hidden", async () => {
    servePair();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    await elapse(4_000);
    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await elapse(60_000);
    expect(bubbleText()).toContain("First line");
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await elapse(3_999);
    expect(bubbleText()).toContain("First line");
    await elapse(1);
    expect(bubbleText()).toContain("Second line");
  });

  it("pauses while something holds the rotation (the card's hook)", async () => {
    servePair();
    function Holder({ active }: { active: boolean }) {
      useHoldTipRotation(active);
      return null;
    }
    const view = renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <Holder active={false} />
      </>,
    );
    await settle();
    await elapse(1_000);
    view.rerender(
      <>
        <RowAnchor issueId="issue-1" />
        <Holder active />
      </>,
    );
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");
    view.rerender(
      <>
        <RowAnchor issueId="issue-1" />
        <Holder active={false} />
      </>,
    );
    await elapse(6_999);
    expect(bubbleText()).toContain("First line");
    await elapse(1);
    expect(bubbleText()).toContain("Second line");
  });
});

describe("YouShouldKnowProvider — overlays", () => {
  it("yields to the anchor's own popup: hidden and paused until it closes", async () => {
    serveTips(
      makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(getBubble()).toHaveStyle({ visibility: "visible" });

    // The row's hover card opens: Base UI marks its trigger, whose box holds
    // the avatar stack.
    const trigger = screen.getByTestId("row-issue-1");
    await act(async () => {
      trigger.setAttribute("data-popup-open", "");
    });
    expect(getBubble()).toHaveStyle({ visibility: "hidden" });
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");

    await act(async () => {
      trigger.removeAttribute("data-popup-open");
    });
    expect(getBubble()).toHaveStyle({ visibility: "visible" });
    await elapse(8_000);
    expect(bubbleText()).toContain("Second line");
  });

  it("ignores popups whose trigger does not hold the anchor", async () => {
    serveTips(makeTip());
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <button type="button" data-test-rect="600,600,80,24" data-popup-open="">
          Menu
        </button>
      </>,
    );
    await settle();
    expect(getBubble()).toHaveStyle({ visibility: "visible" });
  });

  it("hides and pauses while a modal layer is open, then resumes with the time left", async () => {
    serveTips(
      makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    await elapse(3_000);
    const inert = document.createElement("div");
    await act(async () => {
      inert.setAttribute("data-base-ui-inert", "");
      document.body.appendChild(inert);
    });
    expect(getBubble()).toHaveStyle({ visibility: "hidden" });
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");
    await act(async () => {
      inert.remove();
    });
    expect(getBubble()).toHaveStyle({ visibility: "visible" });
    await elapse(4_999);
    expect(bubbleText()).toContain("First line");
    await elapse(1);
    expect(bubbleText()).toContain("Second line");
  });
});

describe("YouShouldKnowProvider — motion", () => {
  it("fades in once and never loops", async () => {
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    const body = getBubble()!.querySelector("[data-motion]")!;
    expect(body).toHaveAttribute("data-motion", "fade");
    expect(body).toHaveClass("animate-in", "fade-in-0", "duration-150");
    expect(getBubble()!.innerHTML).not.toMatch(/animate-(pulse|ping|spin|bounce)|shimmer/);
  });

  it("drops the transition entirely under prefers-reduced-motion", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    const body = getBubble()!.querySelector("[data-motion]")!;
    expect(body).toHaveAttribute("data-motion", "none");
    expect(body).not.toHaveClass("animate-in");
    expect(body.className).not.toMatch(/fade-in|duration-/);
  });
});

describe("YouShouldKnowProvider — settings hint", () => {
  const SETTINGS_HREF = "/acme/settings?tab=notifications&section=you-should-know";

  function hintLink(): HTMLElement | null {
    return getBubble()
      ? within(getBubble()!).queryByRole("link", {
          name: "You can turn this off in personal settings",
        })
      : null;
  }

  it("rides on the first three distinct tips and links to the personal switch", async () => {
    serveTips(
      ...["a", "b", "c", "d"].map((id, i) =>
        makeTip({ id, line: `Line ${id}`, created_at: `2026-10-11T0${i}:00:00Z` }),
      ),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    const hints: boolean[] = [];
    for (let step = 0; step < 4; step += 1) {
      hints.push(hintLink() !== null);
      if (step === 0) expect(hintLink()).toHaveAttribute("href", SETTINGS_HREF);
      await elapse(8_000);
    }
    expect(hints).toEqual([true, true, true, false]);
  });

  it("counts a tip only once it can be seen — not while a modal covers it", async () => {
    serveTips(makeTip());
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <div data-testid="modal-marker" data-base-ui-inert="" />
      </>,
    );
    await settle();
    expect(getBubble()).toHaveStyle({ visibility: "hidden" });
    expect(tipDisplayLedger.getState().users["user-1"]).toBeUndefined();

    await act(async () => {
      screen.getByTestId("modal-marker").removeAttribute("data-base-ui-inert");
    });
    await settle();
    expect(getBubble()).toHaveStyle({ visibility: "visible" });
    expect(tipDisplayLedger.getState().users["user-1"]?.count).toBe(1);
  });

  it("counts a tip only once the page is in view", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(getBubble()).not.toBeNull();
    expect(tipDisplayLedger.getState().users["user-1"]).toBeUndefined();

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(tipDisplayLedger.getState().users["user-1"]?.count).toBe(1);
  });

  it("gives the first tip the user actually sees the initial hint, however many were replaced unseen", async () => {
    serveTips(makeTip({ id: "hidden-1" }));
    const { queryClient } = renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <div data-testid="modal-marker" data-base-ui-inert="" />
      </>,
    );
    await settle();
    // Tips come and go while a modal covers the page.
    for (const id of ["hidden-2", "hidden-3", "first-visible"]) {
      act(() => {
        queryClient.setQueryData(youShouldKnowKeys.active(WS_ID), {
          tips: [makeTip({ id })],
        });
      });
      await settle();
      expect(getBubble()).toHaveStyle({ visibility: "hidden" });
    }

    await act(async () => {
      screen.getByTestId("modal-marker").removeAttribute("data-base-ui-inert");
    });
    await settle();
    expect(getBubble()).toHaveStyle({ visibility: "visible" });
    expect(hintLink()).not.toBeNull();
    expect(tipDisplayLedger.getState().users["user-1"]).toEqual({
      count: 1,
      ordinals: { "first-visible": 1 },
    });
  });

  it("does not count the next tip while it waits behind a modal after the shown one went away", async () => {
    const first = makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" });
    const second = makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" });
    serveTips(first, second);
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(bubbleText()).toContain("First line");

    // The tip on screen is dismissed elsewhere and a dialog opens before the
    // next one takes over: the next tip is not seen yet, so not counted.
    act(() => {
      queryClient.setQueryData(youShouldKnowKeys.active(WS_ID), { tips: [second] });
    });
    const inert = document.createElement("div");
    await act(async () => {
      inert.setAttribute("data-base-ui-inert", "");
      document.body.appendChild(inert);
    });
    await settle();
    expect(bubbleText()).toContain("Second line");
    expect(getBubble()).toHaveStyle({ visibility: "hidden" });
    expect(tipDisplayLedger.getState().users["user-1"]?.ordinals).toEqual({ first: 1 });

    await act(async () => {
      inert.remove();
    });
    await settle();
    expect(tipDisplayLedger.getState().users["user-1"]?.ordinals).toEqual({ first: 1, second: 2 });
  });

  it("returns on every tenth distinct tip; rotation back to a seen tip does not count", async () => {
    tipDisplayLedger.setState({ users: { "user-1": { count: 8, ordinals: {} } } });
    serveTips(
      makeTip({ id: "ninth", line: "Ninth line", created_at: "2026-10-11T01:00:00Z" }),
      makeTip({ id: "tenth", line: "Tenth line", created_at: "2026-10-11T02:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(bubbleText()).toContain("Ninth line");
    expect(hintLink()).toBeNull();
    await elapse(8_000);
    expect(bubbleText()).toContain("Tenth line");
    expect(hintLink()).not.toBeNull();
    // Back to the ninth tip: same tip, no new count, still no hint.
    await elapse(8_000);
    expect(bubbleText()).toContain("Ninth line");
    expect(hintLink()).toBeNull();
    expect(tipDisplayLedger.getState().users["user-1"]!.count).toBe(10);
  });
});

describe("YouShouldKnowProvider — marker", () => {
  it("explains the ✦ bystander marker on hover", async () => {
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    const marker = within(getBubble()!).getByText("✦");
    fireEvent.pointerEnter(marker, { pointerType: "mouse" });
    fireEvent.mouseEnter(marker);
    fireEvent.mouseMove(marker);
    await elapse(1_000);
    expect(
      screen.getByText("A bystander assistant keeps watch while agents work"),
    ).toBeInTheDocument();
  });
});
