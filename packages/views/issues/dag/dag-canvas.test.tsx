// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ReactFlowProvider, useReactFlow, useStoreApi } from "@xyflow/react";
import { createStore } from "zustand/vanilla";
import {
  viewStoreSlice,
  type IssueViewState,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { renderWithI18n } from "../../test/i18n";
import { DagCanvasInner, type DagCanvasApi, type DagCanvasProps } from "./dag-canvas";
import { DagPortUpdateProvider } from "./dag-ports";
import { canvasFixture } from "./dag-test-fixtures";

// Only provide the geometry APIs missing in jsdom. React Flow, its provider,
// store, selection events, renderer and pan/zoom implementation are all real.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.style.width.endsWith("px")
        ? parseFloat(this.style.width)
        : 1400;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.style.height.endsWith("px")
        ? parseFloat(this.style.height)
        : 900;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        parseFloat(this.style.left) || 0,
        parseFloat(this.style.top) || 0,
        this.offsetWidth,
        this.offsetHeight,
      );
    },
  );
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22: number;
      constructor(transform: string) {
        this.m22 = Number(/scale\(([^)]+)\)/.exec(transform)?.[1] ?? 1);
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private active = new Set<Element>();
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.active.add(target);
        queueMicrotask(() => {
          if (this.active.has(target))
            this.callback(
              [
                {
                  target,
                  contentRect: target.getBoundingClientRect(),
                } as ResizeObserverEntry,
              ],
              this as unknown as ResizeObserver,
            );
        });
      }
      unobserve(target: Element) {
        this.active.delete(target);
      }
      disconnect() {
        this.active.clear();
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function harness(initial = canvasFixture()) {
  const store = createStore<IssueViewState>()(viewStoreSlice);
  let flow!: ReturnType<typeof useReactFlow>;
  let flowStore!: ReturnType<typeof useStoreApi>;
  function Probe() {
    const api = useReactFlow(),
      apiStore = useStoreApi();
    useLayoutEffect(() => {
      flow = api;
      flowStore = apiStore;
    });
    return null;
  }
  const callbacks = {
    onOpenIssue: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onRevealIssues: vi.fn(),
    onFocusGroup: vi.fn(),
    statusColorOf: () => null,
  };
  const surface = (data: Partial<DagCanvasProps> = {}) => (
    <ViewStoreProvider store={store}>
      <ReactFlowProvider initialWidth={1400} initialHeight={900}>
        <DagPortUpdateProvider>
          <DagCanvasInner
            {...initial}
            {...callbacks}
            focusRequest={null}
            {...data}
          />
          <Probe />
        </DagPortUpdateProvider>
      </ReactFlowProvider>
    </ViewStoreProvider>
  );
  return {
    store,
    callbacks,
    surface,
    mount: (data: Partial<DagCanvasProps> = {}) => renderWithI18n(surface(data)),
    ready: () => waitFor(() => expect(flow.viewportInitialized).toBe(true)),
    // Simulate navigation during a pan before its debounced move-end has saved
    // the viewport. Otherwise onMoveEnd masks removal of openIssue's save.
    panInFlight: () =>
      act(() => flowStore.setState({ transform: [-47, 93, 1.35] })),
  };
}

const viewportTransform = () =>
  document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
const nodeElement = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
function headerScreenPoint(id: string) {
  const viewport = /translate\(([^p]+)px,([^p]+)px\) scale\(([^)]+)\)/.exec(
    viewportTransform(),
  )!;
  const node = /translate\(([^p]+)px,([^p]+)px\)/.exec(
    nodeElement(id).style.transform,
  )!;
  return {
    x: Number(viewport[1]) + Number(node[1]) * Number(viewport[3]),
    y: Number(viewport[2]) + Number(node[2]) * Number(viewport[3]),
  };
}

