// @vitest-environment jsdom

import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTipAnchorRegistry,
  type TipAnchorRegistry,
} from "@multica/core/you-should-know/anchors";
import { renderWithI18n } from "../../test/i18n";
import { TipAnchorRegistryProvider } from "../../you-should-know/anchors/tip-anchor-context";

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

import { AgentAvatarStack } from "./agent-avatar-stack";

// Controllable IntersectionObserver stand-in (jsdom has none). Tests that
// install it drive visibility entries by hand; tests that don't exercise the
// hook's no-observer fallback (anchor reports visible).
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  observed = new Set<Element>();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
  emit(element: Element, isIntersecting: boolean, top = 0) {
    this.callback(
      [
        {
          isIntersecting,
          target: element,
          boundingClientRect: { top } as DOMRect,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

let registry: TipAnchorRegistry;

function renderStack(
  ui: React.ReactElement,
  { withProvider = true }: { withProvider?: boolean } = {},
) {
  const wrap = (node: React.ReactElement) =>
    withProvider ? (
      <TipAnchorRegistryProvider registry={registry}>
        {node}
      </TipAnchorRegistryProvider>
    ) : (
      node
    );
  const result = renderWithI18n(wrap(ui));
  return {
    ...result,
    // RTL's rerender keeps only the wrapper (I18nProvider) — re-wrap with the
    // registry provider or the tree would silently lose it.
    rerender: (next: React.ReactElement) => result.rerender(wrap(next)),
  };
}

function registeredAnchors() {
  return Object.values(registry.getState().anchors);
}

beforeEach(() => {
  registry = createTipAnchorRegistry();
  MockIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
});

describe("AgentAvatarStack tip anchor registration", () => {
  it("registers a row-level anchor with its issue id", () => {
    renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    const anchors = registeredAnchors();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.descriptor).toEqual({ level: "row", issueId: "issue-1" });
    // jsdom has no IntersectionObserver → the fallback reports visible.
    expect(anchors[0]!.visible).toBe(true);
  });

  it("registers a summary anchor with its scope", () => {
    const scope = { "issue-1": "OL-1", "issue-2": "OL-2" };
    renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "summary", scope }}
      />,
    );
    expect(registeredAnchors()[0]!.descriptor).toEqual({
      level: "summary",
      scope,
    });
  });

  it("does not register when no provider is mounted, and renders as usual", () => {
    // No crash, no dot — the feature is inert without a registry.
    renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
      { withProvider: false },
    );
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
  });

  it("does not register when the tipAnchor prop is omitted", () => {
    renderStack(<AgentAvatarStack agentIds={["agent-1"]} />);
    expect(registeredAnchors()).toHaveLength(0);
  });

  it("unregisters when the anchor unmounts", () => {
    const { unmount } = renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    expect(registeredAnchors()).toHaveLength(1);
    unmount();
    expect(registeredAnchors()).toHaveLength(0);
  });

  it("unregisters when the stack renders nothing (no agents left)", () => {
    const { rerender } = renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    expect(registeredAnchors()).toHaveLength(1);
    rerender(
      <AgentAvatarStack
        agentIds={[]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    expect(registeredAnchors()).toHaveLength(0);
  });

  it("does not churn the registry when the descriptor object is recreated with identical content", () => {
    const listener = vi.fn();
    const { rerender } = renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    registry.subscribe(listener);
    rerender(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("re-registers when the descriptor's content changes", () => {
    const { rerender } = renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    rerender(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-2" }}
      />,
    );
    const anchors = registeredAnchors();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.descriptor).toEqual({ level: "row", issueId: "issue-2" });
  });

  it("reports viewport visibility through IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    const observer = MockIntersectionObserver.instances[0]!;
    const element = [...observer.observed][0]!;
    const id = Object.keys(registry.getState().anchors)[0]!;
    // Until the first entry arrives the anchor is registered but not visible.
    expect(registry.getState().anchors[id]!.visible).toBe(false);
    act(() => observer.emit(element, true, 120));
    expect(registry.getState().anchors[id]).toMatchObject({
      visible: true,
      top: 120 + window.scrollY,
    });
    // A virtualized row scrolling out flips it back to not visible.
    act(() => observer.emit(element, false));
    expect(registry.getState().anchors[id]!.visible).toBe(false);
  });
});

describe("AgentAvatarStack tip dot", () => {
  it("renders the dot when the display state marks this anchor", () => {
    renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
    const id = Object.keys(registry.getState().anchors)[0]!;
    act(() =>
      registry.getState().setDisplay({ bubbleAnchorId: null, dotAnchorIds: [id] }),
    );
    const dot = screen.getByTestId("tip-anchor-dot");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    act(() =>
      registry.getState().setDisplay({ bubbleAnchorId: id, dotAnchorIds: [] }),
    );
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
  });

  it("never lights a dot for a stack without a tipAnchor prop", () => {
    renderStack(<AgentAvatarStack agentIds={["agent-1"]} />);
    act(() =>
      registry.getState().setDisplay({
        bubbleAnchorId: null,
        dotAnchorIds: Object.keys(registry.getState().anchors),
      }),
    );
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
  });
});
