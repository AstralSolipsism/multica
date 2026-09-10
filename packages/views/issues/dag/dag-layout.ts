import dagre from "@dagrejs/dagre";
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

export const DAG_NODE_WIDTH = 232;
export const DAG_NODE_HEIGHT = 84;

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
