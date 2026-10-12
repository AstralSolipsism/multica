// @vitest-environment jsdom

/**
 * The bubble's card and its buttons (OL-196), through the real provider and
 * host: opening and closing, Learn more, I already know / Got it, Discuss in
 * comments, a failed save, a state change from another tab, and motion. The
 * feedback row and focus hand-offs have their own suites. A fake server
 * answers the tips list with the states it was sent; fake timers drive dwell.
 */

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { setCurrentWorkspace } from "@multica/core/platform";
import {
  tipDisplayLedger,
  useYouShouldKnowRealtimeSync,
} from "@multica/core/you-should-know";
import {
  createNavigation,
  elapse,
  flush,
  getBubble,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
  WS_ID,
  WS_SLUG,
} from "../../test/you-should-know";
import {
  bubbleText,
  bubbleToggle,
  cachedState,
  cardButton,
  cardButtonNames,
  feedbackRow,
  HeaderAnchor,
  installFakeTipServer,
  openCard,
  preferReducedMotion,
  RowAnchor,
} from "../../test/you-should-know-layers";

const apiMock = vi.hoisted(() => ({
  listActiveTips: vi.fn(),
  setTipState: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listWorkspaces: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

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

let serveTips: ReturnType<typeof installFakeTipServer>["serveTips"];
let servePair: ReturnType<typeof installFakeTipServer>["servePair"];
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  toastError.mockReset();
  ({ serveTips, servePair } = installFakeTipServer(apiMock));
  localStorage.clear();
  tipDisplayLedger.setState({ users: {} });
  useCommentDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.matchMedia = originalMatchMedia;
});

describe("tip card — opening and closing", () => {
  it("opens from the bubble on the first set of buttons and holds the rotation until it closes", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    await elapse(3_000);
    expect(cardButtonNames()).toEqual([]);

    openCard();
    expect(cardButtonNames()).toEqual(["Learn more", "I already know", "Dismiss"]);
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");

    // A second click on the bubble line closes the card in place.
    fireEvent.click(bubbleToggle());
    expect(bubbleToggle()).toHaveAttribute("aria-expanded", "false");
    expect(cardButtonNames()).toEqual([]);
    expect(bubbleToggle()).toHaveFocus();

    // With the card shut and focus gone, the dwell resumes where it stopped.
    act(() => bubbleToggle().blur());
    await elapse(4_999);
    expect(bubbleText()).toContain("First line");
    await elapse(1);
    expect(bubbleText()).toContain("Second line");
  });

  it("holds the rotation for as long as it is open, wherever focus and pointer are", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Learn more").blur());
    await elapse(30_000);
    expect(bubbleText()).toContain("First line");
    expect(cardButtonNames()).toEqual(["Learn more", "I already know", "Dismiss"]);
  });

  it("closes on Escape, hands focus back to the bubble line, and keeps the key from the page", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    const pageKeys = vi.fn();
    document.addEventListener("keydown", pageKeys);
    try {
      openCard();
      expect(cardButton("Learn more")).toHaveFocus();
      fireEvent.keyDown(cardButton("Learn more"), { key: "Escape" });
      expect(bubbleToggle()).toHaveAttribute("aria-expanded", "false");
      expect(bubbleToggle()).toHaveFocus();
      // Page-level Escape handlers (the issue peek closes on it) never saw it.
      expect(pageKeys).not.toHaveBeenCalled();

      // Control: with the card closed, Escape reaches the page as before.
      fireEvent.keyDown(bubbleToggle(), { key: "Escape" });
      expect(pageKeys).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", pageKeys);
    }
  });

  it("names the card after the bubble line and points the bubble line at it", async () => {
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(bubbleToggle()).not.toHaveAttribute("aria-controls");
    openCard();
    const card = within(getBubble()!).getByRole("group");
    expect(bubbleToggle()).toHaveAttribute("aria-controls", card.id);
    expect(card).toHaveAttribute("aria-labelledby", bubbleToggle().id);
  });

  it("does not count opening the card as another display", async () => {
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(tipDisplayLedger.getState().users["user-1"]?.count).toBe(1);
    openCard();
    fireEvent.click(cardButton("Learn more"));
    await settle();
    fireEvent.click(bubbleToggle());
    openCard();
    await settle();
    expect(tipDisplayLedger.getState().users["user-1"]).toEqual({
      count: 1,
      ordinals: { "tip-1": 1 },
    });
  });
});

