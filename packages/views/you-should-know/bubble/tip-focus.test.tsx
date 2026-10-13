// @vitest-environment jsdom

/**
 * Keyboard and focus across the tip layers (OL-196): the card on the
 * keyboard, and focus handed from a layer that goes away to the one that
 * takes its place — once it is on screen, only if focus is still free, only
 * to that layer, and never to a tip rotating in later.
 */

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { tipDisplayLedger, youShouldKnowKeys } from "@multica/core/you-should-know";
import {
  elapse,
  flush,
  getBubble,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
  WS_ID,
} from "../../test/you-should-know";
import {
  bubbleText,
  bubbleToggle,
  cardButton,
  controllableIntersectionObserver,
  feedbackButton,
  feedbackRow,
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
let addTip: ReturnType<typeof installFakeTipServer>["addTip"];
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  toastError.mockReset();
  ({ serveTips, servePair, addTip } = installFakeTipServer(apiMock));
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

describe("tip layers — keyboard and focus", () => {
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

    await elapse(20_000);
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
    // Round again to the tip that took focus: it does not take it twice.
    await elapse(8_000);
    expect(bubbleText()).toContain("Second line");
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

describe("tip layers — focus when the feedback row ends", () => {
  it("hands focus to the next bubble when a reason is picked before the re-schedule", async () => {
    // Review regression: the dismissed tip is still the rotation's current
    // one, so its successor only shows a re-schedule later.
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    expect(feedbackButton("Helpful")).toHaveFocus();
    fireEvent.click(feedbackButton("Helpful"));
    await settle();
    expect(bubbleText()).toContain("Second line");
    expect(bubbleToggle()).toHaveFocus();
  });

  it("hands focus to whichever bubble actually takes the row's place", async () => {
    servePair();
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    fireEvent.click(feedbackButton("Helpful"));
    // A heads-up lands (as a realtime event would bring it) before the
    // re-schedule, and goes first.
    addTip(makeTip({ id: "heads", tag: "heads_up", line: "Heads line" }));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: youShouldKnowKeys.active(WS_ID) });
    });
    await settle();
    expect(bubbleText()).toContain("Heads line");
    expect(bubbleToggle()).toHaveFocus();
  });

  it("hands focus to the restored bubble when a pending dismissal fails", async () => {
    // Review regression.
    serveTips(makeTip({ id: "first", line: "First line" }));
    let rejectDismiss!: (reason: Error) => void;
    apiMock.setTipState.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectDismiss = reject)),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackButton("Helpful")).toHaveFocus();

    await act(async () => rejectDismiss(new Error("500")));
    await settle();
    expect(feedbackRow()).toBeNull();
    expect(bubbleText()).toContain("First line");
    expect(bubbleToggle()).toHaveFocus();
  });

  it("hands focus on when the row it sat in ends with its anchor going off screen", async () => {
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
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    expect(feedbackButton("Helpful")).toHaveFocus();

    observers.set("row-issue-1", false);
    await settle();
    expect(feedbackRow()).toBeNull();
    expect(bubbleText()).toContain("Second line");
    expect(bubbleToggle()).toHaveFocus();
  });

  it("gives focus to no later tip when nothing took the row's place", async () => {
    serveTips(makeTip({ id: "first", line: "First line" }));
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    fireEvent.click(feedbackButton("Helpful"));
    await settle();
    expect(feedbackRow()).toBeNull();
    expect(document.body).toHaveFocus();

    // A tip arriving later rotates in like any other: it takes no focus.
    await elapse(5_000);
    act(() => {
      queryClient.setQueryData(youShouldKnowKeys.active(WS_ID), {
        tips: [makeTip({ id: "later", line: "Later line" })],
      });
    });
    await settle();
    expect(bubbleText()).toContain("Later line");
    expect(document.body).toHaveFocus();
  });

  it("lets the hand-off lapse when its replacement never shows", async () => {
    serveTips(
      makeTip({ id: "first", issue_id: "issue-1", line: "First line" }),
      makeTip({ id: "second", issue_id: "issue-2", line: "Second line" }),
    );
    const view = renderWithYsk(
      <>
        <RowAnchor issueId="issue-1" top={300} />
        <RowAnchor issueId="issue-2" top={340} />
      </>,
    );
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await flush();
    // Picked before the re-schedule: the second tip is waiting to take over...
    fireEvent.click(feedbackButton("Helpful"));
    // ...but its row goes away before it can show.
    view.rerender(<RowAnchor issueId="issue-1" top={300} />);
    await settle();
    expect(getBubble()).toBeNull();
    expect(document.body).toHaveFocus();

    // When it does come back, it rotates in like any other tip.
    view.rerender(
      <>
        <RowAnchor issueId="issue-1" top={300} />
        <RowAnchor issueId="issue-2" top={340} />
      </>,
    );
    await settle();
    expect(bubbleText()).toContain("Second line");
    expect(document.body).toHaveFocus();
  });

  it("spends the hand-off on the bubble that took over, so the next tip in rotation takes none", async () => {
    serveTips(
      makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
      makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
      makeTip({ id: "third", line: "Third line", created_at: "2026-10-11T10:00:00Z" }),
    );
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    // The second tip is already queued behind the row: it shows in the very
    // commit the row leaves, without the rotation moving.
    await settle();
    fireEvent.click(feedbackButton("Helpful"));
    await flush();
    expect(bubbleText()).toContain("Second line");
    expect(bubbleToggle()).toHaveFocus();

    act(() => bubbleToggle().blur());
    await elapse(8_000);
    expect(bubbleText()).toContain("Third line");
    expect(document.body).toHaveFocus();
  });

  it("leaves focus where it was after a pointer-only I already know", async () => {
    servePair();
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Learn more").blur());
    fireEvent.click(cardButton("I already know"));
    await flush();
    expect(bubbleText()).toContain("Second line");
    expect(document.body).toHaveFocus();
  });

  it("hands focus to nothing while the tips read is failing", async () => {
    servePair();
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    act(() => cardButton("Dismiss").focus());
    fireEvent.click(cardButton("Dismiss"));
    await settle();
    // The server stops answering: the cached second tip is no longer vouched
    // for, so nothing is waiting to replace the row.
    apiMock.listActiveTips.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: youShouldKnowKeys.active(WS_ID) });
    });
    await settle();
    expect(feedbackButton("Helpful")).toHaveFocus();
    fireEvent.click(feedbackButton("Helpful"));
    // The save's refetch brings the tips back; the second tip shows, unfocused.
    await settle();
    expect(bubbleText()).toContain("Second line");
    expect(document.body).toHaveFocus();
  });
});
