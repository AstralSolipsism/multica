/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, type IssueGraph, type IssueGraphNode } from "@multica/core/api";
import { viewStoreSlice, type IssueViewState } from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import ELK from "elkjs/lib/elk.bundled.js";
import { layoutDagProjection, type DagLayoutRequest, type DagLayoutResponse } from "./dag-layout";
import { DagView, type DagGraphQueryState } from "./dag-view";
import type { DagCanvasProps } from "./dag-canvas";
import { computeDagProjection } from "./dag-projection";
import { DagFlowGroupCard } from "./dag-group";
import { DagPortUpdateProvider } from "./dag-ports";
import { ReactFlowProvider } from "@xyflow/react";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  // jsdom does not measure SVG/DOM geometry; dedicated ports tests cover batching.
  useUpdateNodeInternals: () => () => undefined,
}));

// t($ => $.path.to.key, params) → "namespace:path.to.key {params}" so assertions can
// pin the exact locale key each state renders.
const mockTranslate = vi.hoisted(() =>
  vi.fn((selector: (resources: unknown) => unknown, params?: unknown, namespace?: string) => {
    const path: string[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get: (_, prop) => {
          path.push(String(prop));
          return proxy;
        },
      },
    );
    selector(proxy);
    return `${namespace}:${path.join(".")}` + (params ? ` ${JSON.stringify(params)}` : "");
  }),
);

