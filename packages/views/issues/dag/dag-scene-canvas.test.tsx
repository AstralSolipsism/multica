// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider, useReactFlow, useStoreApi } from "@xyflow/react";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import {
  viewStoreSlice,
  type IssueViewState,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { computeDagFocus, computeDagLine, computeDagOverview, createDagModelIndex } from "@multica/core/issues/dag";
import { renderWithI18n } from "../../test/i18n";
import { DagSceneCanvasInner, type DagSceneCanvasProps } from "./dag-scene-canvas";
import { dagFocusCanvasModel } from "./dag-scene-flow";
import { fallbackDagScene } from "./dag-scene-fallback";
import { dagCullBounds, dagCullBoundsKey } from "./dag-highlight";
import { dagLineLayoutInput, dagOverviewLayoutInput } from "./dag-scene-inputs";
import type { DagSceneGeometry } from "./dag-scene";
import { graphNode as makeNode, issueGraph as makeGraph } from "./dag-test-fixtures";

// Only provide the geometry APIs missing in jsdom. React Flow, its provider,
// store, selection events, renderer and pan/zoom implementation are all real.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.style.width.endsWith("px") ? parseFloat(this.style.width) : 1400;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.style.height.endsWith("px") ? parseFloat(this.style.height) : 900;
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
              [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
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

const BUNDLE = JSON.stringify(["issue:r1", "issue:r2"]);

function overviewFixture() {
  const graph = makeGraph(
    [
      makeNode("r1", { title: "Line one" }),
      makeNode("a1", { parentIssueId: "r1" }),
      makeNode("a2", { parentIssueId: "r1" }),
      makeNode("r2", { title: "Line two" }),
      makeNode("b1", { parentIssueId: "r2" }),
    ],
    [
      { id: "e-1", source: "a1", target: "b1" },
      { id: "e-2", source: "a2", target: "b1" },
    ],
  );
  const overview = computeDagOverview(createDagModelIndex(graph), {
    showCompleted: false,
    showSatisfiedDependencies: true,
  })!;
  const plan = dagOverviewLayoutInput(overview);
  const geometry: DagSceneGeometry = {
    nodes: {
      "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
      "issue:r2": { x: 500, y: 60, width: 280, height: 140 },
    },
    frames: {},
    ports: {
      "issue:r1": { input: { x: 0, y: 70 }, output: { x: 280, y: 70 } },
      "issue:r2": { input: { x: 500, y: 130 }, output: { x: 780, y: 130 } },
    },
    routes: { [BUNDLE]: [{ x: 280, y: 70 }, { x: 390, y: 70 }, { x: 390, y: 130 }, { x: 500, y: 130 }] },
    segments: [
      { id: "s0", start: { x: 280, y: 70 }, end: { x: 390, y: 70 }, edgeIds: [BUNDLE] },
      { id: "s1", start: { x: 390, y: 70 }, end: { x: 390, y: 130 }, edgeIds: [BUNDLE] },
      { id: "s2", start: { x: 390, y: 130 }, end: { x: 500, y: 130 }, edgeIds: [BUNDLE] },
    ],
    junctions: [],
    width: 780,
    height: 200,
    quality: "elk",
  };
  return { model: { kind: "overview" as const, overview }, plan, geometry };
}

function lineFixture() {
  const graph = makeGraph(
    [
      makeNode("r1", { title: "Line one" }),
      makeNode("t1", { parentIssueId: "r1", stage: 1 }),
      makeNode("sub", { parentIssueId: "r1", title: "Sub line" }),
      makeNode("s1", { parentIssueId: "sub", stage: 2 }),
      makeNode("r2", { title: "Line two" }),
      makeNode("u1", { parentIssueId: "r2" }),
    ],
    [{ id: "e-u1", source: "u1", target: "t1" }],
  );
  const line = computeDagLine(createDagModelIndex(graph), "r1")!;
  const plan = dagLineLayoutInput(line);
  const externalId = JSON.stringify(["external", "upstream", "r2"]);
  const geometry: DagSceneGeometry = {
    nodes: {
      t1: { x: 60, y: 150, width: 248, height: 116 },
      s1: { x: 380, y: 300, width: 248, height: 116 },
      [externalId]: { x: -220, y: 150, width: 184, height: 76 },
    },
    frames: {
      r1: { x: 0, y: 0, width: 760, height: 500, bands: [], stageMode: "labels" },
      sub: { x: 340, y: 220, width: 380, height: 240, bands: [], stageMode: "labels" },
    },
    ports: {
      t1: { input: { x: 60, y: 208 }, output: { x: 308, y: 208 } },
      s1: { input: { x: 380, y: 358 }, output: { x: 628, y: 358 } },
      [externalId]: { input: { x: -220, y: 188 }, output: { x: -36, y: 188 } },
    },
    routes: { "e-u1": [{ x: -36, y: 188 }, { x: 0, y: 188 }, { x: 0, y: 208 }, { x: 60, y: 208 }] },
    segments: [
      { id: "s0", start: { x: -36, y: 188 }, end: { x: 0, y: 188 }, edgeIds: ["e-u1"] },
      { id: "s1", start: { x: 0, y: 188 }, end: { x: 0, y: 208 }, edgeIds: ["e-u1"] },
      { id: "s2", start: { x: 0, y: 208 }, end: { x: 60, y: 208 }, edgeIds: ["e-u1"] },
    ],
    junctions: [],
    width: 760,
    height: 500,
    quality: "elk",
  };
  return { model: { kind: "line" as const, line }, plan, geometry };
}

function harness(
  fixture: { model: DagSceneCanvasProps["model"]; plan: DagSceneCanvasProps["plan"]; geometry: DagSceneGeometry },
  seed?: (store: StoreApi<IssueViewState>) => void,
) {
  const store = createStore<IssueViewState>()(viewStoreSlice);
  seed?.(store);
  const props: DagSceneCanvasProps = {
    level: fixture.model.kind === "overview" ? { kind: "overview" } : { kind: "line", lineId: "r1" },
    model: fixture.model,
    plan: fixture.plan,
    geometry: fixture.geometry,
    statusColorOf: () => null,
    projectNames: new Map(),
    showSatisfied: true,
    focusRequest: null,
    locateRequest: null,
    onEnterLine: vi.fn(),
    onOpenIssue: vi.fn(),
    onExternalJump: vi.fn(),
    registerCanvasApi: vi.fn(),
  };
  let flow!: ReturnType<typeof useReactFlow>;
  let flowStore!: ReturnType<typeof useStoreApi>;
  function Probe() {
    flow = useReactFlow();
    flowStore = useStoreApi();
    return null;
  }
  const view = renderWithI18n(
    <ViewStoreProvider store={store}>
      <ReactFlowProvider>
        <DagSceneCanvasInner {...props} />
        <Probe />
      </ReactFlowProvider>
    </ViewStoreProvider>,
  );
  return { store, props, flow: () => flow, flowStore: () => flowStore, ...view };
}

describe("DagSceneCanvas overview", () => {
  it("renders line cards and the bundled dependency with its count", async () => {
    harness(overviewFixture());
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    expect(screen.getByText("Line two")).toBeInTheDocument();
    const layer = document.querySelector("[data-dag-edge-layer]")!;
    // Three painted segments for the single bundle and its count badge.
    expect(
      [...layer.querySelectorAll("[data-dag-segments]")].flatMap((el) =>
        (el.getAttribute("data-dag-segments") ?? "").split(" ").filter(Boolean),
      ),
    ).toHaveLength(3);
    expect(layer.querySelector("text")).toHaveTextContent("2");
  });

  it("double-click enters a line; single click selects; pane clears", async () => {
    const { store, props } = harness(overviewFixture());
    const card = await screen.findByText("Line one");
    const node = card.closest(".react-flow__node")!;
    fireEvent.click(node);
    expect(store.getState().dagSelectedNodeId).toBe("issue:r1");
    fireEvent.doubleClick(node);
    expect(props.onEnterLine).toHaveBeenCalledWith("r1");
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    expect(store.getState().dagSelectedNodeId).toBeNull();
  });

  it("restores the remembered overview viewport", async () => {
    harness(overviewFixture(), (store) => {
      store.setState({ dagViewports: { overview: { x: 33, y: -44, zoom: 1.25 } } });
    });
    await waitFor(() => {
      const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
      expect(viewport.style.transform).toContain("scale(1.25)");
    });
    const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
    expect(viewport.style.transform).toContain("translate(33px,-44px)");
  });

  it("paints branch dots at junctions", async () => {
    const fixture = overviewFixture();
    fixture.geometry.junctions = [{ x: 390, y: 70, edgeIds: [BUNDLE] }];
    harness(fixture);
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    const layer = document.querySelector("[data-dag-edge-layer]")!;
    expect(layer.querySelectorAll("circle").length).toBe(1);
  });

  it("marks cancelled context cards with a dashed border", async () => {
    // A cancelled standalone still blocking a visible line keeps the dashed border.
    const cancelledGraph = makeGraph(
      [
        makeNode("r1"),
        makeNode("a1", { parentIssueId: "r1" }),
        makeNode("cancelled", { status: "cancelled", statusCategory: "closed" }),
      ],
      [{ id: "e-x", source: "cancelled", target: "a1" }],
    );
    const overview = computeDagOverview(createDagModelIndex(cancelledGraph), {
      showCompleted: false,
      showSatisfiedDependencies: true,
    })!;
    const cancelledCard = overview.cards.find((c) => c.cancelledBlocking)!;
    expect(cancelledCard).toBeTruthy();
    harness({
      model: { kind: "overview", overview },
      plan: dagOverviewLayoutInput(overview),
      geometry: {
        nodes: { [cancelledCard.id]: { x: 0, y: 0, width: 280, height: 140 } },
        frames: {},
        ports: {},
        routes: {},
        segments: [],
        junctions: [],
        width: 280,
        height: 140,
        quality: "elk",
      },
    });
    await waitFor(() =>
      expect(document.querySelector("[data-dag-overview-card].border-dashed")).toBeTruthy(),
    );
  });

  it("opens a standalone card's detail on double-click and shows its status icon", async () => {
    const graph = makeGraph(
      [
        makeNode("r1", { title: "Line one", status: "in_progress" }),
        makeNode("a1", { parentIssueId: "r1" }),
        makeNode("solo"),
      ],
      [{ id: "e-s", source: "solo", target: "a1" }],
    );
    const overview = computeDagOverview(createDagModelIndex(graph), {
      showCompleted: false,
      showSatisfiedDependencies: false,
    })!;
    const { props } = harness({
      model: { kind: "overview", overview },
      plan: dagOverviewLayoutInput(overview),
      geometry: {
        nodes: {
          "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
          solo: { x: 400, y: 0, width: 280, height: 140 },
        },
        frames: {},
        ports: {},
        routes: {},
        segments: [],
        junctions: [],
        width: 680,
        height: 140,
        quality: "elk",
      },
    });
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    // The status icon conveys the built-in status (not a flat grey dot).
    const lineCard = document.querySelector('[data-dag-overview-card="issue:r1"]')!;
    expect(lineCard.querySelector("svg")).toBeTruthy();
    expect(lineCard.innerHTML).toContain("text-warning");
    const solo = screen.getByText("T-SOLO").closest(".react-flow__node")!;
    fireEvent.doubleClick(solo);
    expect(props.onOpenIssue).toHaveBeenCalledWith("solo");
  });
});

describe("DagSceneCanvas line level", () => {
  it("renders nested frames, tasks and the external card; clicking it jumps", async () => {
    const { props } = harness(lineFixture());
    await waitFor(() => expect(screen.getByText("T-T1")).toBeInTheDocument());
    expect(document.querySelectorAll("[data-dag-frame]").length).toBe(2);
    expect(screen.getByText("Sub line")).toBeInTheDocument();
    expect(screen.getByText("T-S1")).toBeInTheDocument();
    const external = document.querySelector("[data-dag-external='r2']")!;
    expect(external).toHaveTextContent("Line two");
    fireEvent.click(external);
    expect(props.onExternalJump).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r2", kind: "line" }),
      "upstream",
    );
  });

  it("selects a frame from its header and opens tasks on double-click", async () => {
    const { store, props } = harness(lineFixture());
    await waitFor(() => expect(screen.getByText("T-T1")).toBeInTheDocument());
    fireEvent.click(document.querySelector("[data-dag-frame-header='sub']")!);
    expect(store.getState().dagSelectedNodeId).toBe("sub");
    const task = screen.getByText("T-T1").closest(".react-flow__node")!;
    fireEvent.doubleClick(task);
    expect(props.onOpenIssue).toHaveBeenCalledWith("t1");
  });
});

