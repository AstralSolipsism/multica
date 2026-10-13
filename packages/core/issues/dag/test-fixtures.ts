import type { IssueGraph, IssueGraphNode } from "../../api/issue-graph-schemas";

export function graphNode(
  id: string,
  partial: Partial<IssueGraphNode> = {},
): IssueGraphNode {
  return {
    id,
    identifier: `T-${id.toUpperCase()}`,
    title: `Task ${id}`,
    status: "todo",
    statusCategory: "unstarted",
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
      capturedAt: "now",
    },
    dependencySummary: {
      visibleUnsatisfiedCount: 0,
      hasRestrictedBlockers: false,
      dependencyVersion: id,
    },
    ...partial,
  };
}

export function issueGraph(
  nodes: IssueGraphNode[],
  edges: ([source: string, target: string] | { id: string; source: string; target: string })[] = [],
): IssueGraph {
  return {
    schemaVersion: 1,
    snapshotId: "snapshot",
    topologyId: "topology",
    capturedAt: "now",
    complete: true,
    scope: { type: "workspace", projectId: null },
    focusIssueId: null,
    matchedCount: nodes.filter((n) => n.role === "match").length,
    contextCount: nodes.filter((n) => n.role === "context").length,
    nodes,
    edges: edges.map((edge) => {
      const { id, source, target } = Array.isArray(edge) ? { id: `${edge[0]}-${edge[1]}`, source: edge[0], target: edge[1] } : edge;
      return { sourceEdgeId: id, source, target, type: "blocked_by" as const };
    }),
    projects: [
      { id: "p1", title: "Project One" },
      { id: "p2", title: "Project Two" },
    ],
    hasRestrictedContext: false,
  };
}
