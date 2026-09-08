import { hashKey, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, type IssueGraph, type IssueGraphRequest } from "../api";
import type { Issue, IssueTableQuerySpec } from "../types";
import { issueKeys } from "./queries";

function sortedSet<T>(values: T[] | undefined): T[] | undefined {
  if (values === undefined) return undefined;
  return [...new Map(values.map((value) => [hashKey([value]), value])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

/** Preserve explicit empty predicates while canonicalizing set-like filters. */
export function normalizeIssueGraphRequest(request: IssueGraphRequest): IssueGraphRequest {
  const { query } = request;
  if (query.scope.kind !== "workspace" && query.scope.kind !== "project") {
    throw new Error("Issue graphs require a workspace or project scope");
  }
  const f = query.filters;
  return {
    query: {
      scope: { ...query.scope, assignee_types: sortedSet(query.scope.assignee_types) },
      search: query.search?.trim() || undefined,
      sort: { field: "position", direction: "asc" },
      filters: {
        ...f,
        statuses: sortedSet(f.statuses), priorities: sortedSet(f.priorities),
        assignees: sortedSet(f.assignees), creators: sortedSet(f.creators),
        project_ids: sortedSet(f.project_ids), label_ids: sortedSet(f.label_ids),
        working_issue_ids: sortedSet(f.working_issue_ids),
        properties: f.properties ? Object.fromEntries(Object.entries(f.properties)
          .sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, sortedSet(values) ?? []])) : undefined,
      },
    },
    focusIssueId: request.focusIssueId || undefined,
  };
}

export function issueGraphOptions(wsId: string, query: IssueTableQuerySpec, focusIssueId?: string) {
  const request = normalizeIssueGraphRequest({ query, focusIssueId });
  return queryOptions({
    queryKey: issueKeys.graph(wsId, request),
    queryFn: async ({ signal }) => {
      const graph = await api.getIssueGraph(wsId, request, { signal });
      if (!graph) throw new ApiError("The complete issue graph is unavailable", 502, "Invalid graph response");
      return graph;
    },
    enabled: !!wsId,
    staleTime: Infinity,
    // Never display another workspace/scope's graph as placeholder data.
    retry: (attempt, error) => !(error instanceof ApiError && [400, 403, 404, 405, 422].includes(error.status)) && attempt < 1,
  });
}

/** Detail data never changes graph membership or edges. A changed revision (or
 * replacement snapshot during loading) requests a fresh graph, not a merge. */
export function reconcileIssueGraphDetail(qc: QueryClient, wsId: string, graph: IssueGraph, requestedSnapshotId: string, detail: Pick<Issue, "id" | "workspace_id" | "revision">): "current" | "stale" | "outside_snapshot" {
  const node = graph.nodes.find((n) => n.id === detail.id);
  if (detail.workspace_id !== wsId || !node) return "outside_snapshot";
  if (graph.snapshotId !== requestedSnapshotId || detail.revision !== node.revision) {
    void qc.invalidateQueries({ queryKey: issueKeys.graphAll(wsId) });
    return "stale";
  }
  return "current";
}

/** Aggregate representatives are display identities, never business edges.
 * Bidirectional representative edges are legal; only source IDs are editable. */
export function projectIssueGraph(graph: IssueGraph, representatives: ReadonlyMap<string, string>) {
  const members = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const rep = representatives.get(node.id) ?? node.id;
    const group = members.get(rep) ?? [];
    group.push(node.id);
    members.set(rep, group);
  }
  const edges = new Map<string, { source: string; target: string; sourceEdgeIds: string[] }>();
  const internalEdgeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    const source = representatives.get(edge.source) ?? edge.source;
    const target = representatives.get(edge.target) ?? edge.target;
    if (source === target) {
      internalEdgeCounts.set(source, (internalEdgeCounts.get(source) ?? 0) + 1);
    } else {
      const key = JSON.stringify([source, target]);
      const projected = edges.get(key) ?? { source, target, sourceEdgeIds: [] };
      projected.sourceEdgeIds.push(edge.sourceEdgeId);
      edges.set(key, projected);
    }
  }
  return { members, edges: [...edges.values()], internalEdgeCounts };
}
