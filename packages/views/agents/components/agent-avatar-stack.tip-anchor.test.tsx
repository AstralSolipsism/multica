// @vitest-environment jsdom

import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTipAnchorRegistry,
  type TipAnchorRegistry,
} from "@multica/core/you-should-know/anchors";
import { renderWithI18n } from "../../test/i18n";
import { TipAnchorRegistryProvider } from "../../you-should-know/anchors/tip-anchor-context";

// Counts useActorName calls — one per AgentAvatarStack render — so a test can
// prove a plain stack mounts without the extra render a state-setting ref
// would cause.
const renderCount = vi.hoisted(() => ({ count: 0 }));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => {
    renderCount.count += 1;
    return {
      getActorName: (_type: string, id: string) => `Agent ${id}`,
      getActorInitials: () => "AG",
      getActorAvatarUrl: () => null,
    };
  },
}));

import { AgentAvatarStack } from "./agent-avatar-stack";

// Controllable IntersectionObserver stand-in (jsdom has none). Tests that
// install it drive visibility entries by hand; tests that don't exercise the
// hook's no-observer fallback (anchor reports visible).
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  observed = new Set<Element>();
  disconnected = false;
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
    this.disconnected = true;
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
  renderCount.count = 0;
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

  it("unregisters when the anchor unmounts (no-observer fallback path)", () => {
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

  it("unregisters and disconnects the observer on unmount (IO path)", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const { unmount } = renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    const observer = MockIntersectionObserver.instances[0]!;
    const element = [...observer.observed][0]!;
    act(() => observer.emit(element, true));
    expect(registeredAnchors()).toHaveLength(1);
    unmount();
    expect(registeredAnchors()).toHaveLength(0);
    expect(observer.disconnected).toBe(true);
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

  it("updates a changed descriptor in place — visibility, bubble and dots survive", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const scope = { "issue-1": "OL-1" };
    const { rerender } = renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "summary", scope }}
      />,
    );
    const observer = MockIntersectionObserver.instances[0]!;
    const element = [...observer.observed][0]!;
    act(() => observer.emit(element, true));
    const id = Object.keys(registry.getState().anchors)[0]!;
    act(() =>
      registry.getState().setDisplay({ bubbleAnchorId: id, dotAnchorIds: [id] }),
    );

    // The summary's scope grows (infinite scroll paged another issue in).
    const nextScope = { "issue-1": "OL-1", "issue-2": "OL-2" };
    rerender(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "summary", scope: nextScope }}
      />,
    );

    const anchors = registry.getState().anchors;
    // Same anchor, still visible, bubble and dots untouched, scope updated.
    expect(Object.keys(anchors)).toEqual([id]);
    expect(anchors[id]).toMatchObject({
      descriptor: { level: "summary", scope: nextScope },
      visible: true,
    });
    expect(registry.getState().display).toEqual({
      bubbleAnchorId: id,
      dotAnchorIds: [id],
    });
    // No second observer: the lifecycle effect did not re-run.
    expect(MockIntersectionObserver.instances).toHaveLength(1);
    expect(observer.disconnected).toBe(false);
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
    act(() => observer.emit(element, true));
    expect(registry.getState().anchors[id]!.visible).toBe(true);
    // A virtualized row scrolling out flips it back to not visible.
    act(() => observer.emit(element, false));
    expect(registry.getState().anchors[id]!.visible).toBe(false);
  });

  it("measures the page position live instead of caching it", () => {
    renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
    );
    const id = Object.keys(registry.getState().anchors)[0]!;
    const measure = registry.getState().anchors[id]!.measure;
    // Lists scroll inside inner containers, so a stored coordinate goes stale
    // on every scroll; measure() must read the element's CURRENT rect.
    let top = 100;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top }) as DOMRect,
    );
    expect(measure()).toBe(100);
    top = 240;
    expect(measure()).toBe(240);
    vi.restoreAllMocks();
  });
});

describe("AgentAvatarStack render cost", () => {
  it("mounts a plain stack (no provider, no descriptor) without an extra render", () => {
    renderStack(<AgentAvatarStack agentIds={["agent-1"]} />, {
      withProvider: false,
    });
    expect(renderCount.count).toBe(1);
  });

  it("mounts a descriptor-carrying stack without a provider without an extra render", () => {
    renderStack(
      <AgentAvatarStack
        agentIds={["agent-1"]}
        tipAnchor={{ level: "row", issueId: "issue-1" }}
      />,
      { withProvider: false },
    );
    expect(renderCount.count).toBe(1);
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

  it("lights the dot only on the marked anchor, not on every anchor", () => {
    renderStack(
      <>
        <AgentAvatarStack
          agentIds={["agent-1"]}
          tipAnchor={{ level: "row", issueId: "issue-1" }}
        />
        <AgentAvatarStack
          agentIds={["agent-2"]}
          tipAnchor={{ level: "row", issueId: "issue-2" }}
        />
      </>,
    );
    const [firstId] = Object.keys(registry.getState().anchors);
    act(() =>
      registry.getState().setDisplay({
        bubbleAnchorId: null,
        dotAnchorIds: [firstId!],
      }),
    );
    expect(screen.getAllByTestId("tip-anchor-dot")).toHaveLength(1);
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
