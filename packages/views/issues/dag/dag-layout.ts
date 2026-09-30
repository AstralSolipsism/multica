import dagre, { type Graph } from "@dagrejs/dagre";
import type { DagDirection } from "@multica/core/issues/stores/view-store";

/**
 * Dagre layout for the visible DAG projection. Runs inside a Web Worker via
 * `dag-layout-worker.ts`; kept pure and synchronous so unit tests exercise the
 * exact worker code path without a DOM.
 *
 * Settings mirror the OL-38 validation harness (LR, nodesep 24, ranksep 50),
 * whose dense/hierarchy numbers back the "default collapsed, expand layer by
 * layer" budget.
 */

export interface DagLayoutNodeInput {
  id: string;
  width: number;
  height: number;
  /** Stages are local to sibling issues; project representatives have neither. */
  parentIssueId?: string | null;
  stage?: number | null;
}

export interface DagLayoutEdgeInput {
  source: string;
  target: string;
}

export interface DagLayoutRequest {
  requestId: number;
  nodes: DagLayoutNodeInput[];
  edges: DagLayoutEdgeInput[];
  direction: DagDirection;
}

export interface DagLayoutPosition {
  x: number;
  y: number;
}

export interface DagLayoutResponse {
  requestId: number;
  positions: Record<string, DagLayoutPosition>;
  /** Layout wall time inside the worker, for the expand-all budget UX. */
  elapsedMs: number;
}

/**
 * Add invisible stage boundaries only to the worker's layout graph. Each
 * boundary joins adjacent stages of ONE parent; siblings without a stage and
 * unparented issues remain unconstrained. A boundary needs O(n) connections,
 * avoiding the all-pairs edges between two wide stages.
 *
 * Never let a stage preference make Dagre reverse a real dependency. Remove
 * boundaries involved in cycles, including paths through other task lines or
 * unstaged issues. The original dependency graph and canvas edges stay intact.
 */
function addStageConstraints(graph: Graph, nodes: DagLayoutNodeInput[]): void {
  const groups = new Map<string, Map<number, string[]>>();
  for (const node of nodes) {
    if (node.parentIssueId == null || node.stage == null) continue;
    let stages = groups.get(node.parentIssueId);
    if (!stages) {
      stages = new Map();
      groups.set(node.parentIssueId, stages);
    }
    const members = stages.get(node.stage) ?? [];
    members.push(node.id);
    stages.set(node.stage, members);
  }

  const boundaries = new Set<string>();
  for (const stages of groups.values()) {
    const ordered = [...stages.entries()].sort(([a], [b]) => a - b);
    for (let index = 1; index < ordered.length; index++) {
      // Real canvas ids are UUIDs, issue:<uuid>, or project:<uuid/none>.
      const boundaryId = "stage-boundary:" + boundaries.size;
      boundaries.add(boundaryId);
      graph.setNode(boundaryId, { width: 0, height: 0 });
      for (const id of ordered[index - 1]![1]) graph.setEdge(id, boundaryId);
      for (const id of ordered[index]![1]) graph.setEdge(boundaryId, id);
    }
  }
  if (boundaries.size === 0) return;
  for (const component of dagre.graphlib.alg.tarjan(graph)) {
    if (component.length < 2) continue;
    for (const id of component) {
      if (boundaries.has(id)) graph.removeNode(id);
    }
  }
}

export function layoutDagProjection(
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
  direction: DagDirection,
): Record<string, DagLayoutPosition> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: 24,
    ranksep: 56,
    marginx: 16,
    marginy: 16,
  });
  // Dagre mutates state per graph instance; a missing default is required for
  // edge-less nodes to keep their labels.
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set<string>();
  for (const node of nodes) {
    ids.add(node.id);
    g.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }
  addStageConstraints(g, nodes);
  dagre.layout(g);
  const positions: Record<string, DagLayoutPosition> = {};
  for (const node of nodes) {
    const laidOut = g.node(node.id);
    if (!laidOut || !Number.isFinite(laidOut.x) || !Number.isFinite(laidOut.y)) {
      continue;
    }
    // Dagre returns CENTER coordinates; React Flow positions are top-left.
    positions[node.id] = {
      x: laidOut.x - node.width / 2,
      y: laidOut.y - node.height / 2,
    };
  }
  return positions;
}
