/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, setApiInstance, type ApiClient } from "@multica/core/api";
import { viewStoreSlice, type FilterSnapshot, type IssueViewState } from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { ViewBaselineProvider } from "../surface/view-baseline-context";
import type { IssueViewBaseline } from "@multica/core/issue-views/baseline";
import type { IssueTableQuerySpec } from "@multica/core/types";
import ELK from "elkjs/lib/elk.bundled.js";
import { layoutDagScene } from "./dag-scene-layout";
import type { DagSceneRequest, DagSceneResponse, DagSceneRunner } from "./dag-scene-runner";
import { DagView, useDagEmptyBusSelectionReset } from "./dag-view";
import type { DagSceneCanvasProps } from "./dag-scene-canvas";
import type { DagToolbarProps } from "./dag-toolbar";
import { graphNode as makeNode, issueGraph as makeGraph } from "./dag-test-fixtures";

const mockTranslate = vi.hoisted(() =>
  vi.fn((selector: (resources: unknown) => unknown, params?: unknown, namespace?: string) => {
    const path: string[] = [];
    const proxy: unknown = new Proxy({}, {
      get: (_, prop) => {
        path.push(String(prop));
        return proxy;
      },
    });
    selector(proxy);
    return `${namespace}:${path.join(".")}` + (params ? ` ${JSON.stringify(params)}` : "");
  }),
);

vi.mock("../../i18n", () => ({
  useLocale: () => "en",
  useT: (namespace: string) => ({
    t: (selector: (resources: unknown) => unknown, params?: unknown) =>
      mockTranslate(selector, params, namespace),
    i18n: { language: "en" },
  }),
}));

const mockPush = vi.hoisted(() => vi.fn());
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: mockPush, pathname: "/" }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () => ({
    colorOf: () => null,
    isPending: false,
    isError: false,
    retry: vi.fn(),
  }),
}));

vi.mock("@multica/core/paths", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/paths")>("@multica/core/paths");
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("test") };
});

vi.mock("./dag-issue-actions", () => ({
  useDagIssueSelection: () => ({
    issue: null,
    actions: { openEditDependencies: vi.fn(), updateField: vi.fn() },
    detailFailed: false,
    retryDetail: vi.fn(),
  }),
  DagAssignAction: ({ issue }: { issue: unknown }) => <button disabled={!issue}>Assign</button>,
}));

const canvasSpy = vi.hoisted(() => vi.fn<(props: DagSceneCanvasProps) => void>());
vi.mock("./dag-scene-canvas", () => ({
  default: (props: DagSceneCanvasProps) => {
    canvasSpy(props);
    return <div data-testid="dag-scene-canvas" />;
  },
}));

const toolbarSpy = vi.hoisted(() => vi.fn<(props: DagToolbarProps) => void>());
vi.mock("./dag-toolbar", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./dag-toolbar")>();
  return {
    DagToolbar: (props: DagToolbarProps) => {
      toolbarSpy(props);
      return <mod.DagToolbar {...props} />;
    },
  };
});

const executeCalls = vi.hoisted(() => ({ count: 0, bypassed: 0 }));

function syncSceneRunner(): DagSceneRunner {
  const elk = new ELK();
  return {
    prepare: () => {},
    cancel: () => {},
    dispose: () => {},
    execute: (input: DagSceneRequest["input"], done: (response: DagSceneResponse) => void, bypassCache?: boolean) => {
      executeCalls.count++;
      if (bypassCache) executeCalls.bypassed++;
      void layoutDagScene(input, elk).then((result) => done({ requestId: 0, result }));
    },
  };
}

const spec: IssueTableQuerySpec = {
  scope: { kind: "workspace" },
  filters: {},
  sort: { field: "position", direction: "asc" },
};

/** Two lines with a cross dependency, plus a standalone upstream task. */
function fixtureGraph() {
  return makeGraph(
    [
      makeNode("r1", { title: "Line one" }),
      makeNode("t1", { parentIssueId: "r1" }),
      makeNode("r2", { title: "Line two" }),
      makeNode("b1", { parentIssueId: "r2" }),
      makeNode("solo"),
    ],
    [
      { id: "e-b1", source: "b1", target: "t1" },
      { id: "e-solo", source: "solo", target: "t1" },
    ],
  );
}

const clients: QueryClient[] = [];

