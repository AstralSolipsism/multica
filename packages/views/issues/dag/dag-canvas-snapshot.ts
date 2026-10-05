import type { IssueGraph } from "@multica/core/api";
import type { DagProjection } from "./dag-projection";

export interface CanvasSnapshot {
  key: string;
  graph: IssueGraph | undefined;
  projection: DagProjection | null;
}

/** Keep the canvas mounted through topology changes. Reuse only placed nodes
 * and routes still present in the latest authorized projection; never expose
 * removed data from a previous server snapshot. Local folds commit atomically. */
export function selectCanvasSnapshot(
  current: CanvasSnapshot,
  committed: CanvasSnapshot | undefined,
): CanvasSnapshot | null {
  if (!committed?.projection || !current.graph || !current.projection)
    return null;
  if (committed.key === current.key) return current;
  if (committed.graph === current.graph) return committed;
  const placed = new Map(committed.projection.nodes.map((n) => [n.id, n]));
  const ids = new Set<string>();
  // Projection order is parent-first, so one pass also removes orphaned descendants.
  const nodes = current.projection.nodes.filter((n) => {
    if (!placed.has(n.id) || placed.get(n.id)!.groupId !== n.groupId)
      return false;
    if (n.groupId && !ids.has(n.groupId)) return false;
    ids.add(n.id);
    return true;
  });
  const routes = new Set(committed.projection.edges.map((e) => e.id));
  const groups = new Map(committed.projection.groups.map((g) => [g.id, g]));
  return {
    ...current,
    projection: {
      ...current.projection,
      nodes,
      groups: current.projection.groups
        .filter((g) => ids.has(g.id))
        .map((g) => ({ ...g, collapsed: groups.get(g.id)!.collapsed })),
      edges: current.projection.edges.filter(
        (e) => routes.has(e.id) && ids.has(e.source) && ids.has(e.target),
      ),
    },
  };
}