describe("DAG canvas viewport", () => {
  it("registers the canvas api on mount and clears it on unmount", async () => {
    const h = harness();
    const registered: (DagCanvasApi | null)[] = [];
    const view = h.mount({ registerCanvasApi: (api) => registered.push(api) });
    await h.ready();
    expect(registered.at(-1)).toMatchObject({
      getViewport: expect.any(Function),
      toggleLine: expect.any(Function),
    });
    view.unmount();
    expect(registered.at(-1)).toBeNull();
  });

  it("keeps the header anchored when folded through the registered api", async () => {
    const h = harness();
    let api: DagCanvasApi | null = null;
    const registerCanvasApi = (next: DagCanvasApi | null) => {
      api = next;
    };
    h.store.getState().setDagViewport({ x: 60, y: 45, zoom: 1.25 });
    const view = h.mount({ registerCanvasApi });
    await h.ready();
    const before = headerScreenPoint("issue:one");
    act(() => api!.toggleLine("issue:one"));
    expect(h.callbacks.onToggleCollapsed).toHaveBeenCalledWith("issue:one");
    const next = canvasFixture(["issue:one"], "LR");
    // A relayout moves the anchor, exactly like the header-button path.
    const position = { x: 275, y: 55 };
    next.positions.set("issue:one", position);
    next.geometry.positions["issue:one"] = position;
    Object.assign(next.geometry.groups["issue:one"]!, position);
    view.rerender(h.surface({ ...next, registerCanvasApi }));
    await waitFor(() => {
      expect(headerScreenPoint("issue:one").x).toBeCloseTo(before.x);
      expect(headerScreenPoint("issue:one").y).toBeCloseTo(before.y);
    });
    expect(viewportTransform()).toContain("scale(1.25)");
    expect(
      nodeElement("issue:one").querySelector("[data-collapsed]"),
    ).toHaveAttribute("data-collapsed", "true");
  });

  it("saves the settled viewport after zooming without opening an issue", async () => {
    const h = harness();
    h.mount();
    await h.ready();
    fireEvent.click(screen.getByRole("button", { name: "Zoom Out" }));
    await waitFor(() => expect(h.store.getState().dagViewport?.zoom).toBeCloseTo(1 / 1.2));
    const saved = h.store.getState().dagViewport!;
    expect(viewportTransform()).toBe(`translate(${saved.x}px,${saved.y}px) scale(${saved.zoom})`);
    expect(h.callbacks.onOpenIssue).not.toHaveBeenCalled();
  });

  it.each(["double-click", "parent detail"])(
    "restores a non-default transform after %s, unmount and remount",
    async (action) => {
      const h = harness();
      const view = h.mount();
      await h.ready();
      h.panInFlight();
      const before = viewportTransform();
      expect(before).toBe("translate(-47px,93px) scale(1.35)");
      expect(h.store.getState().dagViewport).not.toEqual({
        x: -47,
        y: 93,
        zoom: 1.35,
      });
      if (action === "double-click") fireEvent.doubleClick(nodeElement("a"));
      else
        fireEvent.click(
          within(nodeElement("issue:one")).getByRole("button", {
            name: "Parent issue details",
          }),
        );
      expect(h.callbacks.onOpenIssue).toHaveBeenCalledWith(
        action === "parent detail" ? "one" : "a",
      );
      expect(h.store.getState().dagViewport).toEqual({
        x: -47,
        y: 93,
        zoom: 1.35,
      });
      view.unmount();
      h.mount();
      await h.ready();
      await waitFor(() => expect(viewportTransform()).toBe(before));
    },
  );

  it.each([
    ["LR", false],
    ["LR", true],
    ["TB", false],
    ["TB", true],
  ] as const)(
    "keeps the toggled header at the same screen point (%s, initially collapsed=%s)",
    async (direction, collapsed) => {
      const initial = canvasFixture(collapsed ? ["issue:one"] : [], direction);
      const h = harness(initial);
      h.store.getState().setDagViewport({ x: 60, y: 45, zoom: 1.25 });
      const view = h.mount();
      await h.ready();
      const before = headerScreenPoint("issue:one");
      fireEvent.click(
        within(nodeElement("issue:one")).getByRole("button", {
          name: "T-ONE Task one",
        }),
      );
      expect(h.callbacks.onToggleCollapsed).toHaveBeenCalledWith("issue:one");
      const next = canvasFixture(collapsed ? [] : ["issue:one"], direction);
      // A relayout moves the anchor in opposite directions on the two axes.
      const position = { x: 275, y: 55 };
      next.positions.set("issue:one", position);
      next.geometry.positions["issue:one"] = position;
      Object.assign(next.geometry.groups["issue:one"]!, position);
      view.rerender(h.surface(next));
      await waitFor(() => {
        expect(headerScreenPoint("issue:one").x).toBeCloseTo(before.x);
        expect(headerScreenPoint("issue:one").y).toBeCloseTo(before.y);
      });
      expect(viewportTransform()).toContain("scale(1.25)");
      expect(
        nodeElement("issue:one").querySelector("[data-collapsed]"),
      ).toHaveAttribute("data-collapsed", String(!collapsed));
    },
  );
});