interface SetupOptions {
  hasActiveFilters?: boolean;
  baseline?: IssueViewBaseline | null;
  runnerFactory?: () => DagSceneRunner;
  canvasLoader?: () => Promise<typeof import("./dag-scene-canvas")>;
}

function setup(
  graph: ReturnType<typeof makeGraph>,
  seed?: (store: StoreApi<IssueViewState>) => void,
  opts: SetupOptions = {},
) {
  setApiInstance({ getIssueGraph: vi.fn().mockResolvedValue(graph) } as unknown as ApiClient);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const store = createStore<IssueViewState>()(viewStoreSlice);
  seed?.(store);
  const view = render(
    <QueryClientProvider client={client}>
      <ViewStoreProvider store={store}>
        <ViewBaselineProvider baseline={opts.baseline ?? null}>
          <DagView
            spec={spec}
            hasActiveFilters={opts.hasActiveFilters ?? false}
            sceneRunnerFactory={opts.runnerFactory ?? syncSceneRunner}
            canvasLoader={opts.canvasLoader}
          />
        </ViewBaselineProvider>
      </ViewStoreProvider>
    </QueryClientProvider>,
  );
  return { store, client, ...view };
}

async function waitForCanvas(): Promise<DagSceneCanvasProps> {
  await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
  return canvasSpy.mock.calls.at(-1)![0];
}

beforeEach(() => {
  canvasSpy.mockClear();
  toolbarSpy.mockClear();
  mockPush.mockClear();
  executeCalls.count = 0;
  executeCalls.bypassed = 0;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe("DagView level navigation", () => {
  it("auto-enters when the overview holds exactly one line", async () => {
    const graph = makeGraph([makeNode("root"), makeNode("child", { parentIssueId: "root" })]);
    const { store } = setup(graph);
    await waitFor(() => expect(store.getState().dagLineId).toBe("root"));
    const props = await waitForCanvas();
    expect(props.level).toEqual({ kind: "line", lineId: "root" });
    expect(toolbarSpy.mock.calls.at(-1)![0].level).toEqual({ kind: "line", lineId: "root" });
  });

  it("does not auto-enter once the user has pinned the overview", async () => {
    const graph = makeGraph([makeNode("root"), makeNode("child", { parentIssueId: "root" })]);
    const { store } = setup(graph, (s) => s.setState({ dagOverviewPinned: true }));
    await waitForCanvas();
    expect(store.getState().dagLineId).toBeNull();
  });

  it("stays on the overview when several cards are visible", async () => {
    const { store } = setup(fixtureGraph());
    const props = await waitForCanvas();
    expect(store.getState().dagLineId).toBeNull();
    expect(props.level).toEqual({ kind: "overview" });
    expect(props.model.kind).toBe("overview");
  });

  it("falls back to the overview when the saved line no longer exists", async () => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "ghost" }));
    const props = await waitForCanvas();
    await waitFor(() => expect(store.getState().dagLineId).toBeNull());
    expect(props.level).toEqual({ kind: "overview" });
  });

  it("restores a saved line directly, without detouring through the overview", async () => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1" }));
    const props = await waitForCanvas();
    expect(store.getState().dagLineId).toBe("r1");
    expect(props.level).toEqual({ kind: "line", lineId: "r1" });
    expect(props.model.kind).toBe("line");
  });

  it("returns to the overview selecting the line that was left", async () => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1" }));
    await waitForCanvas();
    act(() => toolbarSpy.mock.calls.at(-1)![0].onExitLine());
    await waitFor(() => expect(store.getState().dagLineId).toBeNull());
    expect(store.getState().dagOverviewPinned).toBe(true);
    expect(store.getState().dagSelectedNodeId).toBe("issue:r1");
  });

  it("jumps from an external card into its line, or back to the overview for a standalone", async () => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1" }));
    let props = await waitForCanvas();
    expect(props.model.kind === "line" && props.model.line.upstream.length).toBe(2);
    act(() => props.onExternalJump({ id: "r2", kind: "line" } as never, "upstream"));
    await waitFor(() => expect(store.getState().dagLineId).toBe("r2"));
    act(() => store.getState().setDagLineId("r1"));
    props = await waitForCanvas();
    act(() => props.onExternalJump({ id: "solo", kind: "issue" } as never, "upstream"));
    await waitFor(() => expect(store.getState().dagLineId).toBeNull());
    expect(store.getState().dagOverviewPinned).toBe(true);
    expect(store.getState().dagSelectedNodeId).toBe("solo");
    const latest = canvasSpy.mock.calls.at(-1)![0];
    expect(latest.focusRequest).toMatchObject({ id: "solo", level: "overview" });
  });

  it("opens the independent grid as a line level", async () => {
    const graph = makeGraph([
      makeNode("r1"),
      makeNode("t1", { parentIssueId: "r1" }),
      makeNode("free"),
    ]);
    const { store } = setup(graph);
    await waitForCanvas();
    act(() => toolbarSpy.mock.calls.at(-1)![0].onEnterLine("independent:root"));
    await waitFor(() => expect(store.getState().dagLineId).toBe("independent:root"));
    const props = await waitForCanvas();
    expect(props.model.kind).toBe("independent");
    if (props.model.kind === "independent") {
      expect(props.model.tasks.map((task) => task.issue.id)).toEqual(["free"]);
    }
  });

  it("falls back to the overview when the independent grid no longer exists", async () => {
    // Two lines: no independent card, no auto-entry. The stored level is invalid.
    const graph = makeGraph([
      makeNode("r1"),
      makeNode("t1", { parentIssueId: "r1" }),
      makeNode("r2"),
      makeNode("t2", { parentIssueId: "r2" }),
    ]);
    const { store } = setup(graph, (s) => s.setState({ dagLineId: "independent:root" }));
    await waitForCanvas();
    await waitFor(() => expect(store.getState().dagLineId).toBeNull());
    const props = await waitForCanvas();
    expect(props.level).toEqual({ kind: "overview" });
    expect(props.model.kind).toBe("overview");
  });

  it("never issues the graph request for unsupported scopes", async () => {
    const getIssueGraph = vi.fn().mockResolvedValue(fixtureGraph());
    setApiInstance({ getIssueGraph } as unknown as ApiClient);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const store = createStore<IssueViewState>()(viewStoreSlice);
    const mySpec: IssueTableQuerySpec = {
      scope: { kind: "my", relation: "any" },
      filters: {},
      sort: { field: "position", direction: "asc" },
    };
    // The DAG is never offered for these scopes; the guard mirrors
    // useDagSurfaceGraph so a stray mount cannot crash the surface.
    render(
      <QueryClientProvider client={client}>
        <ViewStoreProvider store={store}>
          <DagView spec={mySpec} hasActiveFilters={false} sceneRunnerFactory={syncSceneRunner} />
        </ViewStoreProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockTranslate).toHaveBeenCalled());
    expect(getIssueGraph).not.toHaveBeenCalled();
  });
});