describe("DagSceneCanvas focus requests", () => {
  const readTransform = () =>
    (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform;

  it("selects and centers the target when the painted level matches", async () => {
    const fixture = lineFixture();
    const { store, rerender } = harness(fixture);
    await waitFor(() => expect(screen.getByText("T-T1")).toBeInTheDocument());
    const before = readTransform();
    rerender(
      <ViewStoreProvider store={store}>
        <ReactFlowProvider>
          <DagSceneCanvasInner
            {...fixture}
            level={{ kind: "line", lineId: "r1" }}
            statusColorOf={() => null}
            projectNames={new Map()}
            showSatisfied
            focusRequest={{ id: "sub", level: "line", nonce: 1 }}
            locateRequest={null}
            onEnterLine={vi.fn()}
            onOpenIssue={vi.fn()}
            onExternalJump={vi.fn()}
          />
        </ReactFlowProvider>
      </ViewStoreProvider>,
    );
    await waitFor(() => expect(store.getState().dagSelectedNodeId).toBe("sub"));
    const after = readTransform();
    expect(after).not.toBe(before);
    // Centered on the sub frame (340, 220) at the current zoom.
    const m = /translate\((-?[\d.]+)px[, ]+(-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(after);
    expect(m).toBeTruthy();
    const zoom = Number(m![3]);
    expect(Number(m![1])).toBeCloseTo(24 - 340 * zoom, 0);
    expect(Number(m![2])).toBeCloseTo(24 - 220 * zoom, 0);
  });

  it("waits while another level is painted, then handles the request", async () => {
    const overview = overviewFixture();
    const { store, rerender } = harness(overview);
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    const request = { id: "sub", level: "line" as const, nonce: 1 };
    rerender(
      <ViewStoreProvider store={store}>
        <ReactFlowProvider>
          <DagSceneCanvasInner
            {...overview}
            level={{ kind: "overview" }}
            statusColorOf={() => null}
            projectNames={new Map()}
            showSatisfied
            focusRequest={request}
            locateRequest={null}
            onEnterLine={vi.fn()}
            onOpenIssue={vi.fn()}
            onExternalJump={vi.fn()}
          />
        </ReactFlowProvider>
      </ViewStoreProvider>,
    );
    // The overview is painted but the request targets a line scene: no-op.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.getState().dagSelectedNodeId).toBeNull();
    const line = lineFixture();
    rerender(
      <ViewStoreProvider store={store}>
        <ReactFlowProvider>
          <DagSceneCanvasInner
            {...line}
            level={{ kind: "line", lineId: "r1" }}
            statusColorOf={() => null}
            projectNames={new Map()}
            showSatisfied
            focusRequest={request}
            locateRequest={null}
            onEnterLine={vi.fn()}
            onOpenIssue={vi.fn()}
            onExternalJump={vi.fn()}
          />
        </ReactFlowProvider>
      </ViewStoreProvider>,
    );
    await waitFor(() => expect(store.getState().dagSelectedNodeId).toBe("sub"));
  });

  it("drops the request when the target is missing on the painted level, permanently", async () => {
    const overview = overviewFixture();
    const { store, rerender } = harness(overview);
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    const before = readTransform();
    const request = { id: "ghost", level: "overview" as const, nonce: 1 };
    const renderProps = (geometry: DagSceneGeometry) => (
      <ViewStoreProvider store={store}>
        <ReactFlowProvider>
          <DagSceneCanvasInner
            {...overview}
            geometry={geometry}
            level={{ kind: "overview" }}
            statusColorOf={() => null}
            projectNames={new Map()}
            showSatisfied
            focusRequest={request}
            locateRequest={null}
            onEnterLine={vi.fn()}
            onOpenIssue={vi.fn()}
            onExternalJump={vi.fn()}
          />
        </ReactFlowProvider>
      </ViewStoreProvider>
    );
    rerender(renderProps(overview.geometry));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.getState().dagSelectedNodeId).toBeNull();
    // The target appearing later (e.g. via a display toggle) must not fire
    // a surprise jump: the handled nonce is never re-applied.
    const withGhost: DagSceneGeometry = {
      ...overview.geometry,
      nodes: { ...overview.geometry.nodes, ghost: { x: 900, y: 0, width: 280, height: 140 } },
    };
    rerender(renderProps(withGhost));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.getState().dagSelectedNodeId).toBeNull();
    expect(readTransform()).toBe(before);
  });
});

// ---- Stage 10: click highlight, bus click, zoom degradation -----------

/** OL-280 option B's example: A→X, A→Y, B→Y with shared bus intervals at A's
 *  output and Y's input. */
function abxyFixture() {
  const graph = makeGraph(
    [
      makeNode("r1", { title: "Line one" }),
      makeNode("a", { parentIssueId: "r1" }),
      makeNode("b", { parentIssueId: "r1" }),
      makeNode("x", { parentIssueId: "r1" }),
      makeNode("y", { parentIssueId: "r1" }),
    ],
    [
      { id: "a-x", source: "a", target: "x" },
      { id: "a-y", source: "a", target: "y" },
      { id: "b-y", source: "b", target: "y" },
    ],
  );
  const line = computeDagLine(createDagModelIndex(graph), "r1")!;
  const plan = dagLineLayoutInput(line);
  const geometry: DagSceneGeometry = {
    nodes: {
      a: { x: 60, y: 40, width: 248, height: 116 },
      b: { x: 60, y: 300, width: 248, height: 116 },
      x: { x: 500, y: 40, width: 248, height: 116 },
      y: { x: 500, y: 300, width: 248, height: 116 },
    },
    frames: {
      r1: { x: 0, y: 0, width: 820, height: 480, bands: [], stageMode: "labels" },
    },
    ports: {
      a: { input: { x: 60, y: 98 }, output: { x: 308, y: 98 } },
      b: { input: { x: 60, y: 358 }, output: { x: 308, y: 358 } },
      x: { input: { x: 500, y: 98 }, output: { x: 748, y: 98 } },
      y: { input: { x: 500, y: 358 }, output: { x: 748, y: 358 } },
    },
    routes: {
      "a-x": [
        { x: 308, y: 98 },
        { x: 404, y: 98 },
        { x: 500, y: 98 },
      ],
      "a-y": [
        { x: 308, y: 98 },
        { x: 404, y: 98 },
        { x: 404, y: 358 },
        { x: 500, y: 358 },
      ],
      "b-y": [
        { x: 308, y: 358 },
        { x: 404, y: 358 },
        { x: 500, y: 358 },
      ],
    },
    segments: [
      { id: "s0", start: { x: 308, y: 98 }, end: { x: 404, y: 98 }, edgeIds: ["a-x", "a-y"] },
      { id: "s1", start: { x: 404, y: 98 }, end: { x: 500, y: 98 }, edgeIds: ["a-x"] },
      { id: "s2", start: { x: 404, y: 98 }, end: { x: 404, y: 358 }, edgeIds: ["a-y"] },
      { id: "s3", start: { x: 308, y: 358 }, end: { x: 404, y: 358 }, edgeIds: ["b-y"] },
      { id: "s4", start: { x: 404, y: 358 }, end: { x: 500, y: 358 }, edgeIds: ["a-y", "b-y"] },
    ],
    junctions: [
      { x: 404, y: 98, edgeIds: ["a-x", "a-y"] },
      { x: 404, y: 358, edgeIds: ["a-y", "b-y"] },
    ],
    width: 820,
    height: 480,
    quality: "elk",
  };
  return { model: { kind: "line" as const, line }, plan, geometry };
}

const nodeOf = (id: string) =>
  document.querySelector(`.react-flow__node[data-id="${id}"]`)!;
// A lit card/frame punches a hole through the dim overlay; a dimmed one has none.
const cardLit = (id: string) =>
  !!document.querySelector(`[data-dag-dim-hole="${id}"]`);
const dimOverlay = () => document.querySelector("[data-dag-dim-overlay]");
// Severe-1 regression: the dim overlay must sit in its own svg above the
// z-index-2 cards, or it only ever covers the background.
const dimLayerZ = () => {
  const layer = document.querySelector("[data-dag-overlay-layer]") as HTMLElement | null;
  return layer ? getComputedStyle(layer).zIndex : null;
};
const litRouteGroups = () =>
  document.querySelectorAll("[data-dag-lit-edge]").length;
const baseGroupClass = () =>
  document.querySelector("[data-dag-edge-layer] > g")!.getAttribute("class") ?? "";

/** A depth-3 chain A→Y→Z→W: Y's one layer is {A→Y, Y→Z}, its full upstream +
 *  downstream adds {Z→W} — the click cycle's two scopes differ observably. */
function chainFixture() {
  const graph = makeGraph(
    [
      makeNode("r1", { title: "Line one" }),
      makeNode("a", { parentIssueId: "r1" }),
      makeNode("y", { parentIssueId: "r1" }),
      makeNode("z", { parentIssueId: "r1" }),
      makeNode("w", { parentIssueId: "r1" }),
    ],
    [
      { id: "a-y", source: "a", target: "y" },
      { id: "y-z", source: "y", target: "z" },
      { id: "z-w", source: "z", target: "w" },
    ],
  );
  const line = computeDagLine(createDagModelIndex(graph), "r1")!;
  const plan = dagLineLayoutInput(line);
  const geometry: DagSceneGeometry = {
    nodes: {
      a: { x: 60, y: 40, width: 248, height: 116 },
      y: { x: 340, y: 40, width: 248, height: 116 },
      z: { x: 620, y: 40, width: 248, height: 116 },
      w: { x: 900, y: 40, width: 248, height: 116 },
    },
    frames: {
      r1: { x: 0, y: 0, width: 1220, height: 220, bands: [], stageMode: "labels" },
    },
    ports: {
      a: { input: { x: 60, y: 98 }, output: { x: 308, y: 98 } },
      y: { input: { x: 340, y: 98 }, output: { x: 588, y: 98 } },
      z: { input: { x: 620, y: 98 }, output: { x: 868, y: 98 } },
      w: { input: { x: 900, y: 98 }, output: { x: 1148, y: 98 } },
    },
    routes: {
      "a-y": [
        { x: 308, y: 98 },
        { x: 340, y: 98 },
      ],
      "y-z": [
        { x: 588, y: 98 },
        { x: 620, y: 98 },
      ],
      "z-w": [
        { x: 868, y: 98 },
        { x: 900, y: 98 },
      ],
    },
    segments: [
      { id: "s0", start: { x: 308, y: 98 }, end: { x: 340, y: 98 }, edgeIds: ["a-y"] },
      { id: "s1", start: { x: 588, y: 98 }, end: { x: 620, y: 98 }, edgeIds: ["y-z"] },
      { id: "s2", start: { x: 868, y: 98 }, end: { x: 900, y: 98 }, edgeIds: ["z-w"] },
    ],
    junctions: [],
    width: 1220,
    height: 220,
    quality: "elk",
  };
  return { model: { kind: "line" as const, line }, plan, geometry };
}

describe("DagSceneCanvas Stage 10 interactions", () => {
  it("clicking a node lights only its own dependencies: Y, then X, then B", async () => {
    const { store } = harness(abxyFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    // Y lights A→Y and B→Y; the A→X branch sharing the same bus stays dim.
    fireEvent.click(nodeOf("y"));
    expect(store.getState().dagSelectedNodeId).toBe("y");
    await waitFor(() => expect(litRouteGroups()).toBe(2));
    expect(baseGroupClass()).toContain("opacity-15");
    expect(dimLayerZ()).toBe("3");
    expect(cardLit("a")).toBe(true);
    expect(cardLit("b")).toBe(true);
    expect(cardLit("y")).toBe(true);
    expect(cardLit("x")).toBe(false);
    // The frame header of the lit cards' line stays visible too.
    expect(cardLit("r1")).toBe(true);
    // X lights only A→X; Y and B dim.
    fireEvent.click(nodeOf("x"));
    await waitFor(() => expect(litRouteGroups()).toBe(1));
    expect(cardLit("x")).toBe(true);
    expect(cardLit("y")).toBe(false);
    expect(cardLit("b")).toBe(false);
    // B lights only B→Y.
    fireEvent.click(nodeOf("b"));
    await waitFor(() => expect(litRouteGroups()).toBe(1));
    expect(cardLit("b")).toBe(true);
    expect(cardLit("a")).toBe(false);
    // Clicking the pane restores everything.
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    await waitFor(() => expect(litRouteGroups()).toBe(0));
    expect(baseGroupClass()).not.toContain("opacity-15");
    expect(dimOverlay()).toBeNull();
  });

  it("hovering never lights edges or dims the canvas (task, overview, frame and external cards)", async () => {
    // Line scene: the task card and the frame header.
    const line = harness(lineFixture());
    await waitFor(() => expect(nodeOf("t1")).toBeTruthy());
    for (const id of ["t1", "r1"]) {
      fireEvent.mouseEnter(nodeOf(id));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(litRouteGroups()).toBe(0);
      expect(dimOverlay()).toBeNull();
      expect(baseGroupClass()).not.toContain("opacity-15");
      fireEvent.mouseLeave(nodeOf(id));
    }
    // External side card.
    const externalNode = document
      .querySelector("[data-dag-external='r2']")!
      .closest(".react-flow__node")!;
    fireEvent.mouseEnter(externalNode);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(litRouteGroups()).toBe(0);
    expect(dimOverlay()).toBeNull();
    expect(line.store.getState().dagSelectedNodeId).toBeNull();
    line.unmount();
    // Overview card.
    const overview = harness(overviewFixture());
    await waitFor(() => expect(nodeOf("issue:r1")).toBeTruthy());
    fireEvent.mouseEnter(nodeOf("issue:r1"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(litRouteGroups()).toBe(0);
    expect(dimOverlay()).toBeNull();
    expect(baseGroupClass()).not.toContain("opacity-15");
    expect(overview.store.getState().dagSelectedNodeId).toBeNull();
    expect(overview.store.getState().dagFocus).toBeNull();
  });

  it("clicking a bus segment selects its deduplicated original dependencies", async () => {
    const { store } = harness(abxyFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    fireEvent.click(document.querySelector('[data-dag-bus-hit="s0"]')!);
    expect(store.getState().dagSelectedDependencyIds).toEqual(["a-x", "a-y"]);
    expect(store.getState().dagSelectedNodeId).toBeNull();
    // The selected dependencies light their own routes.
    await waitFor(() => expect(litRouteGroups()).toBe(2));
    // Cards are not dimmed by a bus selection — only edges.
    expect(dimOverlay()).toBeNull();
    fireEvent.click(document.querySelector('[data-dag-bus-hit="s4"]')!);
    expect(store.getState().dagSelectedDependencyIds).toEqual(["a-y", "b-y"]);
    // Clicking the pane clears the bus selection too.
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    expect(store.getState().dagSelectedDependencyIds).toBeNull();
    await waitFor(() => expect(litRouteGroups()).toBe(0));
  });

  it("paints edges and ghost blocks after panning far in negative translate", async () => {
    const fixture = abxyFixture();
    const shifted: DagSceneGeometry = {
      ...fixture.geometry,
      nodes: Object.fromEntries(
        Object.entries(fixture.geometry.nodes).map(([id, b]) => [id, { ...b, x: b.x + 12000 }]),
      ),
      frames: Object.fromEntries(
        Object.entries(fixture.geometry.frames).map(([id, b]) => [id, { ...b, x: b.x + 12000 }]),
      ),
      ports: Object.fromEntries(
        Object.entries(fixture.geometry.ports).map(([id, p]) => [
          id,
          { input: { x: p.input.x + 12000, y: p.input.y }, output: { x: p.output.x + 12000, y: p.output.y } },
        ]),
      ),
      routes: Object.fromEntries(
        Object.entries(fixture.geometry.routes).map(([id, r]) => [
          id,
          r.map((p) => ({ x: p.x + 12000, y: p.y })),
        ]),
      ),
      segments: fixture.geometry.segments.map((s) => ({
        ...s,
        start: { x: s.start.x + 12000, y: s.start.y },
        end: { x: s.end.x + 12000, y: s.end.y },
      })),
      junctions: fixture.geometry.junctions.map((j) => ({ ...j, x: j.x + 12000 })),
      width: fixture.geometry.width + 12000,
    };
    const { flow } = harness({ ...fixture, geometry: shifted });
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    // Zoomed out at a negative translate the visible window sits around
    // x≈12300: culling must keep painting the scene (and the simplified
    // cards), not an empty off-window slice.
    await flow().setViewport({ x: -12300 * 0.3, y: -40, zoom: 0.3 });
    await waitFor(() => {
      const layer = document.querySelector("[data-dag-edge-layer]")!;
      const painted = [...layer.querySelectorAll("[data-dag-segments]")].flatMap((el) =>
        (el.getAttribute("data-dag-segments") ?? "").split(" ").filter(Boolean),
      );
      expect(painted.length).toBeGreaterThan(0);
      expect(layer.querySelector("[data-dag-ghost-blocks]")).toBeTruthy();
    });
  });

  it("clicking with the pointer resting on the card still advances the click cycle", async () => {
    const { store } = harness(chainFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    vi.useFakeTimers();
    try {
      // The pointer stays on the card across both clicks — as if hovering —
      // yet the click sequence must run normally.
      fireEvent.mouseEnter(nodeOf("y"));
      fireEvent.click(nodeOf("y"));
      expect(store.getState().dagSelectedNodeId).toBe("y");
      fireEvent.click(nodeOf("y"));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(store.getState().dagFocus).toEqual({ nodeId: "y", way: "both" });
      expect(litRouteGroups()).toBe(3);
      expect(cardLit("w")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a third click after a nodes rebuild still returns to one layer", async () => {
    const { store, props, rerender } = harness(chainFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    vi.useFakeTimers();
    try {
      fireEvent.click(nodeOf("y"));
      fireEvent.click(nodeOf("y"));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(store.getState().dagFocus).toEqual({ nodeId: "y", way: "both" });
      // A data refresh rebuilds the nodes array (new geometry identity), and
      // React Flow re-emits the selection — the cycle must survive intact.
      rerender(
        <ViewStoreProvider store={store}>
          <ReactFlowProvider>
            <DagSceneCanvasInner {...props} geometry={{ ...props.geometry }} />
          </ReactFlowProvider>
        </ViewStoreProvider>,
      );
      fireEvent.click(nodeOf("y"));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(store.getState().dagFocus).toBeNull();
      expect(litRouteGroups()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow double-click (inside the system window) rolls the switch back", async () => {
    const { store, props } = harness(overviewFixture());
    const card = await screen.findByText("Line one");
    const node = card.closest(".react-flow__node")!;
    fireEvent.click(node);
    expect(store.getState().dagSelectedNodeId).toBe("issue:r1");
    vi.useFakeTimers();
    try {
      // First click of the double-click: the 400ms window fires the switch,
      // then the system still counts the second click as a double-click.
      fireEvent.click(node, { detail: 1 });
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(store.getState().dagFocus).toEqual({ nodeId: "issue:r1", way: "both" });
      fireEvent.click(node, { detail: 2 });
      fireEvent.doubleClick(node);
      expect(props.onEnterLine).toHaveBeenCalledWith("r1");
      expect(store.getState().dagFocus).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("focus on an overview card also overlays its satisfied bundles (switch off)", async () => {
    const graph = makeGraph(
      [
        makeNode("r1", { title: "Line one" }),
        makeNode("a1", { parentIssueId: "r1", status: "done", statusCategory: "done" }),
        makeNode("a2", { parentIssueId: "r1" }),
        makeNode("r2", { title: "Line two" }),
        makeNode("b1", { parentIssueId: "r2" }),
        makeNode("r4", { title: "Line four" }),
        makeNode("c1", { parentIssueId: "r4", status: "done", statusCategory: "done" }),
      ],
      [
        { id: "e-a1", source: "a1", target: "b1" },
        { id: "e-a2", source: "a2", target: "b1" },
        { id: "e-c1", source: "c1", target: "b1" },
      ],
    );
    const overview = computeDagOverview(createDagModelIndex(graph), {
      showCompleted: false,
      showSatisfiedDependencies: false,
    })!;
    const plan = dagOverviewLayoutInput(overview);
    const geometry: DagSceneGeometry = {
      nodes: {
        "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
        "issue:r2": { x: 500, y: 60, width: 280, height: 140 },
        "issue:r4": { x: 0, y: 300, width: 280, height: 140 },
      },
      frames: {},
      ports: {
        "issue:r1": { input: { x: 0, y: 70 }, output: { x: 280, y: 70 } },
        "issue:r2": { input: { x: 500, y: 130 }, output: { x: 780, y: 130 } },
        "issue:r4": { input: { x: 0, y: 370 }, output: { x: 280, y: 370 } },
      },
      routes: {
        [JSON.stringify(["issue:r1", "issue:r2"])]: [
          { x: 280, y: 70 },
          { x: 390, y: 70 },
          { x: 390, y: 130 },
          { x: 500, y: 130 },
        ],
      },
      segments: [],
      junctions: [],
      width: 780,
      height: 440,
      quality: "elk",
    };
    const satisfiedId = JSON.stringify(["issue:r4", "issue:r2"]);
    const { store } = harness(
      { model: { kind: "overview", overview }, plan, geometry },
      (s) => s.setState({ dagSelectedNodeId: "issue:r2", dagFocus: { nodeId: "issue:r2", way: "upstream" } }),
    );
    await waitFor(() => {
      const lit = [...document.querySelectorAll("[data-dag-lit-edge]")].map((el) =>
        el.getAttribute("data-dag-lit-edge"),
      );
      expect(lit).toContain(satisfiedId);
    });
    expect(store.getState().dagFocus).toEqual({ nodeId: "issue:r2", way: "upstream" });
  });

  it("ignores the trailing third click of a triple-click", async () => {
    const { store, props } = harness(overviewFixture());
    const card = await screen.findByText("Line one");
    const node = card.closest(".react-flow__node")!;
    fireEvent.click(node);
    expect(store.getState().dagSelectedNodeId).toBe("issue:r1");
    vi.useFakeTimers();
    try {
      // detail 1 arms the cycle; detail 2 belongs to the double-click; the
      // trailing detail 3 must not arm another switch.
      fireEvent.click(node, { detail: 1 });
      fireEvent.click(node, { detail: 2 });
      fireEvent.doubleClick(node);
      expect(props.onEnterLine).toHaveBeenCalledWith("r1");
      fireEvent.click(node, { detail: 3 });
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(store.getState().dagFocus).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a double-click right after returning to one layer does not resurrect the closure", async () => {
    const { store, props } = harness(overviewFixture());
    const card = await screen.findByText("Line one");
    const node = card.closest(".react-flow__node")!;
    fireEvent.click(node);
    vi.useFakeTimers();
    try {
      // Up to the closure, back to one layer — then a double-click within the
      // rollback window must not bring the closure back.
      fireEvent.click(node);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(store.getState().dagFocus).toEqual({ nodeId: "issue:r1", way: "both" });
      fireEvent.click(node);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(store.getState().dagFocus).toBeNull();
      fireEvent.click(node, { detail: 1 });
      fireEvent.click(node, { detail: 2 });
      fireEvent.doubleClick(node);
      expect(props.onEnterLine).toHaveBeenCalledWith("r1");
      expect(store.getState().dagFocus).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swaps to simplified blocks exactly at the 0.4 threshold, not at a quantized step", async () => {
    const { flow } = harness(overviewFixture());
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    await flow().setViewport({ x: 0, y: 0, zoom: 0.42 });
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    expect(document.querySelector("[data-dag-ghost-blocks]")).toBeNull();
    await flow().setViewport({ x: 0, y: 0, zoom: 0.39 });
    await waitFor(() => expect(document.querySelector("[data-dag-ghost-blocks]")).toBeTruthy());
    // Hysteresis: crossing back up inside the band keeps the simplified view.
    await flow().setViewport({ x: 0, y: 0, zoom: 0.42 });
    await waitFor(() => {
      expect(document.querySelector("[data-dag-ghost-blocks]")).toBeTruthy();
      expect(screen.queryByText("Line one")).toBeNull();
    });
    await flow().setViewport({ x: 0, y: 0, zoom: 0.45 });
    await waitFor(() => {
      expect(screen.getByText("Line one")).toBeInTheDocument();
      expect(document.querySelector("[data-dag-ghost-blocks]")).toBeNull();
    });
  });

  it("stops edge motion below 50% zoom and resumes above it", async () => {
    const graph = makeGraph(
      [
        makeNode("r1", { title: "Line one" }),
        makeNode("a", { parentIssueId: "r1", status: "in_progress", statusCategory: "started" }),
        makeNode("b", { parentIssueId: "r1" }),
      ],
      [{ id: "a-b", source: "a", target: "b" }],
    );
    const line = computeDagLine(createDagModelIndex(graph), "r1")!;
    const plan = dagLineLayoutInput(line);
    const geometry: DagSceneGeometry = {
      nodes: {
        a: { x: 60, y: 40, width: 248, height: 116 },
        b: { x: 400, y: 40, width: 248, height: 116 },
      },
      frames: { r1: { x: 0, y: 0, width: 720, height: 220, bands: [], stageMode: "labels" } },
      ports: {
        a: { input: { x: 60, y: 98 }, output: { x: 308, y: 98 } },
        b: { input: { x: 400, y: 98 }, output: { x: 648, y: 98 } },
      },
      routes: { "a-b": [{ x: 308, y: 98 }, { x: 400, y: 98 }] },
      segments: [
        { id: "s0", start: { x: 308, y: 98 }, end: { x: 400, y: 98 }, edgeIds: ["a-b"] },
      ],
      junctions: [],
      width: 720,
      height: 220,
      quality: "elk",
    };
    const { flow } = harness({ model: { kind: "line", line }, plan, geometry });
    await waitFor(() => expect(nodeOf("b")).toBeTruthy());
    await waitFor(() => expect(document.querySelectorAll(".dag-edge-flow").length).toBeGreaterThan(0));
    await flow().setViewport({ x: 0, y: 0, zoom: 0.45 });
    await waitFor(() => expect(document.querySelectorAll(".dag-edge-flow")).toHaveLength(0));
    await flow().setViewport({ x: 0, y: 0, zoom: 0.6 });
    await waitFor(() => expect(document.querySelectorAll(".dag-edge-flow").length).toBeGreaterThan(0));
  });

  it("zooming below the readability threshold swaps cards to plain blocks", async () => {
    const { flow } = harness(overviewFixture());
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    await flow().setViewport({ x: 0, y: 0, zoom: 0.3 });
    await waitFor(() => {
      const card = document.querySelector("[data-dag-overview-card]")!;
      expect(card.textContent).toBe("");
    });
    await flow().setViewport({ x: 0, y: 0, zoom: 1 });
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
  });

  it("cycles one layer → all upstream + downstream → one layer on repeated clicks", async () => {
    const { store } = harness(chainFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    vi.useFakeTimers();
    try {
      // First click: select with the one-layer neighborhood.
      fireEvent.click(nodeOf("y"));
      expect(store.getState().dagSelectedNodeId).toBe("y");
      expect(store.getState().dagFocus).toBeNull();
      expect(litRouteGroups()).toBe(2);
      // The second click waits out the double-click window before switching.
      fireEvent.click(nodeOf("y"));
      expect(store.getState().dagFocus).toBeNull();
      act(() => {
        vi.advanceTimersByTime(399);
      });
      expect(store.getState().dagFocus).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(store.getState().dagFocus).toEqual({ nodeId: "y", way: "both" });
      expect(litRouteGroups()).toBe(3);
      expect(cardLit("w")).toBe(true);
      // The third click returns to one layer.
      fireEvent.click(nodeOf("y"));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(store.getState().dagFocus).toBeNull();
      expect(litRouteGroups()).toBe(2);
      expect(cardLit("w")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a double-click keeps its action and never switches to the closure", async () => {
    const { store, props } = harness(overviewFixture());
    const card = await screen.findByText("Line one");
    const node = card.closest(".react-flow__node")!;
    // Select the card first: the double-click then starts with a pending cycle.
    fireEvent.click(node);
    expect(store.getState().dagSelectedNodeId).toBe("issue:r1");
    vi.useFakeTimers();
    try {
      // The browser sequence: click (detail 1), click (detail 2), dblclick.
      fireEvent.click(node, { detail: 1 });
      fireEvent.click(node, { detail: 2 });
      fireEvent.doubleClick(node);
      expect(props.onEnterLine).toHaveBeenCalledWith("r1");
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(store.getState().dagFocus).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DagSceneCanvas focus level", () => {
  it("fits the remaining scene when the focused task is hidden", async () => {
    const line = lineFixture();
    const model = dagFocusCanvasModel(computeDagFocus(createDagModelIndex(makeGraph([
      makeNode("hidden", { status: "done", statusCategory: "done" }), makeNode("after"),
    ], [["hidden", "after"]])), "hidden"));
    const geometry = fallbackDagScene(model.plan.input);
    expect(geometry.nodes.hidden).toBeUndefined();
    const { store, props, rerender, flow } = harness(line);
    await waitFor(() => expect(screen.getByText("T-T1")).toBeInTheDocument());
    await flow().setViewport({ x: -5000, y: -5000, zoom: 0.2 });
    rerender(
      <ViewStoreProvider store={store}><ReactFlowProvider><DagSceneCanvasInner
        {...props} level={{ kind: "focus", issueId: "hidden" }} model={model} plan={model.plan} geometry={geometry}
        focusRequest={{ id: "hidden", level: "focus", nonce: 1 }}
      /></ReactFlowProvider></ViewStoreProvider>,
    );
    await waitFor(() => {
      const viewport = flow().getViewport();
      const box = geometry.nodes.after!;
      expect(viewport.zoom).toBe(1);
      expect(box.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0);
      expect((box.x + box.width) * viewport.zoom + viewport.x).toBeLessThanOrEqual(1400);
      expect(box.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(0);
      expect((box.y + box.height) * viewport.zoom + viewport.y).toBeLessThanOrEqual(900);
    });
    expect(store.getState().dagSelectedNodeId).toBeNull();
  });

  it("gates focus requests until the focus scene paints, resolves frame fragments, and restores the line viewport", async () => {
    const line = lineFixture();
    const model = dagFocusCanvasModel(computeDagFocus(createDagModelIndex(makeGraph([
      makeNode("root"), makeNode("child", { parentIssueId: "root" }), makeNode("up"),
    ], [["up", "root"]])), "root"));
    const geometry = fallbackDagScene(model.plan.input);
    const { store, props, rerender } = harness(line, (s) => s.setState({ dagViewports: { "line:r1": { x: 33, y: 44, zoom: 0.9 } } }));
    const request = { id: "root", level: "focus" as const, nonce: 1 };
    const paint = (next: DagSceneCanvasProps) => rerender(
      <ViewStoreProvider store={store}><ReactFlowProvider><DagSceneCanvasInner {...next} /></ReactFlowProvider></ViewStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText("T-T1")).toBeInTheDocument());
    paint({ ...props, focusRequest: request });
    expect(store.getState().dagSelectedNodeId).toBeNull();
    paint({ ...props, level: { kind: "focus", issueId: "root" }, model, plan: model.plan, geometry, focusRequest: request });
    const frameId = model.plan.input.frames.find((frame) => frame.modelId === "root" && frame.side === "current")!.id;
    await waitFor(() => expect(store.getState().dagSelectedNodeId).toBe(frameId));
    const box = geometry.frames[frameId]!;
    const expected = `translate(${700 - (box.x + box.width / 2) * 0.9}px,${450 - (box.y + box.height / 2) * 0.9}px) scale(0.9)`;
    await waitFor(() => expect((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform).toBe(expected));
    // The queued React Flow node initialization must not fit the whole scene
    // after the explicit focus viewport has been applied.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform).toBe(expected);
    fireEvent.click(document.querySelector(`[data-dag-frame-header]`)!);
    expect(store.getState().dagSelectedNodeId).toBe(frameId);
    paint({ ...props, focusRequest: null });
    await waitFor(() => expect((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform).toBe("translate(33px,44px) scale(0.9)"));
  });
});

describe("DagSceneCanvas Stage 10 on the focus scene", () => {
  const focusFixture = () => {
    const model = dagFocusCanvasModel(
      computeDagFocus(
        createDagModelIndex(
          makeGraph(
            [
              makeNode("line", { title: "Line frame" }),
              makeNode("mid", { parentIssueId: "line", title: "Middle task" }),
              makeNode("a", { parentIssueId: "line", title: "Inner task" }),
              makeNode("up", { title: "Upstream task" }),
              makeNode("down", { title: "Downstream task" }),
            ],
            [
              ["up", "a"],
              ["a", "mid"],
              ["mid", "down"],
            ],
          ),
        ),
        "mid",
      ),
    );
    return { model, geometry: fallbackDagScene(model.plan.input) };
  };

  it("runs the click cycle and paints ghost blocks (incl. frames) on the focus scene", async () => {
    const { model, geometry } = focusFixture();
    const { store, flow } = harness({
      model,
      plan: model.plan,
      geometry,
    });
    await waitFor(() => expect(nodeOf("mid")).toBeTruthy());
    // Cover the whole scene explicitly: the focus scene's initial viewport
    // may leave the upstream card off-canvas (its edge is then culled).
    await flow().setViewport({ x: 0, y: 0, zoom: 0.6 });
    vi.useFakeTimers();
    try {
      fireEvent.click(nodeOf("mid"));
      expect(store.getState().dagSelectedNodeId).toBe("mid");
      expect(litRouteGroups()).toBe(2);
      fireEvent.click(nodeOf("mid"));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(store.getState().dagFocus).toEqual({ nodeId: "mid", way: "both" });
      expect(litRouteGroups()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
    // Simplified zoom paints the focus scene's frames as ghost blocks too.
    await flow().setViewport({ x: 0, y: 0, zoom: 0.3 });
    await waitFor(() => {
      expect(document.querySelector('[data-dag-ghost="frames"]')).toBeTruthy();
      expect(document.querySelector('[data-dag-ghost="tasks"]')).toBeTruthy();
    });
    await flow().setViewport({ x: 0, y: 0, zoom: 1 });
  });

  it("selects a focus-scene bus segment's original dependencies", async () => {
    const { model, geometry } = focusFixture();
    const { store } = harness({ model, plan: model.plan, geometry });
    await waitFor(() => expect(nodeOf("mid")).toBeTruthy());
    const hits = document.querySelectorAll("[data-dag-bus-hit]");
    expect(hits.length).toBeGreaterThan(0);
    fireEvent.click(hits[0]!);
    expect(store.getState().dagSelectedDependencyIds!.length).toBeGreaterThan(0);
  });
});

describe("DagSceneCanvas Stage 10 coverage gaps", () => {
  it("locate request centers the dependency's painted endpoints", async () => {
    const { props, flow, store, rerender } = harness(chainFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    flow().setViewport({ x: 0, y: 0, zoom: 1 });
    rerender(
      <ViewStoreProvider store={store}>
        <ReactFlowProvider>
          <DagSceneCanvasInner
            {...props}
            locateRequest={{ dependencyId: "z-w", nonce: 1 }}
          />
        </ReactFlowProvider>
      </ViewStoreProvider>,
    );
    // The z/w boxes span flow x 620..1148 at y 40..156 — centered at zoom 1
    // on the 1400×900 stubbed canvas.
    const expectedX = 700 - (620 + 1148) / 2;
    const expectedY = 450 - (40 + 156) / 2;
    await waitFor(() => {
      const viewport = flow().getViewport();
      expect(Math.abs(viewport.x - expectedX)).toBeLessThan(2);
      expect(Math.abs(viewport.y - expectedY)).toBeLessThan(2);
      expect(viewport.zoom).toBe(1);
    });
  });

  it("paints frame, task and external ghost blocks on the line scene", async () => {
    const { flow } = harness(lineFixture());
    await waitFor(() => expect(screen.getByText("Sub line")).toBeInTheDocument());
    await flow().setViewport({ x: 0, y: 0, zoom: 0.3 });
    await waitFor(() => {
      const ghost = document.querySelector("[data-dag-ghost-blocks]")!;
      expect(ghost).toBeTruthy();
      // body (tasks), frames (line + sub-line) and external side cards are
      // three distinct path groups.
      expect(document.querySelector('[data-dag-ghost="tasks"]')).toBeTruthy();
      expect(document.querySelector('[data-dag-ghost="frames"]')).toBeTruthy();
      expect(document.querySelector('[data-dag-ghost="externals"]')).toBeTruthy();
    });
    await flow().setViewport({ x: 0, y: 0, zoom: 1 });
    await waitFor(() => expect(screen.getByText("Sub line")).toBeInTheDocument());
  });

  it("keeps the containing frame lit through the whole click cycle", async () => {
    harness(chainFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    vi.useFakeTimers();
    try {
      fireEvent.click(nodeOf("y"));
      expect(cardLit("r1")).toBe(true);
      fireEvent.click(nodeOf("y"));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(cardLit("r1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DagSceneCanvas satisfied overlay sources", () => {
  const SATISFIED = JSON.stringify(["issue:r4", "issue:r2"]);
  const litEdgeIds = () =>
    [...document.querySelectorAll("[data-dag-lit-edge]")].map((el) =>
      el.getAttribute("data-dag-lit-edge"),
    );
  /** r1→r2 is a mixed bundle (a1 done, a2 open); r4→r2 is fully satisfied and
   *  only ever shows through the overlay. r3 has no dependencies at all. */
  function satisfiedFixture() {
    const graph = makeGraph(
      [
        makeNode("r1", { title: "Line one" }),
        makeNode("a1", { parentIssueId: "r1", status: "done", statusCategory: "done" }),
        makeNode("a2", { parentIssueId: "r1" }),
        makeNode("r2", { title: "Line two" }),
        makeNode("b1", { parentIssueId: "r2" }),
        makeNode("r3", { title: "Line three" }),
        makeNode("d1", { parentIssueId: "r3" }),
        makeNode("r4", { title: "Line four" }),
        makeNode("c1", { parentIssueId: "r4", status: "done", statusCategory: "done" }),
      ],
      [
        { id: "e-a1", source: "a1", target: "b1" },
        { id: "e-a2", source: "a2", target: "b1" },
        { id: "e-c1", source: "c1", target: "b1" },
      ],
    );
    const overview = computeDagOverview(createDagModelIndex(graph), {
      showCompleted: false,
      showSatisfiedDependencies: false,
    })!;
    const geometry: DagSceneGeometry = {
      nodes: {
        "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
        "issue:r2": { x: 500, y: 60, width: 280, height: 140 },
        "issue:r3": { x: 500, y: 340, width: 280, height: 140 },
        "issue:r4": { x: 0, y: 300, width: 280, height: 140 },
      },
      frames: {},
      ports: {
        "issue:r1": { input: { x: 0, y: 70 }, output: { x: 280, y: 70 } },
        "issue:r2": { input: { x: 500, y: 130 }, output: { x: 780, y: 130 } },
        "issue:r3": { input: { x: 500, y: 410 }, output: { x: 780, y: 410 } },
        "issue:r4": { input: { x: 0, y: 370 }, output: { x: 280, y: 370 } },
      },
      routes: {
        [BUNDLE]: [
          { x: 280, y: 70 },
          { x: 390, y: 70 },
          { x: 390, y: 130 },
          { x: 500, y: 130 },
        ],
      },
      segments: [],
      junctions: [],
      width: 780,
      height: 480,
      quality: "elk",
    };
    return {
      model: { kind: "overview" as const, overview },
      plan: dagOverviewLayoutInput(overview),
      geometry,
    };
  }

  it("selecting the card is enough for its satisfied overlay (no hover)", async () => {
    harness(satisfiedFixture(), (s) => s.setState({ dagSelectedNodeId: "issue:r2" }));
    await waitFor(() => expect(nodeOf("issue:r2")).toBeTruthy());
    // Selection alone lights the mixed base bundle AND the fully satisfied
    // r4→r2 overlay — no pointer rest required.
    await waitFor(() => expect(litEdgeIds()).toContain(BUNDLE));
    await waitFor(() => expect(litEdgeIds()).toContain(SATISFIED));
    // The satisfied source card lights through a dim hole too.
    expect(cardLit("issue:r4")).toBe(true);
  });

  it("selecting a card whose only cross-line dependencies are satisfied still overlays them", async () => {
    // r4 has no base route in the plan (its single dependency r4→r2 is fully
    // satisfied): the overlay alone must light up on selection.
    const { store } = harness(satisfiedFixture(), (s) => s.setState({ dagSelectedNodeId: "issue:r4" }));
    await waitFor(() => expect(nodeOf("issue:r4")).toBeTruthy());
    await waitFor(() => expect(litEdgeIds()).toContain(SATISFIED));
    expect(litEdgeIds()).not.toContain(BUNDLE);
    // The other end of the satisfied bundle lights through a dim hole.
    expect(cardLit("issue:r2")).toBe(true);
    expect(store.getState().dagFocus).toBeNull();
  });

  it("keeps the focus anchor's satisfied overlay over an unrelated hover", async () => {
    const { store } = harness(satisfiedFixture(), (s) =>
      s.setState({ dagFocus: { nodeId: "issue:r2", way: "upstream" } }),
    );
    await waitFor(() => expect(nodeOf("issue:r3")).toBeTruthy());
    await waitFor(() => expect(litEdgeIds()).toContain(SATISFIED));
    fireEvent.mouseEnter(nodeOf("issue:r3"));
    // Hover must not disturb the focus highlight (and its overlay).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(litEdgeIds()).toContain(SATISFIED);
    expect(store.getState().dagFocus).toEqual({ nodeId: "issue:r2", way: "upstream" });
  });

  it("keeps the satisfied overlay while the focused card itself is hovered", async () => {
    harness(satisfiedFixture(), (s) =>
      s.setState({ dagFocus: { nodeId: "issue:r2", way: "upstream" } }),
    );
    await waitFor(() => expect(nodeOf("issue:r2")).toBeTruthy());
    await waitFor(() => expect(litEdgeIds()).toContain(SATISFIED));
    fireEvent.mouseEnter(nodeOf("issue:r2"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(litEdgeIds()).toContain(SATISFIED);
  });
});

describe("DagSceneCanvas Stage 10 review assertions", () => {
  it("keeps the external card's jump click in the simplified line scene", async () => {
    const { flow, props } = harness(lineFixture());
    await waitFor(() => expect(screen.getByText("Sub line")).toBeInTheDocument());
    await flow().setViewport({ x: 0, y: 0, zoom: 0.3 });
    await waitFor(() =>
      expect(document.querySelector('[data-dag-ghost="externals"]')).toBeTruthy(),
    );
    fireEvent.click(document.querySelector("[data-dag-external='r2']")!);
    expect(props.onExternalJump).toHaveBeenCalled();
  });

  it("paints the cancelled blocker's ghost block with a dashed border", async () => {
    const cancelledGraph = makeGraph(
      [
        makeNode("r1"),
        makeNode("a1", { parentIssueId: "r1" }),
        makeNode("cancelled", { status: "cancelled", statusCategory: "closed" }),
      ],
      [{ id: "e-x", source: "cancelled", target: "a1" }],
    );
    const overview = computeDagOverview(createDagModelIndex(cancelledGraph), {
      showCompleted: false,
      showSatisfiedDependencies: true,
    })!;
    const cancelledCard = overview.cards.find((c) => c.cancelledBlocking)!;
    const { flow } = harness({
      model: { kind: "overview", overview },
      plan: dagOverviewLayoutInput(overview),
      geometry: {
        nodes: { [cancelledCard.id]: { x: 0, y: 0, width: 280, height: 140 } },
        frames: {},
        ports: {},
        routes: {},
        segments: [],
        junctions: [],
        width: 280,
        height: 140,
        quality: "elk",
      },
    });
    await waitFor(() => expect(document.querySelector("[data-dag-overview-card]")).toBeTruthy());
    await flow().setViewport({ x: 0, y: 0, zoom: 0.3 });
    await waitFor(() =>
      expect(document.querySelector('[data-dag-ghost="dashed"]')).toBeTruthy(),
    );
  });
});

describe("DagSceneCanvas first-open viewport (OL-451)", () => {
  const readTransform = () =>
    (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform;

  /** The two fixture cards pushed 6000×3000 apart: no readable zoom fits. */
  function bigOverviewFixture() {
    const base = overviewFixture();
    const geometry: DagSceneGeometry = {
      ...base.geometry,
      nodes: {
        "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
        "issue:r2": { x: 5720, y: 2860, width: 280, height: 140 },
      },
      ports: {
        "issue:r1": { input: { x: 0, y: 70 }, output: { x: 280, y: 70 } },
        "issue:r2": { input: { x: 5720, y: 2930 }, output: { x: 6000, y: 2930 } },
      },
      routes: {
        [BUNDLE]: [
          { x: 280, y: 70 },
          { x: 3000, y: 70 },
          { x: 3000, y: 2930 },
          { x: 5720, y: 2930 },
        ],
      },
      width: 6000,
      height: 3000,
    };
    return { ...base, geometry };
  }

  it("opens a huge overview at the readable zoom from the top-left, cards readable", async () => {
    harness(bigOverviewFixture());
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    await waitFor(() => expect(readTransform()).toBe("translate(24px,24px) scale(0.75)"));
    // Above the simplified-block threshold: real cards, not plain blocks.
    expect(document.querySelector("[data-dag-ghost-blocks]")).toBeNull();
    expect(screen.getByText("Line two")).toBeInTheDocument();
  });

  it("opens a huge line at the readable zoom from its leftmost column", async () => {
    const base = lineFixture();
    const geometry: DagSceneGeometry = {
      ...base.geometry,
      frames: {
        ...base.geometry.frames,
        r1: { x: 0, y: 0, width: 6000, height: 500, bands: [], stageMode: "labels" },
      },
      width: 6000,
    };
    harness({ ...base, geometry });
    await waitFor(() => expect(screen.getByText("T-T1")).toBeInTheDocument());
    // Bounds (-220,0,6220,500): x anchors the left edge, y centers (it fits).
    await waitFor(() => expect(readTransform()).toBe("translate(189px,262.5px) scale(0.75)"));
    expect(document.querySelector("[data-dag-ghost-blocks]")).toBeNull();
  });

  it("still restores a remembered viewport on a huge scene", async () => {
    harness(bigOverviewFixture(), (store) => {
      store.setState({ dagViewports: { overview: { x: 33, y: -44, zoom: 1.25 } } });
    });
    await waitFor(() => expect(readTransform()).toContain("scale(1.25)"));
    expect(readTransform()).toContain("translate(33px,-44px)");
  });

  it("still fits the whole scene when the content fits at the readable zoom", async () => {
    harness(overviewFixture());
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    // The fit-all path is unchanged: maxZoom 1, every card painted readably.
    await waitFor(() => expect(readTransform()).toContain("scale(1)"));
    expect(screen.getByText("Line two")).toBeInTheDocument();
    expect(document.querySelector("[data-dag-ghost-blocks]")).toBeNull();
  });

  it("anchors a wide-but-short overview at its top-left, never vertically centered", async () => {
    const base = overviewFixture();
    const geometry: DagSceneGeometry = {
      ...base.geometry,
      nodes: {
        "issue:r1": { x: 0, y: 0, width: 280, height: 140 },
        "issue:r2": { x: 5720, y: 160, width: 280, height: 140 },
      },
      ports: {
        "issue:r1": { input: { x: 0, y: 70 }, output: { x: 280, y: 70 } },
        "issue:r2": { input: { x: 5720, y: 230 }, output: { x: 6000, y: 230 } },
      },
      routes: {
        [BUNDLE]: [
          { x: 280, y: 70 },
          { x: 3000, y: 70 },
          { x: 3000, y: 230 },
          { x: 5720, y: 230 },
        ],
      },
      width: 6000,
      height: 300,
    };
    harness({ ...base, geometry });
    await waitFor(() => expect(screen.getByText("Line one")).toBeInTheDocument());
    // Bounds (0,0,6000,300): the cross axis would fit at 0.75 — a line would
    // center it, but the overview must start at its top-left corner.
    await waitFor(() => expect(readTransform()).toBe("translate(24px,24px) scale(0.75)"));
  });

  it("anchors a huge focus scene at the readable zoom when the focused task is hidden", async () => {
    const line = lineFixture();
    const model = dagFocusCanvasModel(computeDagFocus(createDagModelIndex(makeGraph([
      makeNode("hidden", { status: "done", statusCategory: "done" }), makeNode("after"),
    ], [["hidden", "after"]])), "hidden"));
    const geometry: DagSceneGeometry = {
      nodes: { after: { x: 4000, y: 120, width: 248, height: 116 } },
      frames: {
        "focus-frame": { x: 3900, y: 40, width: 6000, height: 400, bands: [], stageMode: "labels" },
      },
      ports: { after: { input: { x: 4000, y: 178 }, output: { x: 4248, y: 178 } } },
      routes: {},
      segments: [],
      junctions: [],
      width: 9900,
      height: 440,
      quality: "fallback",
    };
    const { store, props, rerender, flow } = harness(line);
    await waitFor(() => expect(screen.getByText("T-T1")).toBeInTheDocument());
    rerender(
      <ViewStoreProvider store={store}><ReactFlowProvider><DagSceneCanvasInner
        {...props} level={{ kind: "focus", issueId: "hidden" }} model={model} plan={model.plan} geometry={geometry}
        focusRequest={{ id: "hidden", level: "focus", nonce: 1 }}
      /></ReactFlowProvider></ViewStoreProvider>,
    );
    await waitFor(() => {
      const viewport = flow().getViewport();
      expect(viewport.zoom).toBe(0.75);
      // The remaining scene starts at the left edge instead of shrinking away.
      expect(viewport.x).toBe(24 - 3900 * 0.75);
      // Bounds (3900,40,6000,400): the cross axis fits at 0.75, so a focus
      // scene centers it — never top-anchored like the overview.
      expect(viewport.y).toBe(450 - (40 + 200) * 0.75);
    });
    expect(store.getState().dagSelectedNodeId).toBeNull();
  });
});
describe("DagSceneCanvas lit-route masking (OL-451)", () => {
  /** A→C with M between them: the lit route crosses M's box (and its text). */
  function crossingFixture() {
    const graph = makeGraph(
      [
        makeNode("r1", { title: "Line one" }),
        makeNode("a", { parentIssueId: "r1" }),
        makeNode("m", { parentIssueId: "r1" }),
        makeNode("c", { parentIssueId: "r1" }),
      ],
      [{ id: "a-c", source: "a", target: "c" }],
    );
    const line = computeDagLine(createDagModelIndex(graph), "r1")!;
    const plan = dagLineLayoutInput(line);
    const geometry: DagSceneGeometry = {
      nodes: {
        a: { x: 60, y: 40, width: 248, height: 116 },
        m: { x: 360, y: 40, width: 248, height: 116 },
        c: { x: 660, y: 40, width: 248, height: 116 },
      },
      frames: {
        r1: { x: 0, y: 0, width: 980, height: 220, bands: [], stageMode: "labels" },
      },
      ports: {
        a: { input: { x: 60, y: 98 }, output: { x: 308, y: 98 } },
        m: { input: { x: 360, y: 98 }, output: { x: 608, y: 98 } },
        c: { input: { x: 660, y: 98 }, output: { x: 908, y: 98 } },
      },
      routes: { "a-c": [{ x: 308, y: 98 }, { x: 660, y: 98 }] },
      segments: [{ id: "s0", start: { x: 308, y: 98 }, end: { x: 660, y: 98 }, edgeIds: ["a-c"] }],
      junctions: [],
      width: 980,
      height: 220,
      quality: "elk",
    };
    return { model: { kind: "line" as const, line }, plan, geometry };
  }

  it("masks lit routes behind every card box so they cannot strike through text", async () => {
    const { store } = harness(crossingFixture());
    await waitFor(() => expect(nodeOf("a")).toBeTruthy());
    fireEvent.click(nodeOf("a"));
    expect(store.getState().dagSelectedNodeId).toBe("a");
    await waitFor(() => expect(litRouteGroups()).toBe(1));
    const cuts = new Map(
      [...document.querySelectorAll("[data-dag-route-mask-cut]")].map((el) => [
        el.getAttribute("data-dag-route-mask-cut"),
        el,
      ]),
    );
    // Every card and the frame header strip is cut out of the lit paint.
    for (const id of ["a", "m", "c", "r1"]) expect(cuts.has(id)).toBe(true);
    // The crossed card m: the cut covers its box (inset by 2).
    const mCut = cuts.get("m")!;
    expect(Number(mCut.getAttribute("x"))).toBe(362);
    expect(Number(mCut.getAttribute("y"))).toBe(42);
    expect(Number(mCut.getAttribute("width"))).toBe(244);
    expect(Number(mCut.getAttribute("height"))).toBe(112);
    const headerCut = cuts.get("r1")!;
    expect(Number(headerCut.getAttribute("height"))).toBe(76 - 4);
    // The lit group paints through that mask.
    const litGroup = document.querySelector("[data-dag-overlay-layer] > g[mask]")!;
    expect(litGroup.getAttribute("mask")).toContain("url(#");
    expect(litGroup.querySelector('[data-dag-lit-edge="a-c"]')).toBeTruthy();
  });

  it("drops the mask in the simplified view, where cards carry no text", async () => {
    const { flow } = harness(abxyFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    fireEvent.click(nodeOf("y"));
    await waitFor(() => expect(litRouteGroups()).toBe(2));
    expect(document.querySelector("[data-dag-route-mask-cut]")).not.toBeNull();
    await flow().setViewport({ x: 0, y: 0, zoom: 0.3 });
    await waitFor(() => expect(document.querySelector("[data-dag-ghost-blocks]")).toBeTruthy());
    expect(litRouteGroups()).toBe(2);
    expect(document.querySelector("[data-dag-route-mask-cut]")).toBeNull();
  });

  it("declares both overlay mask regions as the culling window (far-pan regression)", async () => {
    const { flowStore } = harness(crossingFixture());
    await waitFor(() => expect(nodeOf("a")).toBeTruthy());
    fireEvent.click(nodeOf("a"));
    await waitFor(() => expect(litRouteGroups()).toBe(1));
    const state = flowStore().getState();
    const win = dagCullBounds(
      dagCullBoundsKey(state.transform, { width: state.width, height: state.height }),
    )!;
    expect(win).toBeTruthy();
    // A userSpaceOnUse mask without an explicit region defaults to
    // -10%/-10%/120%/120% of the viewport — ABSOLUTE coordinates that do not
    // follow the windowed viewBox origin, so a pan one screen past the
    // canvas origin clips every masked paint (lit routes here, the dim
    // overlay since OL-284). The region must be the culling window itself.
    const masks = [...document.querySelectorAll("[data-dag-overlay-layer] mask")];
    const routeMask = masks.find((el) => el.querySelector("[data-dag-route-mask-cut]"))!;
    const dimMask = masks.find((el) => el.querySelector("[data-dag-dim-hole]"))!;
    for (const mask of [routeMask, dimMask]) {
      expect(mask.hasAttribute("x")).toBe(true);
      expect(mask.hasAttribute("y")).toBe(true);
      expect(mask.hasAttribute("width")).toBe(true);
      expect(mask.hasAttribute("height")).toBe(true);
      expect([
        Number(mask.getAttribute("x")),
        Number(mask.getAttribute("y")),
        Number(mask.getAttribute("width")),
        Number(mask.getAttribute("height")),
      ]).toEqual([win.x0, win.y0, win.x1 - win.x0, win.y1 - win.y0]);
    }
  });
});
