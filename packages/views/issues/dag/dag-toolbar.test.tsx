// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  viewStoreSlice,
  type IssueViewState,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { renderWithI18n } from "../../test/i18n";
import { DagToolbar, type DagToolbarProps } from "./dag-toolbar";
import type { DagSelectionTarget } from "./dag-scene-flow";

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

const TASK: DagSelectionTarget = {
  kind: "task",
  id: "a",
  identifier: "T-A",
  title: "Task a",
  issueId: "a",
  enterLineId: null,
  focusFrameId: null,
};
const LINE_CARD: DagSelectionTarget = {
  kind: "line-card",
  id: "issue:one",
  identifier: "T-ONE",
  title: "Task one",
  issueId: "one",
  enterLineId: "one",
  focusFrameId: null,
};
const INDEPENDENT: DagSelectionTarget = {
  kind: "independent",
  id: "independent:root",
  identifier: null,
  title: null,
  issueId: null,
  enterLineId: "independent:root",
  focusFrameId: null,
};

function harness(
  overrides: Partial<DagToolbarProps> = {},
  seed?: (store: StoreApi<IssueViewState>) => void,
) {
  const store = createStore<IssueViewState>()(viewStoreSlice);
  seed?.(store);
  const props: DagToolbarProps = {
    level: { kind: "overview" },
    lineHeader: null,
    selection: null,
    stats: { matched: 6, context: 1, edges: 4 },
    hiddenCompleted: null,
    hasRestrictedContext: false,
    contextOnly: false,
    pending: false,
    pendingLong: false,
    onCancelLayout: vi.fn(),
    isFallback: false,
    onRetryLayout: vi.fn(),
    focusHiddenCount: 0,
    onOpenIssue: vi.fn(),
    onEnterLine: vi.fn(),
    onExitLine: vi.fn(),
    onFocusFrame: vi.fn(),
    ...overrides,
  };
  const view = renderWithI18n(
    <ViewStoreProvider store={store}>
      <DagToolbar {...props} />
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

describe("DagToolbar navigation", () => {
  it("shows the all-lines crumb without a back button on the overview", () => {
    harness();
    expect(screen.getByRole("navigation", { name: "Task line path" })).toHaveTextContent(
      "All task lines",
    );
    expect(screen.queryByRole("button", { name: "Back to overview" })).toBeNull();
  });

  it("shows the current line in the breadcrumb and returns via both controls", () => {
    const { props } = harness({
      level: { kind: "line", lineId: "one" },
      lineHeader: { identifier: "T-ONE", title: "Task one" },
    });
    const nav = screen.getByRole("navigation", { name: "Task line path" });
    expect(nav).toHaveTextContent("All task lines");
    expect(nav).toHaveTextContent("T-ONE");
    expect(nav).toHaveTextContent("Task one");
    fireEvent.click(screen.getByRole("button", { name: "Back to overview" }));
    expect(props.onExitLine).toHaveBeenCalledTimes(1);
    fireEvent.click(within(nav).getByRole("button", { name: "All task lines" }));
    expect(props.onExitLine).toHaveBeenCalledTimes(2);
  });

  it("announces a fallback layout and retries it", () => {
    const { props } = harness({ isFallback: true });
    fireEvent.click(screen.getByRole("button", { name: "Re-layout" }));
    expect(props.onRetryLayout).toHaveBeenCalledOnce();
  });

  it("keeps the satisfied-dependencies toggle beside the completed one", () => {
    const { store } = harness({
      hiddenCompleted: { lines: 2, lineTasks: 5, singles: 1 }, 
    });
    const satisfied = screen.getByRole("button", { name: "Show satisfied dependencies" });
    expect(satisfied).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(satisfied);
    expect(store.getState().dagShowSatisfiedDependencies).toBe(true);
    expect(satisfied).toHaveAttribute("aria-pressed", "true");
    const completed = screen.getByRole("button", { name: /^Show completed/ });
    expect(completed).toHaveTextContent("6");
    fireEvent.click(completed);
    expect(store.getState().dagShowCompleted).toBe(true);
  });

  it("collects the four edge states and the side cards into the legend", async () => {
    harness();
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    expect(await screen.findByText("Thin light-gray line: satisfied dependency")).toBeInTheDocument();
    expect(screen.getByText("Dark solid line: still blocking")).toBeInTheDocument();
    expect(screen.getByText("Dark solid line: prerequisite is advancing")).toBeInTheDocument();
    expect(screen.getByText("Red dashed line: cancelled but still blocking")).toBeInTheDocument();
    expect(
      screen.getByText("Dashed side cards: dependencies on other task lines — click to jump"),
    ).toBeInTheDocument();
  });
});

describe("DagToolbar idle zone", () => {
  it("shows visible stats and the selection hint", () => {
    harness();
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("6 issues");
    expect(region).toHaveTextContent("+1 context");
    expect(region).toHaveTextContent("4 dependencies");
    expect(region).toHaveTextContent("Select a task or task line to see its actions");
  });
});

describe("DagToolbar node selection", () => {
  it("orders the line-card actions with enter first", () => {
    const { props } = harness({ selection: LINE_CARD });
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("T-ONE");
    const labels = within(region).getAllByRole("button").map((b) => b.textContent);
    const order = [
      "Enter task line",
      "Open detail",
      "Highlight prerequisites",
      "Highlight dependents",
      "Edit prerequisites",
      "Assign",
    ];
    let at = -1;
    for (const label of order) {
      const index = labels.findIndex((text, i) => i > at && text?.includes(label));
      expect(index, label).toBeGreaterThan(at);
      at = index;
    }
    fireEvent.click(within(region).getByRole("button", { name: "Enter task line" }));
    expect(props.onEnterLine).toHaveBeenCalledWith("one");
    fireEvent.click(within(region).getByRole("button", { name: "Open detail" }));
    expect(props.onOpenIssue).toHaveBeenCalledWith("one");
  });

  it("shows the five task actions; the overflow menu has no fold entries", async () => {
    const m = stubMetrics();
    harness({ selection: TASK });
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("T-A");
    expect(within(region).queryByRole("button", { name: "Enter task line" })).toBeNull();
    // Collapse three actions into More, then check what the menu carries.
    m.sizes.zone = 500;
    m.fire();
    fireEvent.click(within(m.zone()).getByRole("button", { name: "More" }));
    await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Edit prerequisites" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /this group/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Focus issue group/ })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Highlight prerequisites" })).toBeNull();
  });

  it("offers enter plus the focus pair for the independent card", () => {
    harness({ selection: INDEPENDENT });
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("Independent issues");
    expect(within(region).getByRole("button", { name: "Enter task line" })).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Open detail" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "Assign" })).toBeNull();
  });

  it("toggles the focus buttons as pressed states", () => {
    const { store } = harness({ selection: TASK });
    const upstream = screen.getByRole("button", { name: "Highlight prerequisites" });
    expect(upstream).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(upstream);
    expect(store.getState().dagFocus).toEqual({ nodeId: "a", way: "upstream" });
    expect(
      screen.getByRole("button", { name: "Highlight prerequisites" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Highlight dependents" }));
    expect(store.getState().dagFocus).toEqual({ nodeId: "a", way: "downstream" });
    fireEvent.click(screen.getByRole("button", { name: "Highlight dependents" }));
    expect(store.getState().dagFocus).toBeNull();
  });

  it("points out hidden tasks on the focused chain with a shortcut to show them", () => {
    const { store } = harness({ selection: TASK, focusHiddenCount: 1 });
    const region = screen.getByRole("region", { name: "Selection" });
    expect(region).toHaveTextContent("1 more hidden task on this chain");
    fireEvent.click(within(region).getByRole("button", { name: /Show completed/ }));
    expect(store.getState().dagShowCompleted).toBe(true);
  });

  it("hides the hint once completed tasks are shown", () => {
    harness({ selection: TASK, focusHiddenCount: 2 }, (s) =>
      s.getState().toggleDagShowCompleted(),
    );
    expect(
      screen.getByRole("region", { name: "Selection" }),
    ).not.toHaveTextContent(/hidden task/);
  });

  it("offers focusing the containing sub-line frame from the menu", async () => {
    const m = stubMetrics();
    const withFrame: DagSelectionTarget = { ...TASK, focusFrameId: "sub-frame" };
    const { props } = harness({ selection: withFrame });
    m.sizes.zone = 500;
    m.fire();
    fireEvent.click(within(m.zone()).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Focus issue group" }));
    expect(props.onFocusFrame).toHaveBeenCalledWith("sub-frame");
  });

  it("clears the selection", () => {
    const { store } = harness({ selection: TASK }, (s) =>
      s.getState().setDagSelectedNodeId("a"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(store.getState().dagSelectedNodeId).toBeNull();
  });
});

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


describe("DagToolbar overflow", () => {
  // With action=90, fixed=60 (More + ✕) and a 200px label (96 reserved):
  // base usage is 120 + 96 + 7 gaps·4 = 244, then +90 per action.
  it("collapses rightmost actions into More on narrow widths and restores them with room", () => {
    const m = stubMetrics();
    harness({ selection: TASK });
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
    m.sizes.zone = 500;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream"]);
    m.sizes.zone = 1920;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
  });

  it("collapses when the hidden-chain hint appears and restores when it clears", () => {
    const m = stubMetrics();
    const store = createStore<IssueViewState>()(viewStoreSlice);
    const baseProps: DagToolbarProps = {
      level: { kind: "overview" },
      lineHeader: null,
      selection: TASK,
      stats: { matched: 3, context: 0, edges: 0 },
      hiddenCompleted: null,
      hasRestrictedContext: false,
      contextOnly: false,
      pending: false,
      pendingLong: false,
      onCancelLayout: vi.fn(),
      isFallback: false,
      onRetryLayout: vi.fn(),
      focusHiddenCount: 0,
      onOpenIssue: vi.fn(),
      onEnterLine: vi.fn(),
      onExitLine: vi.fn(),
      onFocusFrame: vi.fn(),
    };
    const { rerender } = renderWithI18n(
      <ViewStoreProvider store={store}>
        <DagToolbar {...baseProps} />
      </ViewStoreProvider>,
    );
    // Zone 680: five actions fit (630 used); the hint adds fixed width.
    m.sizes.zone = 680;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
    rerender(
      <ViewStoreProvider store={store}>
        <DagToolbar {...baseProps} focusHiddenCount={1} />
      </ViewStoreProvider>,
    );
    expect(screen.getByRole("region", { name: "Selection" })).toHaveTextContent(
      "1 more hidden task on this chain",
    );
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit"]);
    rerender(
      <ViewStoreProvider store={store}>
        <DagToolbar {...baseProps} focusHiddenCount={0} />
      </ViewStoreProvider>,
    );
    // The collapsed More trigger keeps the bar wider than the hysteresis, so
    // the same width holds — the action returns once real slack appears.
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit"]);
    m.sizes.zone = 740;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
  });

  it("does not restore while the slack stays below the hysteresis", () => {
    const m = stubMetrics();
    harness({ selection: TASK });
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
    const store = createStore<IssueViewState>()(viewStoreSlice);
    const props: DagToolbarProps = {
      level: { kind: "overview" },
      lineHeader: null,
      selection: INDEPENDENT,
      stats: { matched: 3, context: 0, edges: 0 },
      hiddenCompleted: null,
      hasRestrictedContext: false,
      contextOnly: false,
      pending: false,
      pendingLong: false,
      onCancelLayout: vi.fn(),
      isFallback: false,
      onRetryLayout: vi.fn(),
      focusHiddenCount: 0,
      onOpenIssue: vi.fn(),
      onEnterLine: vi.fn(),
      onExitLine: vi.fn(),
      onFocusFrame: vi.fn(),
    };
    const { rerender } = renderWithI18n(
      <ViewStoreProvider store={store}>
        <DagToolbar {...props} />
      </ViewStoreProvider>,
    );
    // The independent card has three actions; all fit at 700.
    m.sizes.zone = 700;
    m.fire();
    expect(m.actionIds()).toEqual(["enter", "upstream", "downstream"]);
    // Selecting a task must not inherit the smaller visible count.
    rerender(
      <ViewStoreProvider store={store}>
        <DagToolbar {...props} selection={TASK} />
      </ViewStoreProvider>,
    );
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit", "assign"]);
  });

  it("resets the visible count when switching to a node with the same action set", () => {
    const m = stubMetrics();
    const store = createStore<IssueViewState>()(viewStoreSlice);
    const props = {
      level: { kind: "line", lineId: "one" },
      lineHeader: null,
      stats: { matched: 3, context: 0, edges: 0 },
      hiddenCompleted: null,
      hasRestrictedContext: false,
      contextOnly: false,
      pending: false,
      pendingLong: false,
      onCancelLayout: vi.fn(),
      isFallback: false,
      onRetryLayout: vi.fn(),
      focusHiddenCount: 0,
      onOpenIssue: vi.fn(),
      onEnterLine: vi.fn(),
      onExitLine: vi.fn(),
      onFocusFrame: vi.fn(),
    } satisfies Partial<DagToolbarProps>;
    const taskB: DagSelectionTarget = { ...TASK, id: "b", identifier: "T-B", issueId: "b" };
    const { rerender } = renderWithI18n(
      <ViewStoreProvider store={store}>
        <DagToolbar {...props} selection={TASK} />
      </ViewStoreProvider>,
    );
    // Collapse to two actions, then widen just short of the restore
    // hysteresis: a third action fits (514 ≤ 520) but the slack stays
    // below 48px, so the count holds.
    m.sizes.zone = 500;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream"]);
    m.sizes.zone = 520;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream"]);
    // Switching to another task with the same five actions must reset the
    // count, so the refit puts back the action the hysteresis withheld.
    rerender(
      <ViewStoreProvider store={store}>
        <DagToolbar {...props} selection={taskB} />
      </ViewStoreProvider>,
    );
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream"]);
  });

  it("counts the detail-failure retry button toward the fixed width", () => {
    const m = stubMetrics();
    issueSelection.current.detailFailed = true;
    harness({ selection: TASK });
    const region = screen.getByRole("region", { name: "Selection" });
    expect(within(region).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The retry button adds 60px of fixed width: 120 fixed + 96 label + 28
    // gaps leaves room for four actions (664 ≤ 690) but not five (694 > 690).
    // Uncounted, all five would fit (634 ≤ 690) and More would not render.
    m.sizes.zone = 690;
    m.fire();
    expect(m.actionIds()).toEqual(["open", "upstream", "downstream", "edit"]);
  });

  it("opens the assign picker controlled from the overflowed menu entry", async () => {
    const m = stubMetrics();
    issueSelection.current.issue = { id: "a", assignee_type: null, assignee_id: null };
    harness({ selection: TASK });
    m.sizes.zone = 500;
    m.fire();
    expect(m.actionIds()).not.toContain("assign");
    assignSpy.mockClear();
    fireEvent.click(within(m.zone()).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Assign" }));
    expect(assignSpy.mock.calls.at(-1)![0]).toMatchObject({ open: true });
  });
});
