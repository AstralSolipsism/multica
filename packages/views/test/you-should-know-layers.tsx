import { act, fireEvent, screen, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { expect, vi, type Mock } from "vitest";
import {
  youShouldKnowKeys,
  type IssueTip,
  type IssueTipList,
  type IssueTipUserState,
  type SetTipStateRequest,
} from "@multica/core/you-should-know";
import type { TipAnchorDescriptor } from "@multica/core/you-should-know/anchors";
import { AgentAvatarStack } from "../agents/components/agent-avatar-stack";
import { getBubble, makeTip, WS_ID } from "./you-should-know";

// Page fixtures and layer queries for the You-should-know suites (OL-194,
// OL-196). Suites rendering anchors still mock actor names themselves
// (`@multica/core/workspace/hooks`) — vi.mock is per file.

// --- Fake server ------------------------------------------------------------

/**
 * Answers the tips list with the states it was sent, like the real server:
 * after a successful setTipState, the refetch that follows no longer offers
 * the tip. Install after resetting the mocks.
 */
export function installFakeTipServer(api: { listActiveTips: Mock; setTipState: Mock }) {
  let tips: IssueTip[] = [];
  const states = new Map<string, IssueTipUserState>();
  api.listActiveTips.mockImplementation(async () => ({
    tips: tips.map((tip) => ({ ...tip, user_state: states.get(tip.id) ?? tip.user_state })),
  }));
  api.setTipState.mockImplementation(async (tipId: string, request: SetTipStateRequest) => {
    states.set(tipId, { state: request.state, feedback: request.feedback });
  });
  const serveTips = (...served: IssueTip[]) => {
    tips = served;
    states.clear();
  };
  return {
    serveTips,
    /** A new tip on the server, keeping the states already sent. */
    addTip: (tip: IssueTip) => {
      tips = [...tips, tip];
    },
    /** Two tips on issue-1, "First line" shown first. */
    servePair: () =>
      serveTips(
        makeTip({ id: "first", line: "First line", created_at: "2026-10-11T08:00:00Z" }),
        makeTip({ id: "second", line: "Second line", created_at: "2026-10-11T09:00:00Z" }),
      ),
  };
}

/** The viewer's cached state of a tip in the active list. */
export function cachedState(
  queryClient: QueryClient,
  tipId: string,
): IssueTipUserState | null | undefined {
  return queryClient
    .getQueryData<IssueTipList>(youShouldKnowKeys.active(WS_ID))
    ?.tips.find((tip) => tip.id === tipId)?.user_state;
}

// --- Page fixtures ------------------------------------------------------------

/** A real AgentAvatarStack anchor inside a `[data-test-rect]` box (see mockLayout). */
export function Anchor({
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

export function RowAnchor({ issueId, top = 300 }: { issueId: string; top?: number }) {
  return (
    <Anchor
      testId={`row-${issueId}`}
      rect={`100,${top},40,16`}
      descriptor={{ level: "row", issueId }}
    />
  );
}

export function HeaderAnchor({ issueId }: { issueId: string }) {
  return (
    <Anchor
      testId="header"
      rect="1000,40,60,20"
      descriptor={{ level: "detail_header", issueId }}
    />
  );
}

/**
 * IntersectionObserver stand-in whose entries the test emits: anchors stay
 * invisible until reported. Undo with vi.unstubAllGlobals().
 */
export function controllableIntersectionObserver() {
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

/** Makes `prefers-reduced-motion` match; restore window.matchMedia afterwards. */
export function preferReducedMotion() {
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

// --- Layer queries ------------------------------------------------------------

export function bubbleText(): string {
  return getBubble()?.textContent ?? "";
}

/** The bubble line: the button that opens and closes the card. */
export function bubbleToggle(): HTMLButtonElement {
  const toggle = getBubble()?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (!toggle) throw new Error("no bubble on the page");
  return toggle;
}

export function openCard() {
  fireEvent.click(bubbleToggle());
  expect(bubbleToggle()).toHaveAttribute("aria-expanded", "true");
}

export function cardButton(name: string): HTMLElement {
  return within(getBubble()!).getByRole("button", { name });
}

export function cardButtonNames(): string[] {
  const card = within(getBubble()!).queryByRole("group");
  return card ? within(card).getAllByRole("button").map((button) => button.textContent ?? "") : [];
}

/** The page's feedback row, or null. */
export function feedbackRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-ysk-feedback]");
}

export function feedbackButton(name: string): HTMLElement {
  return within(feedbackRow()!).getByRole("button", { name });
}

export function dotIn(testId: string): HTMLElement | null {
  return within(screen.getByTestId(testId)).queryByTestId("tip-anchor-dot");
}
