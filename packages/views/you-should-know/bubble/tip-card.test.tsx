// @vitest-environment jsdom

/**
 * The bubble's card, its buttons and the feedback row (OL-196), through the
 * real provider and host: what each button does, both feedback sets, the
 * feedback row's timeout, "Discuss in comments", rollback on failure,
 * keyboard and focus, and a state change arriving from another tab. A small
 * fake server answers the tips list with the states it was sent, like the
 * real one. Fake timers drive dwell and timeouts.
 */

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { setCurrentWorkspace } from "@multica/core/platform";
import {
  tipDisplayLedger,
  useYouShouldKnowRealtimeSync,
  youShouldKnowKeys,
  type IssueTip,
  type IssueTipList,
  type IssueTipUserState,
  type SetTipStateRequest,
} from "@multica/core/you-should-know";
import type { TipAnchorDescriptor } from "@multica/core/you-should-know/anchors";
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
import { TIP_FEEDBACK_TIMEOUT_MS } from "./tip-feedback-row";

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

import { AgentAvatarStack } from "../../agents/components/agent-avatar-stack";

// --- Fake server --------------------------------------------------------

const server = {
  tips: [] as IssueTip[],
  states: new Map<string, IssueTipUserState>(),
};

function serveTips(...tips: IssueTip[]) {
  server.tips = tips;
  server.states.clear();
}

function servePair() {
  serveTips(
    makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
    makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
  );
}

function cachedState(
  queryClient: ReturnType<typeof renderWithYsk>["queryClient"],
  tipId: string,
): IssueTipUserState | null | undefined {
  return queryClient
    .getQueryData<IssueTipList>(youShouldKnowKeys.active(WS_ID))
    ?.tips.find((tip) => tip.id === tipId)?.user_state;
}

// --- Page fixtures -------------------------------------------------------

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

function HeaderAnchor({ issueId }: { issueId: string }) {
  return (
    <Anchor
      testId={`header-${issueId}`}
      rect="1000,40,60,20"
      descriptor={{ level: "detail_header", issueId }}
    />
  );
}

// --- Layer queries ---------------------------------------------------------

function bubbleText(): string {
  return getBubble()?.textContent ?? "";
}

/** The bubble line: the button that opens and closes the card. */
function bubbleToggle(): HTMLButtonElement {
  const toggle = getBubble()?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (!toggle) throw new Error("no bubble on the page");
  return toggle;
}

function openCard() {
  fireEvent.click(bubbleToggle());
  expect(bubbleToggle()).toHaveAttribute("aria-expanded", "true");
}

function cardButton(name: string): HTMLElement {
  return within(getBubble()!).getByRole("button", { name });
}

function cardButtonNames(): string[] {
  const card = within(getBubble()!).queryByRole("group");
  return card ? within(card).getAllByRole("button").map((button) => button.textContent ?? "") : [];
}

function feedbackRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-ysk-feedback]");
}

function feedbackButton(name: string): HTMLElement {
  return within(feedbackRow()!).getByRole("button", { name });
}

function dotIn(testId: string): HTMLElement | null {
  return within(screen.getByTestId(testId)).queryByTestId("tip-anchor-dot");
}

const originalMatchMedia = window.matchMedia;

function preferReducedMotion() {
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
}

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  toastError.mockReset();
  apiMock.listActiveTips.mockImplementation(async () => ({
    tips: server.tips.map((tip) => ({
      ...tip,
      user_state: server.states.get(tip.id) ?? tip.user_state,
    })),
  }));
  apiMock.setTipState.mockImplementation(async (tipId: string, request: SetTipStateRequest) => {
    server.states.set(tipId, { state: request.state, feedback: request.feedback });
  });
  localStorage.clear();
  tipDisplayLedger.setState({ users: {} });
  useCommentDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

