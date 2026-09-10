/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, type IssueGraph, type IssueGraphNode } from "@multica/core/api";
import {
  viewStoreSlice,
  type IssueViewState,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import type { DagLayoutRequest, DagLayoutResponse } from "./dag-layout";
import { DagView, type DagGraphQueryState } from "./dag-view";
import type { DagCanvasProps } from "./dag-canvas";
import { computeDagProjection } from "./dag-projection";
import { DagFlowNodeCard } from "./dag-node";
import { ReactFlowProvider } from "@xyflow/react";

// t($ => $.path.to.key, params) → "path.to.key {params}" so assertions can
// pin the exact locale key each state renders.
const mockTranslate = vi.hoisted(() =>
  vi.fn((selector: (resources: unknown) => unknown, params?: unknown) => {
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
    return path.join(".") + (params ? ` ${JSON.stringify(params)}` : "");
  }),
);

vi.mock("../../i18n", () => ({
  useLocale: () => "en",
  useT: () => ({ t: mockTranslate, i18n: { language: "en" } }),
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
  const actual = await vi.importActual<typeof import("@multica/core/paths")>(
    "@multica/core/paths",
  );
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
    execute(
      request: DagLayoutRequest,
      onDone: (response: DagLayoutResponse) => void,
    ) {
      const positions: DagLayoutResponse["positions"] = {};
      request.nodes.forEach((node, index) => {
        positions[node.id] = { x: index * 10, y: index * 10 };
      });
      onDone({ requestId: request.requestId, positions, elapsedMs: 1 });
    },
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
    refetch: vi.fn(),
    ...partial,
  };
}

describe("DagView", () => {
  let qc: QueryClient;
  let store: StoreApi<IssueViewState>;

  function renderDagView(query: DagGraphQueryState, hasActiveFilters = false) {
    return render(
      <QueryClientProvider client={qc}>
        <ViewStoreProvider store={store}>
          <DagView
            graphQuery={query}
            hasActiveFilters={hasActiveFilters}
            membershipComplete={!hasActiveFilters}
            layoutRunnerFactory={syncLayoutRunner}
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
    expect(screen.getByRole("status")).toHaveTextContent("dag.loading");
  });

  it("maps 404/405 to capability-unavailable without a retry affordance", () => {
    renderDagView(
      graphQuery({
        isError: true,
        error: new ApiError("Not found", 404, "not_found"),
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("dag.error_unavailable");
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
    expect(screen.getByRole("alert")).toHaveTextContent("dag.error_timeout");
    screen.getByRole("button").click();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows the filtered-empty state and clears filters from it", async () => {
    store.getState().toggleStatusFilter("todo");
    renderDagView(graphQuery({ data: makeGraph([]) }), true);
    expect(screen.getByText(/dag\.empty_title/)).toBeTruthy();
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
    // Default fold: project representatives only — the feature folds inside
    // its project until the user expands layer by layer.
    const ids = props.projection.nodes.map((node) => node.id).sort();
    expect(ids).toEqual(["project:none", "project:proj-1"]);
    expect(props.positions.get("project:proj-1")).toEqual({ x: 0, y: 0 });
    // First paint writes the default fold into the personal prefs, including
    // the (currently nested) feature fold.
    expect(store.getState().dagCollapsedIds).toEqual(
      expect.arrayContaining(["project:proj-1", "project:none", "issue:f1"]),
    );
  });

  it("marks a refresh failure while keeping the last snapshot visible", async () => {
    const graph = makeGraph([makeNode("a1")]);
    const refetch = vi.fn();
    renderDagView(graphQuery({ data: graph, isError: true, error: new Error("boom"), refetch }));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(screen.getByRole("alert").textContent).toContain("dag.stale_banner");
    const retry = screen.getAllByRole("button").find((b) => b.textContent?.includes("dag.error_retry"));
    expect(retry).toBeTruthy();
    retry!.click();
    expect(refetch).toHaveBeenCalledOnce();
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
          status === 403 ? "dag.error_forbidden" : "dag.error_unavailable",
        ),
      );
      expect(screen.queryByTestId("dag-canvas")).toBeNull();
    },
  );

  it("keeps a transient failure on the last snapshot with the stale banner", async () => {
    const graph = makeGraph([makeNode("a1")]);
    renderDagView(
      graphQuery({ data: graph, isError: true, error: new ApiError("Timeout", 504, "graph_query_timeout") }),
    );
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(screen.getByRole("alert").textContent).toContain("dag.stale_banner");
  });

  it("preserves a folded project omitted by the current filter (review F3)", async () => {
    store.getState().setDagCollapsedIds(["project:proj-1", "project:proj-2"]);
    renderDagView(
      graphQuery({ data: makeGraph([makeNode("a", { projectId: "proj-1" })]) }),
      true,
    );
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
    expect(store.getState().dagCollapsedIds).toContain("project:proj-2");
  });

  it("shows an active child as running on its folded project (review F5)", () => {
    const running = makeNode("child", {
      projectId: "proj-1",
      runSummary: {
        queued: 0,
        dispatched: 0,
        running: 1,
        waitingLocalDirectory: 0,
        capturedAt: "2026-09-10T00:00:00Z",
      },
    });
    const graph = makeGraph([running]);
    const model = computeDagProjection(graph, "project", ["project:proj-1"])
      .nodes[0]!;
    render(
      <ReactFlowProvider>
        <DagFlowNodeCard
          {...({
            id: model.id,
            type: "dagNode",
            data: {
              model,
              direction: "LR",
              projectTitle: null,
              statusColor: null,
              focused: false,
              dimmed: false,
            },
          } as Parameters<typeof DagFlowNodeCard>[0])}
        />
      </ReactFlowProvider>,
    );
    expect(screen.getByText("dag.run_active")).toBeTruthy();
    expect(screen.queryByText("dag.run_queued")).toBeNull();
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

  it("expand all / collapse all drive the fold preference", async () => {
    const graph = makeGraph([
      makeNode("f1", { projectId: "proj-1" }),
      makeNode("a1", { projectId: "proj-1", parentIssueId: "f1" }),
    ]);
    renderDagView(graphQuery({ data: graph }));
    await waitFor(() => expect(canvasSpy).toHaveBeenCalled());

    const expand = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("dag.expand_all"))!;
    act(() => expand.click());
    expect(store.getState().dagCollapsedIds).toEqual([]);
    const lastProps = canvasSpy.mock.calls.at(-1)![0];
    expect(lastProps.projection.nodes.map((n: { id: string }) => n.id).sort()).toEqual([
      "a1",
      "f1",
    ]);

    const collapse = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("dag.collapse_all"))!;
    act(() => collapse.click());
    expect(store.getState().dagCollapsedIds).toEqual(
      expect.arrayContaining(["project:proj-1", "issue:f1"]),
    );
  });
});