describe("DagView display switches", () => {
  it("toggling satisfied dependencies repaints the overview without a new layout", async () => {
    const done = fixtureGraph();
    // Make e-solo satisfied so it becomes an overlay when the switch is on.
    done.nodes = done.nodes.map((node) =>
      node.id === "solo" ? { ...node, status: "done", statusCategory: "done" } : node,
    );
    const { store } = setup(done);
    await waitForCanvas();
    const layouts = executeCalls.count;
    act(() => store.getState().toggleDagShowSatisfiedDependencies());
    await waitFor(() =>
      expect(toolbarSpy.mock.calls.at(-1)![0].selection).toBeNull(),
    );
    await waitForCanvas();
    expect(store.getState().dagShowSatisfiedDependencies).toBe(true);
    expect(executeCalls.count).toBe(layouts);
  });

  it("drops satisfied external cards from the line level while the switch is off", async () => {
    const graph = fixtureGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.id === "solo" ? { ...node, status: "done", statusCategory: "done" } : node,
    );
    const { store } = setup(graph, (s) => s.setState({ dagLineId: "r1" }));
    const props = await waitForCanvas();
    if (props.model.kind !== "line") throw new Error("expected line model");
    // Off by default: solo's satisfied dependency earns no side card.
    expect(props.model.line.upstream.map((g) => g.id)).toEqual(["r2"]);
    act(() => store.getState().toggleDagShowSatisfiedDependencies());
    await waitFor(() => {
      const latest = canvasSpy.mock.calls.at(-1)![0];
      if (latest.model.kind !== "line") throw new Error("expected line model");
      expect(latest.model.line.upstream.map((g) => g.id).sort()).toEqual(["r2", "solo"]);
    });
  });

  it("labels the breadcrumb with the open line and exposes the fallback retry", async () => {
    setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1" }));
    await waitForCanvas();
    const toolbar = toolbarSpy.mock.calls.at(-1)![0];
    expect(toolbar.level).toEqual({ kind: "line", lineId: "r1" });
    expect(toolbar.lineHeader).toMatchObject({ identifier: "T-R1", title: "Line one" });
    expect(toolbar.isFallback).toBe(false);
  });
});