describe("tip card — Dismiss and the feedback row", () => {
  it("saves dismissed and leaves Helpful / Not relevant / Didn't understand in the bubble's place", async () => {
    servePair();
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    const placement = getBubble()!.getAttribute("data-placement");
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await flush();

    expect(apiMock.setTipState).toHaveBeenCalledExactlyOnceWith("first", {
      state: "dismissed",
      feedback: null,
    });
    expect(cachedState(queryClient, "first")).toEqual({ state: "dismissed", feedback: null });
    expect(getBubble()).toBeNull();
    const row = feedbackRow()!;
    expect(row).toHaveAttribute("data-level", "row");
    expect(row).toHaveAttribute("data-placement", placement);
    expect(within(row).getByRole("group", { name: "Feedback on this tip" })).toBeInTheDocument();
    expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Helpful",
      "Not relevant",
      "Didn't understand",
    ]);
  });

  it("offers Helpful / Didn't understand when dismissed after Learn more", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    expect(apiMock.setTipState).toHaveBeenCalledExactlyOnceWith("first", {
      state: "dismissed",
      feedback: null,
    });
    expect(within(feedbackRow()!).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Helpful",
      "Didn't understand",
    ]);
  });

  it("is the page's only bubble while it shows: the next tip waits, with a dot on its anchor", async () => {
    serveTips(
      makeTip({ id: "first", issue_id: "issue-1", line: "First line" }),
      makeTip({ id: "second", issue_id: "issue-2", line: "Second line" }),
    );
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" top={300} />
        <RowAnchor issueId="issue-2" top={340} />
      </>,
    );
    await settle();
    expect(bubbleText()).toContain("First line");
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();

    await elapse(15_000);
    expect(getBubble()).toBeNull();
    expect(document.querySelectorAll("[data-ysk-feedback]")).toHaveLength(1);
    expect(dotIn("row-issue-2")).not.toBeNull();
    expect(dotIn("row-issue-1")).toBeNull();
    // Waiting is not being shown: the next tip is not counted yet.
    expect(tipDisplayLedger.getState().users["user-1"]?.ordinals).toEqual({ first: 1 });
  });

  it("sends the picked reason with the dismissal, closes the row and hands over to the next tip", async () => {
    servePair();
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();

    fireEvent.click(feedbackButton("Not relevant"));
    await flush();
    expect(apiMock.setTipState).toHaveBeenCalledTimes(2);
    expect(apiMock.setTipState).toHaveBeenLastCalledWith("first", {
      state: "dismissed",
      feedback: "not_relevant",
    });
    expect(cachedState(queryClient, "first")).toEqual({
      state: "dismissed",
      feedback: "not_relevant",
    });
    expect(feedbackRow()).toBeNull();
    expect(bubbleText()).toContain("Second line");
    // The next tip gets its whole dwell: it never ran behind the row.
    await elapse(7_999);
    expect(bubbleText()).toContain("Second line");
  });

  it("keeps the next tip's dwell from running behind it", async () => {
    serveTips(
      makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
      makeTip({ id: "third", line: "Third line", created_at: "2026-10-11T10:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    await elapse(15_000);
    fireEvent.click(feedbackButton("Helpful"));
    await flush();
    act(() => (document.activeElement as HTMLElement | null)?.blur());

    // Second was next before the row and still is, with its whole 8s.
    expect(bubbleText()).toContain("Second line");
    await elapse(7_999);
    expect(bubbleText()).toContain("Second line");
    await elapse(1);
    expect(bubbleText()).toContain("Third line");
  });

  it("leaves after 20 seconds without a pick, sending nothing more", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await flush();

    await elapse(TIP_FEEDBACK_TIMEOUT_MS - 1);
    expect(feedbackRow()).not.toBeNull();
    expect(getBubble()).toBeNull();
    await elapse(1);
    expect(feedbackRow()).toBeNull();
    expect(apiMock.setTipState).toHaveBeenCalledTimes(1);
    expect(bubbleText()).toContain("Second line");
  });

  it("ignores the second click of a double-click on Dismiss", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"), { detail: 1 });
    // The second click arrives once the row has taken the card's place.
    await flush();
    fireEvent.click(feedbackButton("Didn't understand"), { detail: 2 });
    await flush();
    expect(apiMock.setTipState).toHaveBeenCalledTimes(1);
    expect(feedbackRow()).not.toBeNull();
  });

  it("hides under a modal layer, as the bubble does", async () => {
    // A lone tip: once it is dismissed, no other tip is waiting behind the row.
    serveTips(makeTip({ id: "first" }));
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackRow()).toHaveStyle({ visibility: "visible" });

    const inert = document.createElement("div");
    await act(async () => {
      inert.setAttribute("data-base-ui-inert", "");
      document.body.appendChild(inert);
    });
    expect(feedbackRow()).toHaveStyle({ visibility: "hidden" });
    await act(async () => {
      inert.remove();
    });
    expect(feedbackRow()).toHaveStyle({ visibility: "visible" });
  });

  it("goes away with its anchor", async () => {
    servePair();
    const view = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackRow()).not.toBeNull();

    view.rerender(<div />);
    await settle();
    expect(feedbackRow()).toBeNull();
    // Nothing is left holding the rotation once an anchor comes back.
    view.rerender(<RowAnchor issueId="issue-1" />);
    await settle();
    expect(bubbleText()).toContain("Second line");
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

  it("drops the feedback row and brings the tip back when Dismiss fails", async () => {
    serveTips(makeTip({ id: "first", line: "First line" }));
    apiMock.setTipState.mockRejectedValueOnce(new Error("500"));
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await flush();

    expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn't save. Try again.");
    expect(feedbackRow()).toBeNull();
    expect(cachedState(queryClient, "first")).toBeNull();
    await settle();
    expect(bubbleText()).toContain("First line");
  });

  it("keeps the tip dismissed and says so when the reason fails to save", async () => {
    serveTips(makeTip({ id: "first", line: "First line" }));
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    apiMock.setTipState.mockRejectedValueOnce(new Error("500"));
    fireEvent.click(feedbackButton("Helpful"));
    await flush();

    expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn't save. Try again.");
    expect(feedbackRow()).toBeNull();
    // Rolled back to the dismissal without a reason — still hidden.
    expect(cachedState(queryClient, "first")).toEqual({ state: "dismissed", feedback: null });
    await settle();
    expect(getBubble()).toBeNull();
  });
});