describe("DAG canvas interactions", () => {
  it.each([
    { side: "source", folded: "issue:one", source: "issue:one", target: "c" },
    { side: "target", folded: "issue:two", source: "a", target: "issue:two" },
  ])(
    "selects an aggregate edge with only the $side folded",
    async ({ folded, source, target }) => {
      const fixture = canvasFixture([folded]);
      const model = fixture.projection.edges.find((e) => e.source === source && e.target === target)!;
      model.sourceEdgeIds = ["a-c"];
      model.sources = [{ edgeId: "a-c", source: "a", target: "c" }];
      const h = harness(fixture);
      h.mount();
      await h.ready();
      const edge = await screen.findByTestId(`rf__edge-${model.id}`);
      expect(edge.querySelector(".react-flow__edge-path")).toHaveStyle({ strokeDasharray: "6 3" });
      expect(screen.queryByRole("button", { name: "1 dependency" })).toBeNull();
      fireEvent.click(edge);
      expect(h.store.getState().dagSelectedEdgeId).toBe(model.id);
      expect(h.store.getState().dagSelectedNodeId).toBeNull();
    },
  );

  it("switches between direct selection and explicit prerequisite/dependent neighborhoods", async () => {
    const h = harness();
    h.mount();
    await h.ready();
    await waitFor(() =>
      expect(document.querySelectorAll(".react-flow__edge-path")).toHaveLength(
        4,
      ),
    );
    const highlighted = () =>
      [...document.querySelectorAll(".react-flow__edge-path.stroke-brand")]
        .map((path) =>
          path.closest(".react-flow__edge")!.getAttribute("data-id"),
        )
        .sort();
    fireEvent.click(nodeElement("b"));
    await waitFor(() => expect(highlighted()).toEqual(["a→b", "b→c"]));
    act(() =>
      h.store.getState().setDagFocus({ nodeId: "b", way: "upstream" }),
    );
    await waitFor(() => expect(highlighted()).toEqual(["a→b"]));
    act(() =>
      h.store.getState().setDagFocus({ nodeId: "b", way: "downstream" }),
    );
    await waitFor(() => expect(highlighted()).toEqual(["b→c", "c→d"]));
    act(() => h.store.getState().setDagFocus(null));
    await waitFor(() => expect(highlighted()).toEqual(["a→b", "b→c"]));
  });

  it("selects a direct dependency edge over the node and clears it with Escape", async () => {
    const h = harness();
    h.mount();
    await h.ready();
    fireEvent.click(nodeElement("b"));
    // Selection remeasures nodes; wait for React Flow to recreate their edges.
    const edge = await screen.findByTestId("rf__edge-a→b");
    fireEvent.click(edge);
    expect(h.store.getState().dagSelectedNodeId).toBeNull();
    expect(h.store.getState().dagSelectedEdgeId).toBe("a→b");
    fireEvent.keyDown(await screen.findByTestId("rf__edge-a→b"), { key: "Escape" });
    expect(h.store.getState().dagSelectedEdgeId).toBeNull();
  });

  it("renders unknown/restricted dependencies, queued/running badges and context cards", async () => {
    const fixture = canvasFixture();
    const b = fixture.projection.nodes.find((node) => node.id === "b")!;
    b.role = "context";
    b.runState = "queued";
    b.issue!.dependencySummary = {
      visibleUnsatisfiedCount: 2,
      hasRestrictedBlockers: true,
      dependencyVersion: "b",
    };
    const c = fixture.projection.nodes.find((node) => node.id === "c")!;
    c.runState = "running";
    c.issue!.dependencySummary = null;
    const h = harness(fixture);
    h.mount();
    await h.ready();
    expect(within(nodeElement("b")).getByText("Context")).toBeInTheDocument();
    expect(within(nodeElement("b")).getByTitle("Queued")).toBeInTheDocument();
    expect(
      within(nodeElement("b")).getByTitle(
        "Includes prerequisites you can't see",
      ),
    ).toHaveTextContent("2");
    expect(within(nodeElement("c")).getByTitle("Running")).toBeInTheDocument();
    expect(within(nodeElement("c")).getByTitle(/unknown/i)).toBeInTheDocument();
    expect(
      within(nodeElement("a")).queryByTitle(
        /unknown|restricted|Running|Queued/i,
      ),
    ).toBeNull();
    expect(within(nodeElement("a")).queryByText(/open prerequisite/)).toBeNull();
  });

  it("selects direct dependencies and the containing stage while unrelated cards remain readable", async () => {
    const h = harness();
    h.mount();
    await h.ready();
    await waitFor(() =>
      expect(document.querySelectorAll(".react-flow__edge-path")).toHaveLength(
        4,
      ),
    );
    fireEvent.click(nodeElement("b"));
    expect(h.store.getState().dagSelectedNodeId).toBe("b");
    await waitFor(() => expect(
      document.querySelectorAll(".react-flow__edge-path.stroke-brand"),
    ).toHaveLength(2));
    expect(
      nodeElement("issue:one").querySelector('[data-dag-stage="2"]'),
    ).toHaveAttribute("data-active", "true");
    expect(
      nodeElement("issue:one").querySelector('[data-dag-stage="1"]'),
    ).toHaveAttribute("data-active", "false");
    expect(within(nodeElement("d")).getByText("Task d")).toBeVisible();
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    expect(h.store.getState().dagSelectedNodeId).toBeNull();
    expect(
      document.querySelectorAll(".react-flow__edge-path.stroke-brand"),
    ).toHaveLength(0);
    expect(
      nodeElement("issue:one").querySelector('[data-active="true"]'),
    ).toBeNull();
  });

  it("selects an aggregate edge from its count button", async () => {
    const h = harness(canvasFixture(["issue:one", "issue:two"]));
    h.mount();
    await h.ready();
    fireEvent.click(
      await screen.findByRole("button", { name: "2 dependencies" }),
    );
    expect(h.store.getState().dagSelectedEdgeId).toBe("issue:one→issue:two");
    expect(h.store.getState().dagSelectedNodeId).toBeNull();
  });

  it.each(["LR", "TB"] as const)(
    "renders stage bands in %s and explains a dependency/stage conflict",
    async (direction) => {
      const fixture = canvasFixture([], direction);
      fixture.geometry.groups["issue:one"]!.stageConflict = true;
      const h = harness(fixture);
      const view = h.mount();
      await h.ready();
      const group = nodeElement("issue:one");
      expect(within(group).getByTitle(/conflict/i)).toBeInTheDocument();
      const bands = group.querySelectorAll<HTMLElement>("[data-dag-stage]");
      expect([...bands].map((band) => band.textContent)).toEqual([
        "Stage 1",
        "Stage 2",
      ]);
      expect(bands[1]).toHaveStyle(
        direction === "LR"
          ? { left: "260px", width: "280px" }
          : { top: "204px", height: "160px" },
      );
      view.rerender(h.surface(canvasFixture(["issue:one"], direction)));
      expect(group.querySelectorAll("[data-dag-stage]")).toHaveLength(0);
      expect(within(group).queryByTitle(/conflict/i)).toBeNull();
    },
  );

  it("wires focus-group from the group header, then positions the explicit request", async () => {
    const h = harness();
    const view = h.mount();
    await h.ready();
    fireEvent.click(
      within(nodeElement("issue:one")).getByRole("button", {
        name: "Focus issue group",
      }),
    );
    expect(h.callbacks.onFocusGroup).toHaveBeenCalledWith("issue:one");
    view.rerender(
      h.surface({
        focusRequest: { groupId: "issue:two", issueIds: [], nonce: 1 },
      }),
    );
    await waitFor(() =>
      expect(headerScreenPoint("issue:two")).toEqual({ x: 24, y: 24 }),
    );
    expect(h.store.getState().dagSelectedNodeId).toBe("issue:two");
  });

  it("focuses an issue through its folded representative without expanding the group", async () => {
    const h = harness(canvasFixture(["issue:one"]));
    const view = h.mount();
    await h.ready();
    expect(nodeElement("b")).toBeNull();
    view.rerender(h.surface({ focusRequest: { issueIds: ["b"], nonce: 1 } }));
    await waitFor(() => expect(headerScreenPoint("issue:one")).toEqual({ x: 24, y: 24 }));
    expect(h.store.getState().dagSelectedNodeId).toBe("issue:one");
    expect(nodeElement("issue:one").querySelector("[data-collapsed]"))
      .toHaveAttribute("data-collapsed", "true");
    expect(h.callbacks.onToggleCollapsed).not.toHaveBeenCalled();
  });
});
