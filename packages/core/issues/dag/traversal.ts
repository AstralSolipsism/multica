import type { IssueGraph, IssueGraphNode } from "../../api/issue-graph-schemas";

export interface DagTraversal {
  parentOf: ReadonlyMap<string, string | null>;
  children: ReadonlyMap<string, readonly IssueGraphNode[]>;
  upstream: ReadonlyMap<string, readonly string[]>;
  downstream: ReadonlyMap<string, readonly string[]>;
}

export function createDagTraversal(
  graph: IssueGraph,
  forest: Pick<DagTraversal, "parentOf" | "children">,
): DagTraversal {
  const upstream = new Map<string, string[]>(), downstream = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!forest.parentOf.has(edge.source) || !forest.parentOf.has(edge.target)) continue;
    const back = upstream.get(edge.target) ?? [];
    back.push(edge.source);
    upstream.set(edge.target, back);
    const forward = downstream.get(edge.source) ?? [];
    forward.push(edge.target);
    downstream.set(edge.source, forward);
  }
  return { ...forest, upstream, downstream };
}

/** Parentage supplies inherited prerequisites, never a wait on the parent.
 * Descend only from newly reached downstream waiters, not from seed issues. */
export function dagDependencyClosure(
  traversal: DagTraversal,
  seeds: readonly string[],
  way: "upstream" | "downstream",
): Set<string> {
  const seen = new Set(seeds.filter((id) => traversal.parentOf.has(id)));
  const affected = new Set<string>();
  const queue = [...seen];
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    affected.add(id);
    queue.push(id);
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    for (const next of traversal[way].get(current) ?? []) add(next);
    if (way === "upstream") {
      const parent = traversal.parentOf.get(current);
      if (parent) add(parent);
    } else if (affected.has(current)) {
      for (const child of traversal.children.get(current) ?? []) add(child.id);
    }
  }
  return seen;
}