describe("DagView error and refresh handling", () => {
  function setupErroring(getIssueGraph: ReturnType<typeof vi.fn>, baseline?: IssueViewBaseline | null) {
    setApiInstance({ getIssueGraph } as unknown as ApiClient);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const store = createStore<IssueViewState>()(viewStoreSlice);
    const view = render(
      <QueryClientProvider client={client}>
        <ViewStoreProvider store={store}>
          <ViewBaselineProvider baseline={baseline ?? null}>
            <DagView spec={spec} hasActiveFilters={false} sceneRunnerFactory={syncSceneRunner} />
          </ViewBaselineProvider>
        </ViewStoreProvider>
      </QueryClientProvider>,
    );
    return { store, client, ...view };
  }

  it.each([404, 405])(
    "maps %s to capability-unavailable without a retry affordance",
    async (status) => {
      setupErroring(vi.fn().mockRejectedValue(new ApiError("Not found", status, "not_found")));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("dag:error_unavailable"),
      );
      expect(screen.queryByRole("button", { name: /dag:error_retry/ })).toBeNull();
      expect(screen.queryByTestId("dag-scene-canvas")).toBeNull();
    },
  );

  it("maps 504 to a retryable timeout", async () => {
    const getIssueGraph = vi.fn().mockRejectedValue(new ApiError("Timeout", 504, "graph_query_timeout"));
    setupErroring(getIssueGraph);
    // The query layer retries a 504 once before surfacing it.
    await waitFor(
      () => expect(screen.getByRole("alert")).toHaveTextContent("dag:error_timeout"),
      { timeout: 5000 },
    );
    const before = getIssueGraph.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /dag:error_retry/ }));
    await waitFor(() => expect(getIssueGraph.mock.calls.length).toBeGreaterThan(before));
  });

  it.each([403, 404, 405, 422])(
    "hides the cached graph after access loss (%s) instead of showing it stale",
    async (status) => {
      const getIssueGraph = vi
        .fn()
        .mockResolvedValueOnce(fixtureGraph())
        .mockRejectedValue(new ApiError("Access lost", status, "denied"));
      const { client } = setupErroring(getIssueGraph);
      await waitForCanvas();
      await act(async () => {
        await client.invalidateQueries();
      });
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          status === 403
            ? "dag:error_forbidden"
            : status === 422
              ? "dag:error_unverified"
              : "dag:error_unavailable",
        ),
      );
      expect(screen.queryByTestId("dag-scene-canvas")).toBeNull();
    },
  );

  it("keeps a refresh failure on the last snapshot with the stale banner and a retry", async () => {
    const getIssueGraph = vi
      .fn()
      .mockResolvedValueOnce(fixtureGraph())
      .mockRejectedValue(new Error("boom"));
    const { client } = setupErroring(getIssueGraph);
    await waitForCanvas();
    await act(async () => {
      await client.invalidateQueries();
    });
    // A transient error is retried once by the query layer before the banner.
    await waitFor(
      () => expect(screen.getByRole("alert").textContent).toContain("dag:stale_banner"),
      { timeout: 5000 },
    );
    // The painted scene stays usable while the refresh is broken.
    expect(screen.getByTestId("dag-scene-canvas")).toBeTruthy();
    const before = getIssueGraph.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /dag:error_retry/ }));
    await waitFor(() => expect(getIssueGraph.mock.calls.length).toBeGreaterThan(before));
  });

  it("shows the filtered-empty state and clears filters from it", async () => {
    const { store } = setup(makeGraph([]), (s) => s.getState().toggleStatusFilter("todo"), {
      hasActiveFilters: true,
    });
    await waitFor(() => expect(screen.getByText(/dag:empty_title/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /filtered_empty\.clear_button/ }));
    expect(store.getState().statusFilters).toEqual([]);
  });

  it("clears filters back to the open view's baseline instead of empty", async () => {
    const raw: FilterSnapshot = {
      statusFilters: ["done"],
      priorityFilters: [],
      assigneeFilters: [],
      includeNoAssignee: false,
      creatorFilters: [],
      projectFilters: [],
      includeNoProject: false,
      projectStatusFilters: [],
      labelFilters: [],
      propertyFilters: {},
    };
    const baseline: IssueViewBaseline = {
      status: new Set(["done"]),
      priority: new Set(),
      assignee: new Set(),
      includeNoAssignee: false,
      creator: new Set(),
      project: new Set(),
      includeNoProject: false,
      projectStatus: new Set(),
      label: new Set(),
      property: new Map(),
      raw,
    };
    const { store } = setup(makeGraph([]), (s) => s.getState().toggleStatusFilter("todo"), {
      hasActiveFilters: true,
      baseline,
    });
    await waitFor(() => expect(screen.getByText(/dag:empty_title/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /filtered_empty\.clear_button/ }));
    expect(store.getState().statusFilters).toEqual(["done"]);
  });
});

