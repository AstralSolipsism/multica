// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { IssueGraph } from "@multica/core/api";
import {
  viewStoreSlice,
  type IssueViewState,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { renderWithI18n } from "../../test/i18n";
import { DagToolbar, type DagToolbarProps } from "./dag-toolbar";
import { useDagFoldState } from "./use-dag-fold-state";
import { graphNode as makeNode, issueGraph as makeGraph } from "./dag-test-fixtures";

const issueSelection = vi.hoisted(() => ({
  current: {
    issue: null as null | { id: string; assignee_type: null; assignee_id: null },
    actions: { openEditDependencies: vi.fn(), updateField: vi.fn() },
    detailFailed: false,
    retryDetail: vi.fn(),
  },
}));
const assignSpy = vi.hoisted(() =>
  vi.fn<(props: { issue: unknown; open?: boolean; anchor?: unknown }) => void>(),
);
vi.mock("./dag-issue-actions", () => ({
  useDagIssueSelection: () => issueSelection.current,
  DagAssignAction: (props: { issue: unknown; open?: boolean; anchor?: unknown }) => {
    assignSpy(props);
    return props.anchor ? null : <button disabled={!props.issue}>Assign</button>;
  },
}));

function fixtureGraph() {
  return makeGraph(
    [
      makeNode("one", { projectId: "p1" }),
      makeNode("a", { parentIssueId: "one", projectId: "p1", stage: 1 }),
      makeNode("b", { parentIssueId: "one", projectId: "p2", stage: 2 }),
      makeNode("two"),
      makeNode("c", { parentIssueId: "two", stage: 1 }),
      makeNode("d", { parentIssueId: "two", stage: 2 }),
    ],
    [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
    ],
  );
}

function harness(
  graph: IssueGraph,
  overrides: Partial<DagToolbarProps> = {},
  seed?: (store: StoreApi<IssueViewState>) => void,
) {
  const store = createStore<IssueViewState>()(viewStoreSlice);
  seed?.(store);
  const props: DagToolbarProps = {
    graph,
    pending: false,
    layoutPendingLong: false,
    cancelPendingLayout: vi.fn(),
    expandAll: vi.fn(),
    collapseAll: vi.fn(),
    expandAllDisabled: false,
    collapseAllDisabled: false,
    onOpenIssue: vi.fn(),
    onRevealIssues: vi.fn(),
    onFocusGroup: vi.fn(),
    onToggleCollapsed: vi.fn(),
    projection: null!,
    ...overrides,
  };
  function Harness() {
    const fold = useDagFoldState(graph);
    if (!fold.projection) return null;
    return <DagToolbar {...props} projection={fold.projection} />;
  }
  const view = renderWithI18n(
    <ViewStoreProvider store={store}>
      <Harness />
    </ViewStoreProvider>,
  );
  return { store, props, view };
}

beforeEach(() => {
  issueSelection.current = {
    issue: null,
    actions: { openEditDependencies: vi.fn(), updateField: vi.fn() },
    detailFailed: false,
    retryDetail: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DagToolbar idle zone", () => {
  it("shows visible stats and the selection hint", () => {
    harness(fixtureGraph());
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("6 issues");
    expect(region).toHaveTextContent("4 dependencies");
    expect(region).toHaveTextContent("Select a task or dependency to see its actions");
  });

  it("excludes tasks hidden by the completed filter from the stats", () => {
    const graph = makeGraph(
      [
        makeNode("done-line", { status: "done", statusCategory: "done" }),
        makeNode("done-child", {
          parentIssueId: "done-line",
          status: "done",
          statusCategory: "done",
        }),
        makeNode("live"),
        makeNode("live-child", { parentIssueId: "live" }),
      ],
      [["live", "done-child"]],
    );
    harness(graph);
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("2 issues");
    expect(region).toHaveTextContent("0 dependencies");
  });

  it("keeps the right-hand view controls with the completed toggle badge", () => {
    const graph = makeGraph([
      makeNode("done-line", { status: "done", statusCategory: "done" }),
      makeNode("done-child", {
        parentIssueId: "done-line",
        status: "done",
        statusCategory: "done",
      }),
      makeNode("live"),
      makeNode("solo-done", { status: "done", statusCategory: "done" }),
    ]);
    const { store } = harness(graph);
    const toggle = screen.getByRole("button", { name: /^Show completed/ });
    expect(toggle).toHaveTextContent("3");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(store.getState().dagShowCompleted).toBe(true);
  });

  it("renders the restricted-context warning as a permanent icon", () => {
    const graph = { ...fixtureGraph(), hasRestrictedContext: true };
    harness(graph);
    expect(
      screen.getByRole("img", { name: /hidden by permissions/i }),
    ).toBeInTheDocument();
  });

  it("collects the legend copy into the info popover", async () => {
    harness(fixtureGraph());
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    expect(await screen.findByText("Bands show stages")).toBeInTheDocument();
    expect(screen.getByText("Issue arrows show dependencies")).toBeInTheDocument();
  });
});

describe("DagToolbar node selection", () => {
  it("shows the label, the five standing actions in order, more menu and clear", async () => {
    const { store, props } = harness(fixtureGraph(), {}, (s) => s.getState().setDagExpandedIds(["issue:one", "issue:two"]));
    act(() => store.getState().setDagSelectedNodeId("a"));
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("T-A");
    expect(region).toHaveTextContent("Task a");
    const labels = within(region)
      .getAllByRole("button")
      .map((b) => b.textContent);
    const order = [
      "Open detail",
      "Highlight prerequisites",
      "Highlight dependents",
      "Edit prerequisites",
      "Assign",
      "More",
    ];
    let at = -1;
    for (const label of order) {
      const index = labels.findIndex((text, i) => i > at && text?.includes(label));
      expect(index, label).toBeGreaterThan(at);
      at = index;
    }
    fireEvent.click(within(region).getByRole("button", { name: "Open detail" }));
    expect(props.onOpenIssue).toHaveBeenCalledWith("a");
    // Issue-bound actions stay disabled until the detail subscription lands.
    expect(within(region).getByRole("button", { name: "Edit prerequisites" })).toBeDisabled();
    expect(within(region).getByRole("button", { name: "Assign" })).toBeDisabled();
    fireEvent.click(within(region).getByRole("button", { name: "Clear selection" }));
    expect(store.getState().dagSelectedNodeId).toBeNull();
    expect(region).toHaveTextContent("Select a task or dependency to see its actions");
  });

  it("wires edit prerequisites once the issue detail is available", () => {
    issueSelection.current.issue = { id: "a", assignee_type: null, assignee_id: null };
    const { store } = harness(fixtureGraph(), {}, (s) => s.getState().setDagExpandedIds(["issue:one", "issue:two"]));
    act(() => store.getState().setDagSelectedNodeId("a"));
    const edit = screen.getByRole("button", { name: "Edit prerequisites" });
    expect(edit).toBeEnabled();
    fireEvent.click(edit);
    expect(issueSelection.current.actions.openEditDependencies).toHaveBeenCalledOnce();
  });

  it("toggles the focus buttons as pressed states", () => {
    const { store } = harness(fixtureGraph(), {}, (s) => s.getState().setDagExpandedIds(["issue:one", "issue:two"]));
    act(() => store.getState().setDagSelectedNodeId("b"));
    const upstream = screen.getByRole("button", { name: "Highlight prerequisites" });
    expect(upstream).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(upstream);
    expect(store.getState().dagFocus).toEqual({ nodeId: "b", way: "upstream" });
    expect(
      screen.getByRole("button", { name: "Highlight prerequisites" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Highlight dependents" }));
    expect(store.getState().dagFocus).toEqual({ nodeId: "b", way: "downstream" });
    fireEvent.click(screen.getByRole("button", { name: "Highlight dependents" }));
    expect(store.getState().dagFocus).toBeNull();
  });

  it("points out hidden tasks on the focused chain with a shortcut to show them", () => {
    const graph = makeGraph(
      [
        makeNode("a", { status: "done", statusCategory: "done" }),
        makeNode("b"),
      ],
      [["a", "b"]],
    );
    const { store } = harness(graph);
    act(() => store.getState().setDagSelectedNodeId("b"));
    act(() => store.getState().setDagFocus({ nodeId: "b", way: "upstream" }));
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("1 more hidden task on this chain");
    fireEvent.click(
      within(region).getByRole("button", { name: /Show completed/ }),
    );
    expect(store.getState().dagShowCompleted).toBe(true);
  });

  it("hides the hint once completed tasks are shown", () => {
    const graph = makeGraph(
      [
        makeNode("a", { status: "done", statusCategory: "done" }),
        makeNode("b"),
      ],
      [["a", "b"]],
    );
    const { store } = harness(graph, {}, (s) => s.getState().toggleDagShowCompleted());
    act(() => store.getState().setDagSelectedNodeId("b"));
    act(() => store.getState().setDagFocus({ nodeId: "b", way: "upstream" }));
    expect(
      screen.getByRole("region", { name: "Selection" }),
    ).not.toHaveTextContent(/hidden task/);
  });

  it("offers line focus and fold for a task-line header from the more menu", async () => {
    const { store, props } = harness(fixtureGraph());
    act(() => store.getState().setDagSelectedNodeId("issue:one"));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const focusItem = await screen.findByRole("menuitem", { name: "Focus issue group" });
    fireEvent.click(focusItem);
    expect(props.onFocusGroup).toHaveBeenCalledWith("issue:one");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Expand this group" }));
    expect(props.onToggleCollapsed).toHaveBeenCalledWith("issue:one");
  });

  it("offers folding the containing line for a plain task", async () => {
    const { store, props } = harness(fixtureGraph(), {}, (s) => s.getState().setDagExpandedIds(["issue:one", "issue:two"]));
    act(() => store.getState().setDagSelectedNodeId("a"));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse this group" }));
    expect(props.onToggleCollapsed).toHaveBeenCalledWith("issue:one");
  });
});

describe("DagToolbar edge selection", () => {
  it("shows a direct dependency with locate and clear", () => {
    const { store, props } = harness(fixtureGraph(), {}, (s) => s.getState().setDagExpandedIds(["issue:one", "issue:two"]));
    act(() => store.getState().setDagSelectedEdgeId("a→b"));
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("Dependency T-A Task a → T-B Task b");
    fireEvent.click(within(region).getByRole("button", { name: "Locate" }));
    expect(props.onRevealIssues).toHaveBeenCalledWith(["a", "b"]);
    fireEvent.click(within(region).getByRole("button", { name: "Clear selection" }));
    expect(store.getState().dagSelectedEdgeId).toBeNull();
    expect(region).toHaveTextContent("Select a task or dependency to see its actions");
  });

  it("opens the aggregate summary listing the original pairs", async () => {
    const { store, props } = harness(fixtureGraph(), {}, (s) =>
      s.getState().setDagExpandedIds([]),
    );
    act(() => store.getState().setDagSelectedEdgeId("issue:one→issue:two"));
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("Dependency T-ONE Task one → T-TWO Task two");
    fireEvent.click(
      within(region).getByRole("button", { name: /Summary of 2 dependencies/ }),
    );
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("T-A · Task a");
    expect(rows[0]).toHaveTextContent("T-C · Task c");
    expect(rows[1]).toHaveTextContent("T-B · Task b");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Locate" }));
    expect(props.onRevealIssues).toHaveBeenCalledWith(["b", "c"]);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "T-A · Task a" }));
    expect(props.onOpenIssue).toHaveBeenCalledWith("a");
  });
});

describe("DagToolbar overflow", () => {
  /** Widths answered by attribute: the capacity hook measures intrinsic
   *  content widths (offsetWidth / the label's scrollWidth) against the
   *  zone's clientWidth. Elements mounted later (the focus hint) get sizes
   *  too, which per-element stubbing cannot provide. */
  function stubMetrics() {
    const sizes = { zone: 1000, labelRender: 200, labelFull: 200, action: 90, fixed: 60 };
    const widthOf = (el: HTMLElement) => {
      if (el.hasAttribute("data-dag-zone")) return sizes.zone;
      if (el.hasAttribute("data-dag-label")) return sizes.labelRender;
      if (el.hasAttribute("data-dag-action")) return sizes.action;
      if (el.hasAttribute("data-dag-fixed")) return sizes.fixed;
      return 0;
    };
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return widthOf(this);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return widthOf(this);
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-dag-label") ? sizes.labelFull : widthOf(this);
      },
    );
    // Base UI overlays observe too, so key the stub by the observed element.
    const roByElement = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(el: Element) {
          roByElement.set(el, this.callback);
        }
        unobserve(el: Element) {
          roByElement.delete(el);
        }
        disconnect() {}
      },
    );
    const zone = () => document.querySelector("[data-dag-zone]") as HTMLElement;
    const fire = () => act(() => roByElement.get(zone())?.([], {} as ResizeObserver));
    const actionIds = () =>
      [...zone().querySelectorAll("[data-dag-action]")].map((el) =>
        el.getAttribute("data-dag-action"),
      );
    return { sizes, zone, fire, actionIds };
  }

  // With action=90, fixed=60 (More + ✕) and a 200px label (96 reserved):
  // base usage is 120 + 96 + 7 gaps·4 = 244, then +90 per action.
  it("collapses rightmost actions into More on narrow widths and restores them with room", () => {
    const m = stubMetrics();
    const { store } = harness(fixtureGraph(), {}, (s) =>
      s.getState().setDagExpandedIds(["issue:one", "issue:two"]),
    );
    act(() => store.getState().setDagSelectedNodeId("a"));
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
    m.sizes.zone = 500;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream"]);
    m.sizes.zone = 1920;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
  });

  it("reserves the label's full width before collapsing any action", () => {
    const m = stubMetrics();
    // The full label needs 200px while the rendered one reads 40 — the
    // reservation must follow the full width, never the squeezed render.
    m.sizes.labelRender = 40;
    const { store } = harness(fixtureGraph(), {}, (s) =>
      s.getState().setDagExpandedIds(["issue:one", "issue:two"]),
    );
    act(() => store.getState().setDagSelectedNodeId("a"));
    m.sizes.zone = 714;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
    m.sizes.zone = 690;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit"]);
    // A short label reserves only its real width: 40 < 96, so all five fit
    // at fixed 120 + 40 + gaps 28 + 450 = 638.
    act(() => store.getState().setDagSelectedNodeId(null));
    m.sizes.labelFull = 40;
    m.sizes.labelRender = 40;
    act(() => store.getState().setDagSelectedNodeId("a"));
    m.sizes.zone = 638;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
  });

  it("collapses when the hidden-chain hint appears and restores when it clears", () => {
    const m = stubMetrics();
    const graph = makeGraph(
      [
        makeNode("one"),
        makeNode("a", { parentIssueId: "one" }),
        makeNode("h", { status: "done", statusCategory: "done" }),
      ],
      [["h", "a"]],
    );
    const { store } = harness(graph, {}, (s) => s.getState().setDagExpandedIds(["issue:one"]));
    act(() => store.getState().setDagSelectedNodeId("a"));
    // Zone 750: 5 actions fit (694 used); the hint adds 64 → only 4 fit.
    m.sizes.zone = 750;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
    act(() => store.getState().setDagFocus({ nodeId: "a", way: "upstream" }));
    expect(screen.getByRole("region", { name: "Selection" })).toHaveTextContent(
      "1 more hidden task on this chain",
    );
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit"]);
    act(() => store.getState().setDagFocus(null));
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
  });

  it("does not restore while the slack stays below the hysteresis", () => {
    const m = stubMetrics();
    const { store } = harness(fixtureGraph(), {}, (s) =>
      s.getState().setDagExpandedIds(["issue:one", "issue:two"]),
    );
    act(() => store.getState().setDagSelectedNodeId("a"));
    m.sizes.zone = 500;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream"]);
    // A third action would fit (514 ≤ 520), but only by 6px of slack.
    m.sizes.zone = 520;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream"]);
    // Once the slack clears the hysteresis, the action comes back.
    m.sizes.zone = 580;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream"]);
  });

  it("refits from the full action set after the selection changes", () => {
    const m = stubMetrics();
    const graph = makeGraph([
      makeNode("one"),
      makeNode("a", { parentIssueId: "one" }),
      makeNode("solo"),
    ]);
    const { store } = harness(graph, {}, (s) => s.getState().setDagExpandedIds(["issue:one"]));
    // The independent group has two actions; both fit at 700.
    m.sizes.zone = 700;
    act(() => store.getState().setDagSelectedNodeId("independent:root"));
    m.fire();
    expect(m.actionIds()).toEqual(["upstream", "downstream"]);
    // Selecting a task must not inherit the smaller visible count.
    act(() => store.getState().setDagSelectedNodeId("a"));
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
  });

  it("opens the assign picker controlled from the overflowed menu entry", async () => {
    const m = stubMetrics();
    issueSelection.current.issue = { id: "a", assignee_type: null, assignee_id: null };
    const { store } = harness(fixtureGraph(), {}, (s) =>
      s.getState().setDagExpandedIds(["issue:one", "issue:two"]),
    );
    act(() => store.getState().setDagSelectedNodeId("a"));
    m.sizes.zone = 500;
    m.fire();
    expect(m.actionIds()).not.toContain("assign");
    assignSpy.mockClear();
    fireEvent.click(within(m.zone()).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Assign" }));
    expect(assignSpy.mock.calls.at(-1)![0]).toMatchObject({ open: true });
  });
});
