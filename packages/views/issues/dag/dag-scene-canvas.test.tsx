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
import { computeDagLine, computeDagOverview, createDagModelIndex } from "@multica/core/issues/dag";
import { renderWithI18n } from "../../test/i18n";
import { DagSceneCanvasInner, type DagSceneCanvasProps } from "./dag-scene-canvas";
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

// ---- Stage 10: click/hover highlight, bus click, zoom degradation -----------

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

  it("hover lights the card's in/out edges and restores on leave", async () => {
    const { store } = harness(abxyFixture());
    await waitFor(() => expect(nodeOf("y")).toBeTruthy());
    fireEvent.mouseEnter(nodeOf("y"));
    await waitFor(() => expect(litRouteGroups()).toBe(2));
    expect(baseGroupClass()).toContain("opacity-15");
    expect(cardLit("x")).toBe(false);
    // Hover is transient: no selection is written.
    expect(store.getState().dagSelectedNodeId).toBeNull();
    fireEvent.mouseLeave(nodeOf("y"));
    await waitFor(() => expect(litRouteGroups()).toBe(0));
    expect(baseGroupClass()).not.toContain("opacity-15");
    expect(dimOverlay()).toBeNull();
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
