/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { setApiInstance, type ApiClient } from "@multica/core/api";
import { viewStoreSlice, type IssueViewState } from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import type { IssueTableQuerySpec } from "@multica/core/types";
import ELK from "elkjs/lib/elk.bundled.js";
import { layoutDagScene } from "./dag-scene-layout";
import type { DagSceneRequest, DagSceneResponse, DagSceneRunner } from "./dag-scene-runner";
import { DagView } from "./dag-view";
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

function setup(graph: ReturnType<typeof makeGraph>, seed?: (store: StoreApi<IssueViewState>) => void) {
  setApiInstance({ getIssueGraph: vi.fn().mockResolvedValue(graph) } as unknown as ApiClient);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const store = createStore<IssueViewState>()(viewStoreSlice);
  seed?.(store);
  const view = render(
    <QueryClientProvider client={client}>
      <ViewStoreProvider store={store}>
        <DagView spec={spec} hasActiveFilters={false} sceneRunnerFactory={syncSceneRunner} />
      </ViewStoreProvider>
    </QueryClientProvider>,
  );
  return { store, ...view };
}

async function waitForCanvas(): Promise<DagSceneCanvasProps> {
  await waitFor(() => expect(canvasSpy).toHaveBeenCalled());
  return canvasSpy.mock.calls.at(-1)![0];
}

beforeEach(() => {
  canvasSpy.mockClear();
  toolbarSpy.mockClear();
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
    expect(latest.focusRequest?.id).toBe("solo");
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
