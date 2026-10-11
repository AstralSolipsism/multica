// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("./dag-issue-actions", () => ({
  useDagIssueSelection: () => issueSelection.current,
  DagAssignAction: ({ issue }: { issue: unknown }) => (
    <button disabled={!issue}>Assign</button>
  ),
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
  it("collapses rightmost actions into the more menu when the zone overflows", async () => {
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
    const { store } = harness(fixtureGraph(), {}, (s) => s.getState().setDagExpandedIds(["issue:one", "issue:two"]));
    act(() => store.getState().setDagSelectedNodeId("a"));
    const zone = document.querySelector("[role='region'] > div") as HTMLElement;
    expect(zone).not.toBeNull();
    const metrics = { clientWidth: 100, scrollWidth: 600 };
    Object.defineProperty(zone, "clientWidth", { get: () => metrics.clientWidth });
    Object.defineProperty(zone, "scrollWidth", { get: () => metrics.scrollWidth });
    act(() => roByElement.get(zone)?.([], {} as ResizeObserver));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open detail" }),
      ).toBeNull(),
    );
    // Everything collapsed: the menu carries the standing actions now.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(
      await screen.findByRole("menuitem", { name: "Open detail" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Edit prerequisites" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Room returns step by step: actions move back into the bar.
    metrics.scrollWidth = 200;
    for (const width of [400, 600, 800, 1000, 1200]) {
      metrics.clientWidth = width;
      act(() => roByElement.get(zone)?.([], {} as ResizeObserver));
    }
    const region = screen.getByRole("region", { name: "Selection" });
    await waitFor(() =>
      expect(
        within(region).getByRole("button", { name: "Open detail" }),
      ).toBeInTheDocument(),
    );
  });
});