describe("DagView layout failures", () => {
  function failingRunner(fail: (input: DagSceneRequest["input"], call: number) => boolean) {
    let calls = 0;
    const elk = new ELK();
    const runner: DagSceneRunner = {
      prepare: () => {},
      cancel: () => {},
      dispose: () => {},
      execute: (input, done) => {
        calls++;
        if (fail(input, calls)) return done({ requestId: 0, error: "layout failed" });
        void layoutDagScene(input, elk).then((result) => done({ requestId: 0, result }));
      },
    };
    return { runner, calls: () => calls };
  }

  it("surfaces a first-layout failure full-page and retries it", async () => {
    const failing = failingRunner((_input, call) => call === 1);
    setup(fixtureGraph(), undefined, { runnerFactory: () => failing.runner });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("dag:layout_error"),
    );
    expect(screen.queryByTestId("dag-scene-canvas")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /dag:error_retry/ }));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(failing.calls()).toBe(2);
  });

  it("keeps the painted scene under a banner when a replacement layout fails", async () => {
    let lineAttempts = 0;
    const failing = failingRunner((input) => input.kind === "line" && ++lineAttempts === 1);
    const { store } = setup(fixtureGraph(), undefined, { runnerFactory: () => failing.runner });
    await waitForCanvas();
    act(() => store.getState().setDagLineId("r1"));
    // The overview stays painted under the error banner.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("dag:layout_error"),
    );
    expect(screen.getByTestId("dag-scene-canvas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dag:error_retry/ }));
    await waitFor(() =>
      expect(canvasSpy.mock.calls.at(-1)![0].level).toEqual({ kind: "line", lineId: "r1" }),
    );
  });

  it("surfaces a canvas module load failure and recovers on retry", async () => {
    let attempts = 0;
    const canvasLoader = () =>
      ++attempts === 1
        ? Promise.reject(new Error("chunk gone"))
        : import("./dag-scene-canvas");
    setup(fixtureGraph(), undefined, { canvasLoader });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("dag:layout_error"),
    );
    expect(screen.queryByTestId("dag-scene-canvas")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /dag:error_retry/ }));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(attempts).toBe(2);
  });
});

describe("DagView detail navigation", () => {
  it("saves the live viewport under the painted line level when opening an issue detail", async () => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1" }));
    await waitForCanvas();
    act(() =>
      canvasSpy.mock.calls.at(-1)![0].registerCanvasApi?.({
        getViewport: () => ({ x: -47, y: 93, zoom: 1.35 }),
      }),
    );
    act(() => toolbarSpy.mock.calls.at(-1)![0].onOpenIssue("t1"));
    expect(store.getState().dagViewports["line:r1"]).toEqual({ x: -47, y: 93, zoom: 1.35 });
    expect(mockPush).toHaveBeenCalledWith("/test/issues/t1");
  });

  it("hands focus-frame requests to the canvas as a line-level focus request", async () => {
    setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1" }));
    await waitForCanvas();
    act(() => toolbarSpy.mock.calls.at(-1)![0].onFocusFrame("frame-9"));
    await waitFor(() =>
      expect(canvasSpy.mock.calls.at(-1)![0].focusRequest).toEqual({
        id: "frame-9",
        level: "line",
        nonce: 1,
      }),
    );
  });
});