describe("tip card — Learn more", () => {
  it("shows the title and explanation, swaps the buttons and moves focus onto what it revealed", async () => {
    serveTips(
      makeTip({
        id: "first",
        line: "Kept the old API",
        title: "Old API kept",
        explanation: "Clients still call it, so it stays until they move.",
      }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    expect(screen.queryByText("Old API kept")).not.toBeInTheDocument();

    fireEvent.click(cardButton("Learn more"));
    expect(screen.getByText("Old API kept")).toBeInTheDocument();
    const explanation = screen.getByText("Clients still call it, so it stays until they move.");
    expect(cardButtonNames()).toEqual(["Got it", "Discuss in comments", "Dismiss"]);
    expect(explanation.parentElement).toHaveFocus();
  });

  it("shows the explanation alone when the tip has no title", async () => {
    serveTips(makeTip({ id: "first", title: null, explanation: "Because." }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));
    expect(screen.getByText("Because.").parentElement).toHaveFocus();
  });

  it("lands focus on Got it when the tip has nothing more to show", async () => {
    serveTips(makeTip({ id: "first", title: null, explanation: null }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));
    expect(cardButtonNames()).toEqual(["Got it", "Discuss in comments", "Dismiss"]);
    expect(cardButton("Got it")).toHaveFocus();
  });

  it("moves focus into the card on Learn more even when the click left it elsewhere", async () => {
    serveTips(makeTip({ id: "first", title: null, explanation: null }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Learn more").blur());
    fireEvent.click(cardButton("Learn more"));
    expect(cardButton("Got it")).toHaveFocus();
  });

  it("opens on the first set again after the card was closed", async () => {
    serveTips(makeTip({ explanation: "Because." }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));
    fireEvent.click(bubbleToggle());
    openCard();
    expect(cardButtonNames()).toEqual(["Learn more", "I already know", "Dismiss"]);
    expect(screen.queryByText("Because.")).not.toBeInTheDocument();
  });

  it("ignores the second click of a double-click, which lands on the button that replaced it", async () => {
    serveTips(makeTip({ id: "first" }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"), { detail: 1 });
    fireEvent.click(cardButton("Got it"), { detail: 2 });
    await flush();
    expect(apiMock.setTipState).not.toHaveBeenCalled();
    expect(cardButtonNames()).toEqual(["Got it", "Discuss in comments", "Dismiss"]);
  });
});

describe("tip card — I already know and Got it", () => {
  it("I already know saves known, hides the tip at once and goes straight on to the next tip", async () => {
    servePair();
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("I already know"));
    await flush();

    expect(apiMock.setTipState).toHaveBeenCalledExactlyOnceWith("first", {
      state: "known",
      feedback: null,
    });
    expect(cachedState(queryClient, "first")).toEqual({ state: "known", feedback: null });
    // No wait for a re-schedule: the next tip is already up, in full.
    expect(bubbleText()).toContain("Second line");
    expect(bubbleToggle()).toHaveAttribute("aria-expanded", "false");
    await elapse(7_999);
    expect(bubbleText()).toContain("Second line");
    await settle();
    expect(bubbleText()).not.toContain("First line");
  });

  it("Got it after Learn more does the same", async () => {
    servePair();
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));
    fireEvent.click(cardButton("Got it"));
    await flush();
    expect(apiMock.setTipState).toHaveBeenCalledExactlyOnceWith("first", {
      state: "known",
      feedback: null,
    });
    expect(cachedState(queryClient, "first")).toEqual({ state: "known", feedback: null });
    expect(bubbleText()).toContain("Second line");
  });

  it("leaves the page without a bubble when the last tip is known", async () => {
    serveTips(makeTip({ id: "first" }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("I already know"));
    await settle();
    expect(getBubble()).toBeNull();
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
  });
});

describe("tip card — Discuss in comments", () => {
  it("quotes the tip after the issue's comment draft and opens the issue, leaving the tip as it was", async () => {
    useCommentDraftStore.getState().setDraft("new:issue-1", "My notes");
    serveTips(
      makeTip({
        id: "first",
        line: "Kept the old API",
        explanation: "Clients still call it.",
      }),
    );
    const { navigation } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));
    fireEvent.click(cardButton("Discuss in comments"));
    await settle();

    expect(useCommentDraftStore.getState().getDraft("new:issue-1")).toBe(
      [
        "My notes",
        "",
        "> ✦ You should know · Kept the old API",
        ">",
        "> Clients still call it.",
      ].join("\n"),
    );
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/acme/issues/OL-1");
    expect(apiMock.setTipState).not.toHaveBeenCalled();
    // The tip stays in rotation; only the card closed.
    expect(bubbleText()).toContain("Kept the old API");
    expect(bubbleToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("starts a draft when there is none", async () => {
    serveTips(makeTip({ id: "first", line: "Kept the old API", explanation: null }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));
    fireEvent.click(cardButton("Discuss in comments"));
    expect(useCommentDraftStore.getState().getDraft("new:issue-1")).toBe(
      "> ✦ You should know · Kept the old API",
    );
  });

  it("stays on the page when the issue's detail is already open on it", async () => {
    serveTips(makeTip({ id: "first", issue_id: "issue-1" }));
    // e.g. the issue peek over a list: the bubble rides its detail header.
    const { navigation } = renderWithYsk(<HeaderAnchor issueId="issue-1" />);
    await settle();
    expect(getBubble()).toHaveAttribute("data-level", "detail_header");
    openCard();
    fireEvent.click(cardButton("Learn more"));
    fireEvent.click(cardButton("Discuss in comments"));
    expect(useCommentDraftStore.getState().getDraft("new:issue-1")).toContain("> ✦ You should know");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("stays on the issue's own page, by identifier or UUID", async () => {
    for (const pathname of [`/${WS_SLUG}/issues/OL-1`, `/${WS_SLUG}/issues/issue-1`]) {
      serveTips(makeTip({ id: "first", issue_id: "issue-1" }));
      const navigation = createNavigation({ pathname });
      renderWithYsk(<RowAnchor issueId="issue-1" />, { navigation });
      await settle();
      openCard();
      fireEvent.click(cardButton("Learn more"));
      fireEvent.click(cardButton("Discuss in comments"));
      expect(navigation.push).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("quotes the tag in the interface language", async () => {
    serveTips(
      makeTip({
        id: "first",
        tag: "heads_up",
        line: "改了公共接口",
        explanation: "调用方要一起升级。",
      }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />, { locale: "zh-Hans" });
    await settle();
    openCard();
    fireEvent.click(cardButton("了解更多"));
    fireEvent.click(cardButton("去评论区聊"));
    expect(useCommentDraftStore.getState().getDraft("new:issue-1")).toBe(
      ["> ✦ 提个醒 · 改了公共接口", ">", "> 调用方要一起升级。"].join("\n"),
    );
  });
});

describe("tip card — failures", () => {
  it("brings the tip back and says so when I already know fails", async () => {
    serveTips(makeTip({ id: "first", line: "First line" }));
    apiMock.setTipState.mockRejectedValueOnce(new Error("500"));
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("I already know"));
    await flush();

    expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn't save. Try again.");
    expect(cachedState(queryClient, "first")).toBeNull();
    await settle();
    expect(bubbleText()).toContain("First line");
  });

});

describe("tip card — another tab", () => {
  type Handler = (payload: unknown) => void;

  function createMockWs() {
    const handlers = new Map<string, Set<Handler>>();
    return {
      on: (event: string, handler: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>();
        set.add(handler);
        handlers.set(event, set);
        return () => set.delete(handler);
      },
      onReconnect: () => () => {},
      emit: (event: string, payload: unknown) => {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    };
  }

  type RealtimeWs = Parameters<typeof useYouShouldKnowRealtimeSync>[0];

  function RealtimeSync({ ws }: { ws: ReturnType<typeof createMockWs> }) {
    useYouShouldKnowRealtimeSync(ws as unknown as RealtimeWs);
    return null;
  }

  function stateChangedElsewhere(ws: ReturnType<typeof createMockWs>, tipId: string) {
    act(() => {
      ws.emit("issue_tip_state:changed", {
        workspace_id: WS_ID,
        issue_id: "issue-1",
        tip_id: tipId,
        user_id: "user-1",
        state: "known",
        feedback: null,
        updated_at: "2026-10-11T10:00:00Z",
      });
    });
  }

  beforeEach(() => setCurrentWorkspace(WS_SLUG, WS_ID));
  afterEach(() => setCurrentWorkspace(null, null));

  it("drops the bubble when another tab acts on its tip, and the rotation moves to the next one", async () => {
    const ws = createMockWs();
    servePair();
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <RealtimeSync ws={ws} />
      </>,
    );
    await settle();
    await elapse(2_000);
    expect(bubbleText()).toContain("First line");

    stateChangedElsewhere(ws, "first");
    await flush();
    expect(bubbleText()).not.toContain("First line");
    // Within one settle window — not at the end of the 8s dwell.
    await settle();
    expect(bubbleText()).toContain("Second line");
    expect(apiMock.setTipState).not.toHaveBeenCalled();
  });

  it("takes an open card with it and lets the rotation go on", async () => {
    const ws = createMockWs();
    servePair();
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <RealtimeSync ws={ws} />
      </>,
    );
    await settle();
    openCard();
    act(() => bubbleToggle().blur());
    stateChangedElsewhere(ws, "first");
    await settle();
    expect(bubbleText()).toContain("Second line");
    expect(cardButtonNames()).toEqual([]);
    // No hold is left behind by the card that went away.
    await elapse(8_000);
    expect(apiMock.listActiveTips).toHaveBeenCalled();
    expect(bubbleText()).toContain("Second line");
    expect(getBubble()).toHaveAttribute("data-level", "row");
  });
});

describe("tip card — motion", () => {
  it("opens without animation and keeps the one fade of the bubble", async () => {
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    const card = within(getBubble()!).getByRole("group");
    expect(card.outerHTML).not.toMatch(/animate-|fade-in|slide-in|zoom-in/);
    for (const button of within(card).getAllByRole("button")) {
      expect(button).not.toHaveClass("transition-none");
    }
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    const body = feedbackRow()!.querySelector("[data-motion]")!;
    expect(body).toHaveAttribute("data-motion", "fade");
    expect(feedbackRow()!.innerHTML).not.toMatch(/animate-(pulse|ping|spin|bounce)|shimmer/);
  });

  it("has no transitions at all under prefers-reduced-motion", async () => {
    preferReducedMotion();
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    for (const button of within(within(getBubble()!).getByRole("group")).getAllByRole("button")) {
      expect(button).toHaveClass("transition-none");
    }
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    const body = feedbackRow()!.querySelector("[data-motion]")!;
    expect(body).toHaveAttribute("data-motion", "none");
    expect(body.className).not.toMatch(/animate-in|fade-in|duration-/);
    for (const button of within(feedbackRow()!).getAllByRole("button")) {
      expect(button).toHaveClass("transition-none");
    }
  });
});