describe("tip card — failures, out of order", () => {
  it("leaves the current feedback row alone when an earlier dismissal fails late", async () => {
    servePair();
    let rejectFirst!: (error: Error) => void;
    apiMock.setTipState.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectFirst = reject)),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    // The reason queues behind the dismissal still in flight; the next tip
    // takes over and is dismissed in turn.
    fireEvent.click(feedbackButton("Helpful"));
    await settle();
    expect(bubbleText()).toContain("Second line");
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    expect(feedbackRow()).not.toBeNull();

    await act(async () => rejectFirst(new Error("500")));
    await flush();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(feedbackRow()).not.toBeNull();
    expect(apiMock.setTipState).toHaveBeenLastCalledWith("second", {
      state: "dismissed",
      feedback: null,
    });
  });
});

describe("tip card — keyboard and focus", () => {
  // user-event awaits a zero-delay timeout through Testing Library's async
  // wrapper, which only Jest's fake clock advances by itself: let this one
  // follow real time too.
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  it("runs on the keyboard: Enter opens, Tab walks the buttons, Space and Enter act", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    serveTips(
      makeTip({ id: "first", line: "First line", explanation: "Because.", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();

    act(() => bubbleToggle().focus());
    await user.keyboard("{Enter}");
    expect(bubbleToggle()).toHaveAttribute("aria-expanded", "true");
    expect(cardButton("Learn more")).toHaveFocus();
    await user.tab();
    expect(cardButton("I already know")).toHaveFocus();
    await user.tab();
    expect(cardButton("Dismiss")).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(cardButton("Learn more")).toHaveFocus();

    await user.keyboard(" ");
    expect(screen.getByText("Because.").parentElement).toHaveFocus();
    await user.tab();
    expect(cardButton("Got it")).toHaveFocus();
    await user.keyboard("{Enter}");
    await flush();
    expect(apiMock.setTipState).toHaveBeenCalledExactlyOnceWith("first", {
      state: "known",
      feedback: null,
    });
    // Focus stays in the tip layer: on the bubble that took over.
    expect(bubbleText()).toContain("Second line");
    expect(bubbleToggle()).toHaveFocus();
  });

  it("moves keyboard focus onto the feedback row, then onto the next bubble after a pick", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    act(() => bubbleToggle().focus());
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    expect(cardButton("Dismiss")).toHaveFocus();
    await user.keyboard("{Enter}");
    await settle();
    expect(feedbackButton("Helpful")).toHaveFocus();

    await user.tab();
    expect(feedbackButton("Not relevant")).toHaveFocus();
    await user.keyboard("{Enter}");
    await flush();
    expect(apiMock.setTipState).toHaveBeenLastCalledWith("first", {
      state: "dismissed",
      feedback: "not_relevant",
    });
    expect(bubbleText()).toContain("Second line");
    expect(bubbleToggle()).toHaveFocus();
  });

  it("hands focus to the next bubble when the feedback row it sat in times out", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    act(() => bubbleToggle().focus());
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    await settle();
    expect(feedbackButton("Helpful")).toHaveFocus();

    await elapse(TIP_FEEDBACK_TIMEOUT_MS);
    expect(feedbackRow()).toBeNull();
    expect(bubbleToggle()).toHaveFocus();
  });

  it("moves focus onto the feedback row only once it is on screen", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    // Not placed yet, so still hidden — and a hidden element cannot take focus.
    expect(feedbackRow()).toHaveStyle({ visibility: "hidden" });
    expect(document.body).toHaveFocus();
    await flush();
    expect(feedbackRow()).toHaveStyle({ visibility: "visible" });
    expect(feedbackButton("Helpful")).toHaveFocus();
  });

  it("does not pull focus back once the user has moved it elsewhere", async () => {
    servePair();
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <button type="button">Elsewhere</button>
      </>,
    );
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    await flush();
    expect(feedbackRow()).toHaveStyle({ visibility: "visible" });
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("takes focus once: not again when the row shows again after a modal", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    expect(feedbackButton("Helpful")).toHaveFocus();
    act(() => feedbackButton("Helpful").blur());

    const inert = document.createElement("div");
    await act(async () => {
      inert.setAttribute("data-base-ui-inert", "");
      document.body.appendChild(inert);
    });
    await act(async () => {
      inert.remove();
    });
    expect(feedbackRow()).toHaveStyle({ visibility: "visible" });
    expect(document.body).toHaveFocus();
  });

  it("hands focus only to the bubble that replaces the layer, not to the ones rotating in later", async () => {
    serveTips(
      makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
      makeTip({ id: "third", line: "Third line", created_at: "2026-10-11T10:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("I already know").focus());
    fireEvent.click(cardButton("I already know"));
    await flush();
    expect(bubbleText()).toContain("Second line");
    expect(bubbleToggle()).toHaveFocus();

    act(() => bubbleToggle().blur());
    await elapse(8_000);
    expect(bubbleText()).toContain("Third line");
    expect(document.body).toHaveFocus();
  });

  it("pulls focus into neither the row nor the next bubble after clicks that left it on the page", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    // A pointer that does not focus what it clicks (Safari): focus stays on
    // the page body throughout.
    act(() => cardButton("Learn more").blur());
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackRow()).toHaveStyle({ visibility: "visible" });
    expect(document.body).toHaveFocus();

    fireEvent.click(feedbackButton("Helpful"));
    await settle();
    expect(bubbleText()).toContain("Second line");
    expect(document.body).toHaveFocus();
  });

  it("leaves focus alone when the layer did not have it", async () => {
    servePair();
    renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" />
        <button type="button">Elsewhere</button>
      </>,
    );
    await settle();
    openCard();
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    // A pointer-only activation (focus stayed outside the card).
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackRow()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();

    fireEvent.click(feedbackButton("Helpful"));
    await flush();
    expect(bubbleText()).toContain("Second line");
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
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
