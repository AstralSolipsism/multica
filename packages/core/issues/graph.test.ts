// @vitest-environment node
import { QueryClient, QueryObserver, hashKey } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { setApiInstance, type ApiClient } from "../api";
import { IssueGraphSchema } from "../api/issue-graph-schemas";
import reference from "../api/testdata/issue-graph.json";
import { issueGraphOptions, normalizeIssueGraphRequest, projectIssueGraph, reconcileIssueGraphDetail } from "./graph";
import { issueKeys } from "./queries";
import { onIssueCreated, onIssueDeleted, onIssueUpdated, onIssueLabelsChanged, onIssuePropertiesChanged } from "./ws-updaters";
import type { Issue, IssueTableQuerySpec } from "../types";

const query: IssueTableQuerySpec = { scope: { kind: "workspace" }, filters: {}, sort: { field: "position", direction: "asc" } };
const graph = IssueGraphSchema.parse(reference);

describe("issue graph data", () => {
  it("canonicalizes filter sets but preserves explicit empty predicates and scope", () => {
    const a = normalizeIssueGraphRequest({ query: { ...query, filters: { statuses: ["done", "todo", "done"] } } });
    const b = normalizeIssueGraphRequest({ query: { ...query, filters: { statuses: ["todo", "done"] }, sort: { field: "title", direction: "desc" } } });
    expect(hashKey(issueKeys.graph("ws", a))).toBe(hashKey(issueKeys.graph("ws", b)));
    expect(issueGraphOptions("ws-1", query).queryKey).not.toEqual(issueGraphOptions("ws-2", query).queryKey);
    expect(issueGraphOptions("ws", query).queryKey).not.toEqual(issueGraphOptions("ws", { ...query, scope: { kind: "project", project_id: "p" } }).queryKey);
    expect(issueGraphOptions("ws", query).queryKey).not.toEqual(issueGraphOptions("ws", query, "focus").queryKey);
    expect(issueGraphOptions("ws", query).queryKey).not.toEqual(issueGraphOptions("ws", { ...query, filters: { assignees: [] } }).queryKey);
    expect(normalizeIssueGraphRequest({ query: { ...query, search: "  two  spaces  " } }).query.search).toBe("two  spaces");
  });

  it("cancels the old workspace request without showing its data in the new scope", async () => {
    const signals: AbortSignal[] = [];
    const getIssueGraph = vi.fn((_ws: string, _request: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    setApiInstance({ getIssueGraph } as unknown as ApiClient);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(qc, issueGraphOptions("old-ws", query));
    const unsubscribe = observer.subscribe(() => {});
    observer.setOptions(issueGraphOptions("new-ws", query));
    expect(signals[0]?.aborted).toBe(true);
    expect(observer.getCurrentResult().data).toBeUndefined();
    unsubscribe();
    qc.clear();
  });

  it("rejects malformed refreshes and keeps the last snapshot identifiable", async () => {
    setApiInstance({ getIssueGraph: vi.fn().mockResolvedValue(null) } as unknown as ApiClient);
    const qc = new QueryClient();
    const options = issueGraphOptions("ws", query);
    qc.setQueryData(options.queryKey, graph);
    await expect(qc.fetchQuery({ ...options, staleTime: 0, retry: false })).rejects.toThrow("complete issue graph");
    expect(qc.getQueryData(options.queryKey)).toBe(graph);
    expect(qc.getQueryState(options.queryKey)?.status).toBe("error");
    qc.clear();
  });

  it("keeps each original edge traceable through project collapse, including legal opposing directions", () => {
    const reps = new Map(graph.nodes.map((n) => [n.id, n.projectId ?? "unprojected"]));
    const projected = projectIssueGraph(graph, reps);
    const [p1, p2] = graph.projects;
    expect(projected.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: p1!.id, target: p2!.id }),
      expect.objectContaining({ source: p2!.id, target: p1!.id }),
    ]));
    const originalCount = projected.edges.reduce((sum, e) => sum + e.sourceEdgeIds.length, 0)
      + [...projected.internalEdgeCounts.values()].reduce((a, b) => a + b, 0);
    expect(originalCount).toBe(graph.edges.length);
    expect(projectIssueGraph(graph, new Map()).edges).toHaveLength(graph.edges.length);
  });

  it("marks mismatched detail revisions stale without changing the graph", () => {
    const qc = new QueryClient();
    const options = issueGraphOptions("ws", query);
    qc.setQueryData(options.queryKey, graph);
    const node = graph.nodes[0]!;
    const detail = { id: node.id, workspace_id: "ws", revision: node.revision + 1 };
    expect(reconcileIssueGraphDetail(qc, "ws", graph, graph.snapshotId, detail)).toBe("stale");
    expect(qc.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryData(options.queryKey)).toBe(graph);
    expect(reconcileIssueGraphDetail(qc, "ws", graph, "old-snapshot", { ...detail, revision: node.revision })).toBe("stale");
    expect(reconcileIssueGraphDetail(qc, "ws", graph, graph.snapshotId, { ...detail, workspace_id: "foreign" })).toBe("outside_snapshot");
    qc.clear();
  });

  it("invalidates graph snapshots for committed issue and filter edits", () => {
    const qc = new QueryClient();
    const key = issueGraphOptions("ws", query).queryKey;
    const node = graph.nodes[0]!;
    for (const edit of [
      () => onIssueCreated(qc, "ws", { id: "new", status: "todo" } as Issue),
      () => onIssueUpdated(qc, "ws", { id: node.id, revision: node.revision + 1 }),
      () => onIssueLabelsChanged(qc, "ws", node.id, [], node.revision + 2),
      () => onIssuePropertiesChanged(qc, "ws", node.id, {}, node.revision + 3),
      () => onIssueDeleted(qc, "ws", node.id),
    ]) {
      qc.setQueryData(key, graph);
      edit();
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
      expect(qc.getQueryData(key)).toBe(graph);
    }
    qc.clear();
  });
});
