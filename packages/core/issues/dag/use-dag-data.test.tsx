// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, setApiInstance, type ApiClient } from "../../api";
import type { IssueGraph } from "../../api/issue-graph-schemas";
import type { IssueTableQuerySpec } from "../../types";
import { issueGraphOptions } from "../graph";
import { graphNode as n, issueGraph as g } from "./test-fixtures";
import { useDagModels } from "./use-dag-data";
import { useDagSurfaceGraph } from "./use-dag-surface-graph";
import type { DagModelRequest } from "./selector";

const spec: IssueTableQuerySpec = { scope: { kind: "workspace" }, filters: {}, sort: { field: "position", direction: "asc" } };
const graph = g([n("root"), n("child", { parentIssueId: "root" })]);
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); });

describe("DAG data boundary", () => {
  it("supplies all three models from the shared graph cache and reacts to refreshes", async () => {
    const getIssueGraph = vi.fn().mockResolvedValue(graph);
    setApiInstance({ getIssueGraph } as unknown as ApiClient);
    const { wrapper, client } = setup();
    const { result, rerender } = renderHook(({ request }: { request: DagModelRequest }) => useDagModels("ws", spec, request), {
      wrapper, initialProps: { request: { view: "overview" } },
    });
    await waitFor(() => expect(result.current.models?.overview?.autoEnterLineId).toBe("root"));
    rerender({ request: { view: "line", lineId: "root" } });
    expect(result.current.models?.line?.tasks[0]?.issue.id).toBe("child");
    rerender({ request: { view: "focus", issueId: "child" } });
    expect(result.current.models?.focus?.upstreamIds.has("root")).toBe(true);
    expect(getIssueGraph).toHaveBeenCalledOnce();
    await act(async () => {
      client.setQueryData(issueGraphOptions("ws", spec).queryKey, { ...graph, nodes: graph.nodes.map((node) => ({ ...node, status: "done", statusCategory: "done" })) });
    });
    await waitFor(() => expect(result.current.models?.focus?.hiddenIssueCount).toBe(2));
  });

  it("does not expose the previous workspace or filtered scope during a pending read", async () => {
    const pending: { resolve: (graph: IssueGraph) => void; signal: AbortSignal }[] = [];
    const getIssueGraph = vi.fn((_ws, _request, { signal }) => new Promise<IssueGraph>((resolve) => pending.push({ signal, resolve })));
    setApiInstance({ getIssueGraph } as unknown as ApiClient);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ ws, query }) => useDagModels(ws, query, { view: "overview" }), {
      wrapper, initialProps: { ws: "a", query: spec },
    });
    await act(async () => pending[0]!.resolve(graph));
    await waitFor(() => expect(result.current.models?.overview).not.toBeNull());
    rerender({ ws: "b", query: spec });
    expect(result.current.models).toBeNull();
    rerender({ ws: "b", query: { ...spec, filters: { statuses: ["todo"] } } });
    expect(pending[1]!.signal.aborted).toBe(true);
    expect(result.current.models).toBeNull();
    await act(async () => pending[1]!.resolve(graph));
    expect(result.current.models).toBeNull();
  });

  it("preserves errors instead of treating an unavailable graph as empty", async () => {
    setApiInstance({ getIssueGraph: vi.fn().mockRejectedValue(new ApiError("Forbidden", 403, "Forbidden")) } as unknown as ApiClient);
    const { wrapper } = setup();
    const { result } = renderHook(() => useDagModels("ws", spec, { view: "overview" }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.models).toBeNull();
  });

  it("gates unsupported surfaces, unresolved filters and inactive DAG views", () => {
    const getIssueGraph = vi.fn().mockResolvedValue(graph);
    setApiInstance({ getIssueGraph } as unknown as ApiClient);
    const { wrapper } = setup();
    renderHook(() => useDagSurfaceGraph("ws", { type: "workspace" }, "list", spec, false), { wrapper });
    renderHook(() => useDagSurfaceGraph("ws", { type: "workspace" }, "dag", spec, true), { wrapper });
    renderHook(() => useDagModels("", spec, { view: "overview" }), { wrapper });
    expect(getIssueGraph).not.toHaveBeenCalled();
  });
});
