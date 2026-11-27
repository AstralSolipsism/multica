import type { IssueGraph } from "../../api/issue-graph-schemas";

export interface DagTraversal {
  parentOf: ReadonlyMap<string, string | null>;
  upstream: ReadonlyMap<string, readonly string[]>;
  downstream: ReadonlyMap<string, readonly string[]>;
}

export function createDagTraversal(
  graph: IssueGraph,
  forest: Pick<DagTraversal, "parentOf">,
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
  return { parentOf: forest.parentOf, upstream, downstream };
}

/** Walk only real snapshot dependency edges; parentage groups display frames
 *  but never transfers blockers between ancestors and descendants. */
export function dagDependencyClosure(
  traversal: DagTraversal,
  seeds: readonly string[],
  way: "upstream" | "downstream",
): Set<string> {
  const seen = new Set(seeds.filter((id) => traversal.parentOf.has(id)));
  const queue = [...seen];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    for (const next of traversal[way].get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