describe("DagView focus mode", () => {
  it("offers focus for tasks, not overview line cards, and keeps Open detail first", async () => {
    const { store } = setup(fixtureGraph());
    await waitForCanvas();
    act(() => store.getState().setDagSelectedNodeId("issue:r1"));
    expect(screen.queryByRole("button", { name: "dag:focus_mode" })).toBeNull();
    act(() => store.getState().enterDagLine("r1"));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level.kind).toBe("line"));
    act(() => store.getState().setDagSelectedNodeId("t1"));
    const actions = within(screen.getByRole("region", { name: "dag:selection_region_label" })).getAllByRole("button");
    expect(actions[0]).toHaveTextContent("dag:open_detail");
    expect(screen.getByRole("button", { name: "dag:focus_mode" })).toBeVisible();
  });

  it.each([null, "r1"])("exits through the line breadcrumb to the entry level %s and its saved viewport", async (lineId) => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: lineId }));
    await waitForCanvas();
    const viewport = { x: -120, y: 58, zoom: 0.9 };
    act(() => canvasSpy.mock.calls.at(-1)![0].registerCanvasApi?.({ getViewport: () => viewport }));
    act(() => toolbarSpy.mock.calls.at(-1)![0].onEnterFocus!("t1"));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level.kind).toBe("focus"));
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: /T-R1\s*Line one/ }));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level.kind).toBe(lineId ? "line" : "overview"));
    expect(store.getState().dagLineId).toBe(lineId);
    expect(store.getState().dagFocusIssueId).toBeNull();
    expect(store.getState().dagViewports[lineId ? `line:${lineId}` : "overview"]).toEqual(viewport);
    expect(store.getState().dagViewports["focus:t1"]).toBeUndefined();
  });

  it.each([null, "r1", "independent:root"])("All task lines exits focus from %s directly to the overview", async (lineId) => {
    const graph = fixtureGraph();
    graph.nodes.push(makeNode("free"));
    const { store } = setup(graph, (s) => s.setState({ dagLineId: lineId, dagFocusIssueId: lineId === "independent:root" ? "free" : "t1", dagViewports: { overview: { x: 12, y: 34, zoom: 0.7 } } }));
    await waitForCanvas();
    fireEvent.click(screen.getByRole("button", { name: "dag:all_lines" }));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level).toEqual({ kind: "overview" }));
    expect(store.getState().dagFocusIssueId).toBeNull();
    expect(store.getState().dagLineId).toBeNull();
    expect(store.getState().dagViewports.overview).toEqual({ x: 12, y: 34, zoom: 0.7 });
  });

  it("locates the selected task's frame fragment in focus and omits redundant entry and Q11 controls", async () => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1", dagFocusIssueId: "t1" }));
    const focused = await waitForCanvas();
    act(() => store.getState().setDagSelectedNodeId("t1"));
    fireEvent.click(screen.getByRole("button", { name: "dag:more_actions" }));
    expect(document.querySelector("[data-dag-enter-focus]")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "dag:focus_line" }));
    const fragment = focused.plan.input.frames.find((frame) => frame.modelId === "r1" && frame.side === "current")!;
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].focusRequest).toMatchObject({ id: fragment.id, level: "focus" }));
    expect(screen.queryByRole("button", { name: "dag:focus_mode" })).toBeNull();
    expect(document.querySelector("[data-dag-focus-hidden]")).toBeNull();
  });

  it("omits a line breadcrumb for a standalone task focused from the overview", async () => {
    setup(fixtureGraph(), (s) => s.setState({ dagFocusIssueId: "solo" }));
    await waitForCanvas();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual(["dag:all_lines", ""]);
    expect(nav).toHaveTextContent('dag:focus_breadcrumb {"identifier":"T-SOLO"}');
  });

  it("clears an unavailable-task notice on navigation without bringing it back later", async () => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1", dagFocusIssueId: "deleted" }));
    await waitFor(() => expect(screen.getByText("dag:focus_unavailable")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "dag:all_lines" }));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level.kind).toBe("overview"));
    expect(screen.queryByText("dag:focus_unavailable")).toBeNull();
    act(() => toolbarSpy.mock.calls.at(-1)![0].onEnterLine("r1"));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level.kind).toBe("line"));
    expect(screen.queryByText("dag:focus_unavailable")).toBeNull();
    expect(store.getState().dagLineId).toBe("r1");
  });

  it.each([null, "r1"])("enters focus from %s and returns with the live viewport saved", async (lineId) => {
    const { store } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: lineId }));
    await waitForCanvas();
    const viewport = { x: -100, y: 42, zoom: 0.8 };
    act(() => canvasSpy.mock.calls.at(-1)![0].registerCanvasApi?.({ getViewport: () => viewport }));
    act(() => toolbarSpy.mock.calls.at(-1)![0].onEnterFocus!("t1"));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level).toEqual({ kind: "focus", issueId: "t1" }));
    const focused = canvasSpy.mock.calls.at(-1)![0];
    expect(focused.model.kind).toBe("focus");
    expect(focused.focusRequest).toMatchObject({ level: "focus", id: "t1" });
    expect(store.getState().dagViewports[lineId ? `line:${lineId}` : "overview"]).toEqual(viewport);
    act(() => toolbarSpy.mock.calls.at(-1)![0].onExitFocus!());
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].level.kind).toBe(lineId ? "line" : "overview"));
    expect(store.getState().dagLineId).toBe(lineId);
    expect(store.getState().dagFocusIssueId).toBeNull();
  });

  it("restores a saved focus directly and exits when its seed leaves the graph", async () => {
    const { store, client } = setup(fixtureGraph(), (s) => s.setState({ dagLineId: "r1", dagFocusIssueId: "t1" }));
    const props = await waitForCanvas();
    expect(props.level).toEqual({ kind: "focus", issueId: "t1" });
    setApiInstance({ getIssueGraph: vi.fn().mockResolvedValue(makeGraph([makeNode("r1"), makeNode("remaining", { parentIssueId: "r1" })])) } as unknown as ApiClient);
    await act(async () => { await client.invalidateQueries(); });
    await waitFor(() => expect(store.getState().dagFocusIssueId).toBeNull());
    expect(store.getState().dagLineId).toBe("r1");
    expect(screen.getByText("dag:focus_unavailable")).toBeTruthy();
  });

  it("keeps a hidden seed hidden, counts Q11 once, and reveals it only through Show completed", async () => {
    const graph = makeGraph([
      makeNode("before", { status: "done", statusCategory: "done" }),
      makeNode("seed", { status: "done", statusCategory: "done" }), makeNode("after"),
    ], [["before", "seed"], ["seed", "after"]]);
    const { store } = setup(graph, (s) => s.setState({ dagFocusIssueId: "seed" }));
    await waitForCanvas();
    expect(store.getState().dagFocusIssueId).toBe("seed");
    expect(toolbarSpy.mock.calls.at(-1)![0].focusHiddenCount).toBe(2);
    expect(canvasSpy.mock.calls.at(-1)![0].geometry.nodes.seed).toBeUndefined();
    expect(screen.getByText("dag:focus_current_hidden")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dag:show_completed_enable" }));
    await waitFor(() => expect(canvasSpy.mock.calls.at(-1)![0].geometry.nodes.seed).toBeDefined());
    expect(toolbarSpy.mock.calls.at(-1)![0].focusHiddenCount).toBe(0);
    expect(screen.queryByText("dag:focus_current_hidden")).toBeNull();
  });
});

describe("useDagEmptyBusSelectionReset", () => {
  it("clears the bus selection once its rows empty out, and only then", () => {
    const store = createStore<IssueViewState>()(viewStoreSlice);
    store.getState().setDagSelectedDependencyIds(["dep-1"]);
    const row = {
      id: "dep-1",
      sourceId: "a",
      sourceLabel: "A",
      sourceTitle: "a",
      targetId: "b",
      targetLabel: "B",
      targetTitle: "b",
    };
    const { rerender } = renderHook(
      ({ rows }: { rows: import("./dag-selection-bus").DagBusSelectionItem[] | null }) =>
        useDagEmptyBusSelectionReset(store, rows),
      { initialProps: { rows: [row] as import("./dag-selection-bus").DagBusSelectionItem[] | null } },
    );
    expect(store.getState().dagSelectedDependencyIds).toEqual(["dep-1"]);
    // Everything satisfied while the switch is off: the dropdown would show
    // "汇总 0 条依赖", so the selection clears instead.
    rerender({ rows: [] });
    expect(store.getState().dagSelectedDependencyIds).toBeNull();
  });
});
