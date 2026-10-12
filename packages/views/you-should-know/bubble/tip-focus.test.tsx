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
import { tipDisplayLedger } from "@multica/core/you-should-know";
import {
  elapse,
  flush,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
} from "../../test/you-should-know";
import {
  bubbleText,
  bubbleToggle,
  cardButton,
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
