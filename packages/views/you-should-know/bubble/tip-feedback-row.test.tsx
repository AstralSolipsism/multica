// @vitest-environment jsdom

/**
 * The feedback row left by "Dismiss" (OL-196), through the real provider and
 * host: both sets of reasons, the pick, the 20-second timeout, being the
 * page's only bubble, its anchor giving out (gone, clipped, or now standing
 * for another issue), and failed or out-of-order saves. A fake server answers
 * the tips list with the states it was sent; fake timers drive the clock.
 */

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { tipDisplayLedger } from "@multica/core/you-should-know";
import {
  elapse,
  flush,
  getBubble,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
} from "../../test/you-should-know";
import {
  bubbleText,
  cachedState,
  cardButton,
  controllableIntersectionObserver,
  dotIn,
  feedbackButton,
  feedbackRow,
  HeaderAnchor,
  installFakeTipServer,
  openCard,
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

describe("feedback row — after Dismiss", () => {
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

    // OL-187 §6: 20 seconds — asserted on its own, not via the exported constant.
    await elapse(19_999);
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

describe("feedback row — failures", () => {
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

describe("feedback row — when its anchor gives out", () => {
  it("ends when its anchor is clipped by an inner scroll container", async () => {
    // Review regression: the anchor stays inside the window, so floating-ui
    // still places the row, but its IntersectionObserver reports it hidden.
    const observers = controllableIntersectionObserver();
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
    observers.showAll();
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackRow()).toBeVisible();

    observers.set("row-issue-1", false);
    await settle();
    expect(feedbackRow()).toBeNull();
    // Nothing is held behind a row nobody can see.
    expect(bubbleText()).toContain("Second line");
  });

  it("ends when the same mounted header now stands for another issue", async () => {
    // Review regression: a detail header re-pointed in place keeps its anchor id.
    serveTips(
      makeTip({ id: "first", issue_id: "issue-1", line: "First line" }),
      makeTip({ id: "second", issue_id: "issue-2", line: "Second line" }),
    );
    const view = renderWithYsk(<HeaderAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackRow()).not.toBeNull();

    view.rerender(<HeaderAnchor issueId="issue-2" />);
    await settle();
    expect(feedbackRow()).toBeNull();
    expect(bubbleText()).toContain("Second line");
  });
});