vi.mock("../../i18n", () => ({
  useLocale: () => "en",
  useT: (namespace: string) => ({
    t: (selector: (resources: unknown) => unknown, params?: unknown) => mockTranslate(selector, params, namespace),
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
  return {
    ...actual,
    useWorkspacePaths: () => actual.paths.workspace("test"),
  };
});

const canvasSpy = vi.hoisted(() => vi.fn<(props: DagCanvasProps) => void>());
vi.mock("./dag-canvas", () => ({
  default: (props: DagCanvasProps) => {
    canvasSpy(props);
    return <div data-testid="dag-canvas" />;
  },
}));

function syncLayoutRunner() {
  return {
    execute(request: DagLayoutRequest, onDone: (response: DagLayoutResponse) => void) {
      const positions: DagLayoutResponse["positions"] = {};
      request.nodes.forEach((node, index) => {
        positions[node.id] = { x: index * 10, y: index * 10 };
      });
      onDone({
        requestId: request.requestId,
        positions,
        groups: {},
        routes: {},
        ports: {},
        elapsedMs: 1,
      });
    },
    prepare: vi.fn(),
    terminate: vi.fn(),
  };
}

const layoutEngine = new ELK();
function realLayoutRunner() {
  return {
    execute(request: DagLayoutRequest, onDone: (response: DagLayoutResponse) => void) {
      void layoutDagProjection(
        request.nodes,
        request.edges,
        request.direction,
        request.groups,
        layoutEngine,
      ).then(
        (result) => onDone({ ...result, requestId: request.requestId, elapsedMs: 1 }),
        (error: Error) =>
          onDone({
            requestId: request.requestId,
            positions: {},
            groups: {},
            routes: {},
            ports: {},
            elapsedMs: 1,
            error: error.message,
          }),
      );
    },
    prepare: vi.fn(),
    terminate: vi.fn(),
  };
}

function makeNode(id: string, partial: Partial<IssueGraphNode> = {}): IssueGraphNode {
  return {
    id,
    identifier: `T-${id.toUpperCase()}`,
    title: `Task ${id}`,
    status: "todo",
    statusCategory: "todo",
    revision: 1,
    parentIssueId: null,
    hasRestrictedParent: false,
    projectId: null,
    stage: null,
    priority: "none",
    assignee: null,
    role: "match",
    runSummary: {
      queued: 0,
      dispatched: 0,
      running: 0,
      waitingLocalDirectory: 0,
      capturedAt: "2026-09-10T00:00:00Z",
    },
    dependencySummary: {
      visibleUnsatisfiedCount: 0,
      hasRestrictedBlockers: false,
      dependencyVersion: `v-${id}`,
    },
    ...partial,
  };
}

function makeGraph(
  nodes: IssueGraphNode[],
  edges: { id: string; source: string; target: string }[] = [],
): IssueGraph {
  return {
    schemaVersion: 1,
    snapshotId: "snap-1",
    topologyId: "topo-1",
    capturedAt: "2026-09-10T00:00:00Z",
    complete: true,
    scope: { type: "workspace", projectId: null },
    focusIssueId: null,
    matchedCount: nodes.length,
    contextCount: 0,
    nodes,
    edges: edges.map((e) => ({
      sourceEdgeId: e.id,
      source: e.source,
      target: e.target,
      type: "blocked_by" as const,
    })),
    projects: [{ id: "proj-1", title: "Account" }],
    hasRestrictedContext: false,
  };
}

function graphQuery(partial: Partial<DagGraphQueryState>): DagGraphQueryState {
  return {
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    isStale: false,
    refetch: vi.fn(),
    ...partial,
  };
}

describe("DagView", () => {
  let qc: QueryClient;
  let store: StoreApi<IssueViewState>;

  function renderDagView(
    query: DagGraphQueryState,
    hasActiveFilters = false,
    layoutRunnerFactory = syncLayoutRunner,
  ) {
    return render(
      <QueryClientProvider client={qc}>
        <ViewStoreProvider store={store}>
          <DagView
            graphQuery={query}
            hasActiveFilters={hasActiveFilters}
            membershipComplete={!hasActiveFilters}
            layoutRunnerFactory={layoutRunnerFactory}
          />
        </ViewStoreProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    store = createStore<IssueViewState>()(viewStoreSlice);
    canvasSpy.mockClear();
    mockTranslate.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a loading state until the first complete graph arrives", () => {
    renderDagView(graphQuery({ isPending: true }));
    expect(screen.getByRole("status")).toHaveTextContent("dag:loading");
  });

  it("maps 404/405 to capability-unavailable without a retry affordance", () => {
    renderDagView(
      graphQuery({
        isError: true,
        error: new ApiError("Not found", 404, "not_found"),
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("dag:error_unavailable");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("maps 504 to a retryable timeout", async () => {
    const refetch = vi.fn();
    renderDagView(
      graphQuery({
        isError: true,
        error: new ApiError("Timeout", 504, "graph_query_timeout"),
        refetch,
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("dag:error_timeout");
    screen.getByRole("button").click();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows the filtered-empty state and clears filters from it", async () => {
    store.getState().toggleStatusFilter("todo");
    renderDagView(graphQuery({ data: makeGraph([]) }), true);
    expect(screen.getByText(/dag:empty_title/)).toBeTruthy();
    screen.getByRole("button").click();
    expect(store.getState().statusFilters).toEqual([]);
  });

  it("renders the default-folded projection and seeds the fold preference", async () => {
    const graph = makeGraph(
      [
        makeNode("f1", { projectId: "proj-1" }),
        makeNode("a1", { projectId: "proj-1", parentIssueId: "f1" }),
        makeNode("b1"),
      ],
      [{ id: "e1", source: "f1", target: "b1" }],
    );
    renderDagView(graphQuery({ data: graph }));

    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    const props = canvasSpy.mock.calls.at(-1)![0];
    // First paint exposes task-line headers, keeping their children folded.
    const ids = props.projection.nodes.map((node) => node.id).sort();
    expect(ids).toEqual(["b1", "issue:f1"]);
    expect(props.positions.has("issue:f1")).toBe(true);
    expect(store.getState().dagCollapsedIds).toEqual(expect.arrayContaining(["issue:f1"]));
  });

  it("expands a stage-only task line into ordered columns without dependency arrows", async () => {
    store.getState().setDagCollapsedIds(["issue:line"]);
    const graph = makeGraph([
      makeNode("line"),
      makeNode("first-a", { parentIssueId: "line", stage: 1 }),
      makeNode("first-b", { parentIssueId: "line", stage: 1 }),
      makeNode("second", { parentIssueId: "line", stage: 2 }),
      makeNode("last", { parentIssueId: "line", stage: 5 }),
    ]);
    renderDagView(graphQuery({ data: graph }), false, realLayoutRunner);
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(canvasSpy.mock.calls.at(-1)![0].projection.nodes.map((n) => n.id)).toEqual([
      "issue:line",
    ]);
    act(() => canvasSpy.mock.calls.at(-1)![0].onToggleCollapsed("issue:line"));
    await waitFor(() => {
      const { positions, projection } = canvasSpy.mock.calls.at(-1)![0];
      expect(positions.get("first-a")!.x).toEqual(positions.get("first-b")!.x);
      expect(positions.get("first-a")!.x).toBeLessThan(positions.get("second")!.x);
      expect(positions.get("second")!.x).toBeLessThan(positions.get("last")!.x);
      expect(projection.edges).toEqual([]);
    });
    expect(graph.edges).toEqual([]);
  });

  it("uses the folded task's own stage without leaking its children's stage numbers", async () => {
    store.getState().setDagCollapsedIds(["issue:nested"]);
    renderDagView(
      graphQuery({
        data: makeGraph([
          makeNode("line"),
          makeNode("nested", { parentIssueId: "line", stage: 1 }),
          makeNode("child", { parentIssueId: "nested", stage: 99 }),
          makeNode("next", { parentIssueId: "line", stage: 2 }),
        ]),
      }),
      false,
      realLayoutRunner,
    );
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    const { positions, projection } = canvasSpy.mock.calls.at(-1)![0];
    expect(positions.get("issue:nested")!.x).toBeLessThan(positions.get("next")!.x);
    expect(positions.has("child")).toBe(false);
    expect(projection.edges).toEqual([]);
  });

  it("relayouts stage edits but keeps positions for status-only refreshes", async () => {
    store.getState().setDagCollapsedIds([]);
    const runner = realLayoutRunner();
    const execute = vi.spyOn(runner, "execute");
    const initial = makeGraph([
      makeNode("line"),
      makeNode("a", { parentIssueId: "line", stage: 1 }),
      makeNode("b", { parentIssueId: "line", stage: 2 }),
    ]);
    const surface = (graph: IssueGraph) => (
      <QueryClientProvider client={qc}>
        <ViewStoreProvider store={store}>
          <DagView
            graphQuery={graphQuery({ data: graph })}
            hasActiveFilters={false}
            membershipComplete
            layoutRunnerFactory={() => runner}
          />
        </ViewStoreProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(surface(initial));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    const committed = canvasSpy.mock.calls.at(-1)![0].positions;
    expect(committed.get("a")!.x).toBeLessThan(committed.get("b")!.x);
    const callsBeforeRefresh = execute.mock.calls.length;
    rerender(
      surface({
        ...initial,
        snapshotId: "status-refresh",
        nodes: initial.nodes.map((node) => ({ ...node, status: "done" })),
      }),
    );
    expect(execute).toHaveBeenCalledTimes(callsBeforeRefresh);
    expect(canvasSpy.mock.calls.at(-1)![0].positions).toBe(committed);
    rerender(
      surface({
        ...initial,
        topologyId: "stage-edit",
        snapshotId: "stage-edit",
        nodes: initial.nodes.map((node) => (node.id === "a" ? { ...node, stage: 3 } : node)),
      }),
    );
    await waitFor(() => {
      const { positions } = canvasSpy.mock.calls.at(-1)![0];
      expect(positions.get("b")!.x).toBeLessThan(positions.get("a")!.x);
    });
    expect(execute).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
  });

  it("marks a refresh failure while keeping the last snapshot visible", async () => {
    const graph = makeGraph([makeNode("a1")]);
    const refetch = vi.fn();
    renderDagView(graphQuery({ data: graph, isError: true, error: new Error("boom"), refetch }));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(screen.getByRole("alert").textContent).toContain("dag:stale_banner");
    const retry = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("dag:error_retry"));
    expect(retry).toBeTruthy();
    retry!.click();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("keeps direction paired with committed positions while a replacement layout is pending", async () => {
    store.getState().setDagCollapsedIds([]);
    const pending: { request: DagLayoutRequest; done: (response: DagLayoutResponse) => void }[] =
      [];
    const runner = {
      execute: (request: DagLayoutRequest, done: (response: DagLayoutResponse) => void) => {
        pending.push({ request, done });
      },
      prepare: vi.fn(),
    terminate: vi.fn(),
    };
    render(
      <QueryClientProvider client={qc}>
        <ViewStoreProvider store={store}>
          <DagView
            graphQuery={graphQuery({ data: makeGraph([makeNode("a1")]) })}
            hasActiveFilters={false}
            membershipComplete
            layoutRunnerFactory={() => runner}
          />
        </ViewStoreProvider>
      </QueryClientProvider>,
    );
    await act(async () =>
      pending[0]!.done({
        requestId: pending[0]!.request.requestId,
        positions: { a1: { x: 100, y: 0 } },
        groups: {},
        routes: {},
        ports: {},
        elapsedMs: 1,
      }),
    );
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    const committed = canvasSpy.mock.calls.at(-1)![0].positions;
    act(() => store.getState().setDagDirection("TB"));
    expect(pending.at(-1)!.request.direction).toBe("TB");
    expect(canvasSpy.mock.calls.at(-1)![0].positions).toBe(committed);
    expect(canvasSpy.mock.calls.at(-1)![0].direction).toBe("LR");
    await act(async () =>
      pending.at(-1)!.done({
        requestId: pending.at(-1)!.request.requestId,
        positions: { a1: { x: 0, y: 100 } },
        groups: {},
        routes: {},
        ports: {},
        elapsedMs: 2,
      }),
    );
    expect(canvasSpy.mock.calls.at(-1)![0].direction).toBe("TB");
    expect(canvasSpy.mock.calls.at(-1)![0].positions.get("a1")).toEqual({ x: 0, y: 100 });
  });

  it("keeps folded endpoint routes through a failed replacement layout and retry", async () => {
    const requests: { request: DagLayoutRequest; done: (response: DagLayoutResponse) => void }[] =
      [];
    const factory = () => ({
      execute(request: DagLayoutRequest, done: (response: DagLayoutResponse) => void) {
        requests.push({ request, done });
      },
      prepare: vi.fn(),
    terminate: vi.fn(),
    });
    const graph = makeGraph(
      [
        makeNode("p"),
        makeNode("a", { parentIssueId: "p" }),
        makeNode("q"),
        makeNode("b", { parentIssueId: "q" }),
      ],
      [{ id: "a-b", source: "a", target: "b" }],
    );
    renderDagView(graphQuery({ data: graph }), false, factory);
    const complete = async () => {
      const { request, done } = requests.at(-1)!;
      const result = await layoutDagProjection(
        request.nodes,
        request.edges,
        request.direction,
        request.groups,
        layoutEngine,
      );
      await act(async () => done({ ...result, requestId: request.requestId, elapsedMs: 1 }));
    };
    await complete();
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    const original = canvasSpy.mock.calls.at(-1)![0];
    expect(original.projection.edges).toHaveLength(1);
    act(() => original.onRevealIssues(["a", "b"]));
    expect(canvasSpy.mock.calls.at(-1)![0].focusRequest).toBeNull();
    expect(canvasSpy.mock.calls.at(-1)![0].projection).toBe(original.projection);
    const latest = requests.at(-1)!;
    await act(async () =>
      latest.done({
        requestId: latest.request.requestId,
        positions: {},
        groups: {},
        routes: {},
        ports: {},
        elapsedMs: 1,
        error: "layout failed",
      }),
    );
    const retained = canvasSpy.mock.calls.at(-1)![0];
    expect(retained.projection).toBe(original.projection);
    expect(retained.geometry.routes[retained.projection.edges[0]!.id]).toBeDefined();
    act(() => screen.getByRole("button", { name: /dag:error_retry/ }).click());
    await complete();
    const replaced = canvasSpy.mock.calls.at(-1)![0];
    expect(replaced.projection.edges[0]!.source).toBe("a");
    expect(replaced.focusRequest?.issueIds).toEqual(["a", "b"]);
    expect(replaced.geometry.routes[replaced.projection.edges[0]!.id]).toBeDefined();
  });

  it.each([403, 404])(
    "hides the cached graph after access loss (%s) instead of showing it stale",
    async (status) => {
      renderDagView(
        graphQuery({
          data: makeGraph([makeNode("private")]),
          isError: true,
          error: new ApiError("Access lost", status, "denied"),
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          status === 403 ? "dag:error_forbidden" : "dag:error_unavailable",
        ),
      );
      expect(screen.queryByTestId("dag-canvas")).toBeNull();
    },
  );

  it("keeps a transient failure on the last snapshot with the stale banner", async () => {
    const graph = makeGraph([makeNode("a1")]);
    renderDagView(
      graphQuery({
        data: graph,
        isError: true,
        error: new ApiError("Timeout", 504, "graph_query_timeout"),
      }),
    );
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(screen.getByRole("alert").textContent).toContain("dag:stale_banner");
  });

  it("preserves a folded task line omitted by the current filter (review F3)", async () => {
    store.getState().setDagCollapsedIds(["issue:feature", "issue:hidden"]);
    renderDagView(graphQuery({ data: makeGraph([makeNode("a", { projectId: "proj-1" })]) }), true);
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(store.getState().dagCollapsedIds).toContain("issue:hidden");
  });

  it("keeps parent status, own stage and child run state in its group header", () => {
    const graph = makeGraph([
      makeNode("root", { status: "done", statusCategory: "done", stage: 3 }),
      makeNode("child", {
        parentIssueId: "root",
        runSummary: {
          queued: 0,
          dispatched: 0,
          running: 1,
          waitingLocalDirectory: 0,
          capturedAt: "now",
        },
      }),
    ]);
    const projection = computeDagProjection(graph, ["issue:root"]),
      model = projection.nodes[0]!;
    render(
      <ReactFlowProvider><DagPortUpdateProvider>
        <DagFlowGroupCard
          {...({
            id: model.id,
            type: "dagGroup",
            selected: false,
            draggable: false,
            dragging: false,
            selectable: true,
            deletable: false,
            isConnectable: false,
            zIndex: 0,
            positionAbsoluteX: 0,
            positionAbsoluteY: 0,
            data: {
              model,
              projectTitle: null,
              statusColor: null,
              focused: false,
              dimmed: false,
              ports: [],
              showStage: true,
              group: projection.groups[0]!,
              bounds: { x: 0, y: 0, width: 680, height: 76, bands: [], stageConflict: false },
              direction: "LR",
              activeStage: null,
              onToggle: vi.fn(),
              onFocus: vi.fn(),
              onOpen: vi.fn(),
            },
          } as Parameters<typeof DagFlowGroupCard>[0])}
        />
      </DagPortUpdateProvider></ReactFlowProvider>,
    );
    expect(screen.getByText("dag:run_active")).toBeTruthy();
    expect(document.querySelector('[data-dag-parent-status="done"] svg')).not.toBeNull();
    expect(screen.getByText('dag:stage_badge {"number":3}')).toBeTruthy();
    expect(screen.queryByText("dag:run_queued")).toBeNull();
  });

  it("keeps a feature fold when a status filter hides its children (review F3)", async () => {
    store.getState().setDagCollapsedIds(["issue:feature"]);
    // membershipComplete=false mirrors a filtered request: the feature is
    // present, its done child is filtered out — the fold must survive.
    renderDagView(
      graphQuery({
        data: makeGraph([makeNode("feature")]),
      }),
      true,
    );
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(store.getState().dagCollapsedIds).toContain("issue:feature");
  });

  it("prunes a genuinely childless feature fold on a complete graph", async () => {
    store.getState().setDagCollapsedIds(["issue:feature"]);
    renderDagView(graphQuery({ data: makeGraph([makeNode("feature")]) }), false);
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(store.getState().dagCollapsedIds).not.toContain("issue:feature");
  });

  it.each([
    { label: "while refreshing", state: { isFetching: true } },
    {
      label: "after a refresh failure",
      state: { isError: true, error: new ApiError("Unavailable", 500, "unavailable") },
    },
  ])(
    "review round 5 F3: keeps a newer fold against old full-graph cache $label",
    async ({ state }) => {
      // The inactive, unfiltered query still caches G0: feature had no child.
      const oldFullGraph = makeGraph([makeNode("feature")]);
      // While a filter was active, a child was created and that active query
      // refreshed to G1. The user then folded the newly visible feature.
      const newerFilteredGraph = {
        ...makeGraph([makeNode("feature"), makeNode("child", { parentIssueId: "feature" })]),
        snapshotId: "snap-2",
        topologyId: "topo-2",
        capturedAt: "2026-09-10T00:01:00Z",
      };
      const filtered = renderDagView(graphQuery({ data: newerFilteredGraph }), true);
      await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
      act(() => store.getState().setDagCollapsedIds(["issue:feature"]));
      expect(store.getState().dagCollapsedIds).toContain("issue:feature");
      filtered.unmount();
      canvasSpy.mockClear();

      // Clearing the filter returns the invalidated G0 cache while its own
      // query fetches G1 (or retains G0 after a failed refresh). An old complete
      // transaction cannot disprove a fold chosen against the newer graph.
      renderDagView(graphQuery({ data: oldFullGraph, ...state }));
      await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
      expect(store.getState().dagCollapsedIds).toContain("issue:feature");
    },
  );

  it("expand all / collapse all drive the fold preference", async () => {
    const graph = makeGraph([
      makeNode("f1", { projectId: "proj-1" }),
      makeNode("a1", { projectId: "proj-1", parentIssueId: "f1" }),
    ]);
    renderDagView(graphQuery({ data: graph }));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());

    const expand = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("dag:expand_all"))!;
    act(() => expand.click());
    expect(store.getState().dagCollapsedIds).toEqual([]);
    const lastProps = canvasSpy.mock.calls.at(-1)![0];
    expect(lastProps.projection.nodes.map((n: { id: string }) => n.id).sort()).toEqual([
      "a1",
      "issue:f1",
    ]);

    const collapse = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("dag:collapse_all"))!;
    act(() => collapse.click());
    expect(store.getState().dagCollapsedIds).toEqual(expect.arrayContaining(["issue:f1"]));
  });
  it("global task-line expansion never changes the independent group's personal state", async () => {
    const graph = makeGraph([
      makeNode("root"),
      makeNode("child", { parentIssueId: "root" }),
      makeNode("solo"),
    ]);
    renderDagView(graphQuery({ data: graph }));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    act(() => screen.getByRole("button", { name: /dag:expand_all/ }).click());
    expect(store.getState().dagIndependentExpanded).toBe(false);
    expect(canvasSpy.mock.calls.at(-1)![0].projection.nodes.some((n) => n.id === "solo")).toBe(
      false,
    );
    act(() => canvasSpy.mock.calls.at(-1)![0].onToggleCollapsed("independent:root"));
    expect(store.getState().dagIndependentExpanded).toBe(true);
    act(() => screen.getByRole("button", { name: /dag:collapse_all/ }).click());
    expect(store.getState().dagIndependentExpanded).toBe(true);
    expect(canvasSpy.mock.calls.at(-1)![0].projection.nodes.some((n) => n.id === "solo")).toBe(
      true,
    );
  });

  it("surfaces worker failure and retries without silently drawing fallback lines", async () => {
    const execute = vi.fn((request: DagLayoutRequest, done: (r: DagLayoutResponse) => void) =>
      done({
        requestId: request.requestId,
        positions: {},
        groups: {},
        routes: {},
        ports: {},
        elapsedMs: 1,
        error: "layout failed",
      }),
    );
    renderDagView(graphQuery({ data: makeGraph([makeNode("solo")]) }), false, () => ({
      execute,
      prepare: vi.fn(),
    terminate: vi.fn(),
    }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("dag:layout_error"));
    expect(screen.queryByTestId("dag-canvas")).toBeNull();
    act(() => screen.getByRole("button", { name: /dag:error_retry/ }).click());
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });
});
