import type { IssueGraph, IssueGraphNode } from "../../api/issue-graph-schemas";
import { normalizeIssueStatusCategory } from "../config/status";
import { DAG_ISSUE_REP_PREFIX } from "../stores/view-store";

const identifierCollator = new Intl.Collator(undefined, { numeric: true });
export const DAG_INDEPENDENT_GROUP = "independent:root";

export function dagFeatureRepId(issueId: string): string {
  return `${DAG_ISSUE_REP_PREFIX}${issueId}`;
}

/** The display forest the projection walks: parent links repaired for display
 *  (cycles and missing parents broken at the edge), children and roots sorted
 *  by identifier. The source graph is never mutated. */
export function dagDisplayForest(graph: IssueGraph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parentOf = new Map(
    graph.nodes.map((n) => [
      n.id,
      n.parentIssueId && byId.has(n.parentIssueId) && n.parentIssueId !== n.id
        ? n.parentIssueId
        : null,
    ]),
  );
  // Bound traversal even if an inconsistent hierarchy slips through a read.
  const visited = new Set<string>();
  for (const node of graph.nodes) {
    const path = new Set<string>();
    let id: string | null = node.id;
    while (id && !visited.has(id)) {
      if (path.has(id)) {
        parentOf.set(id, null);
        break;
      }
      path.add(id);
      id = parentOf.get(id) ?? null;
    }
    for (const item of path) visited.add(item);
  }
  const children = new Map<string, IssueGraphNode[]>();
  const roots: IssueGraphNode[] = [];
  for (const node of graph.nodes) {
    const parent = parentOf.get(node.id);
    if (!parent) roots.push(node);
    else {
      const list = children.get(parent) ?? [];
      list.push(node);
      children.set(parent, list);
    }
  }
  const compare = (a: IssueGraphNode, b: IssueGraphNode) =>
    identifierCollator.compare(a.identifier, b.identifier) ||
    a.id.localeCompare(b.id);
  roots.sort(compare);
  for (const list of children.values()) list.sort(compare);
  return { byId, parentOf, children, roots };
}

export function dagDescendants(
  children: ReadonlyMap<string, IssueGraphNode[]>,
  root: IssueGraphNode,
): IssueGraphNode[] {
  const result: IssueGraphNode[] = [];
  const stack = [root];
  while (stack.length) {
    const next = stack.pop()!;
    result.push(next);
    const nested = children.get(next.id);
    if (nested) for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]!);
  }
  return result;
}

export interface DagCompletedVisibility {
  /** Roots of task lines whose every member sits in a done/closed category. */
  hiddenRoots: ReadonlySet<string>;
  /** Standalone finished tasks (including independent-group members). */
  hiddenSingles: ReadonlySet<string>;
  /** Hidden cancelled tasks kept visible because they still block visible
   *  unfinished work. The server only treats done as satisfied, so a
   *  cancelled prerequisite stalls its downstream forever. */
  keptCancelled: ReadonlySet<string>;
  /** Rep ids of the hidden lines, including lines nested inside them. */
  hiddenLineIds: readonly string[];
}

/** What the "show completed" switch hides, decided at the top level: a task
 *  line hides only when its parent and every nested member are done/closed; a
 *  standalone finished task hides on its own. The walk that keeps cancelled
 *  blockers visible starts from visible UNFINISHED tasks and propagates only
 *  through hidden cancelled ones — a done or visible-cancelled intermediate
 *  already accounts for its own downstream, so the chain stops there. */
export function dagCompletedVisibility(
  graph: IssueGraph,
  forest: ReturnType<typeof dagDisplayForest> = dagDisplayForest(graph),
): DagCompletedVisibility {
  const { byId, children, roots } = forest;
  const finished = (n: IssueGraphNode) => {
    const category = normalizeIssueStatusCategory(n.statusCategory);
    return category === "done" || category === "closed";
  };
  const hiddenRoots = new Set<string>();
  const hiddenSingles = new Set<string>();
  for (const root of roots) {
    if (children.has(root.id)) {
      if (dagDescendants(children, root).every(finished)) hiddenRoots.add(root.id);
    } else if (finished(root)) hiddenSingles.add(root.id);
  }
  const keptCancelled = new Set<string>();
  if (hiddenRoots.size || hiddenSingles.size) {
    const hiddenScope = new Set<string>();
    for (const id of hiddenRoots)
      for (const member of dagDescendants(children, byId.get(id)!)) hiddenScope.add(member.id);
    for (const id of hiddenSingles) hiddenScope.add(id);
    const backEdges = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const list = backEdges.get(edge.target) ?? [];
      list.push(edge.source);
      backEdges.set(edge.target, list);
    }
    const unfinishedSubtrees = new Set<string>();
    for (const node of graph.nodes) {
      if (finished(node)) continue;
      let current: string | null = node.id;
      while (current && !unfinishedSubtrees.has(current)) {
        unfinishedSubtrees.add(current);
        current = forest.parentOf.get(current) ?? null;
      }
    }
    const queue = graph.nodes
      .filter((n) => !hiddenScope.has(n.id) && unfinishedSubtrees.has(n.id))
      .map((n) => n.id);
    const seen = new Set(queue);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const target = queue[cursor]!;
      for (const source of backEdges.get(target) ?? []) {
        if (seen.has(source)) continue;
        seen.add(source);
        const node = byId.get(source);
        if (node && hiddenScope.has(source) && normalizeIssueStatusCategory(node.statusCategory) === "closed") {
          keptCancelled.add(source);
          queue.push(source);
        }
      }
    }
  }
  const hiddenLineIds: string[] = [];
  for (const rootId of hiddenRoots)
    for (const member of dagDescendants(children, byId.get(rootId)!))
      if (children.has(member.id)) hiddenLineIds.push(dagFeatureRepId(member.id));
  return { hiddenRoots, hiddenSingles, keptCancelled, hiddenLineIds };
}

/** Independent tasks have no hierarchy, dependency endpoints or unknown /
 * restricted prerequisites. Keep this definition shared by both views. */
export function dagIndependentIssueIds(graph: IssueGraph, forest = dagDisplayForest(graph)): Set<string> {
  const { roots, children } = forest;
  const incident = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const independent = roots.filter(
    (n) =>
      !children.has(n.id) &&
      n.parentIssueId === null &&
      !n.hasRestrictedParent &&
      !incident.has(n.id) &&
      n.dependencySummary != null &&
      !n.dependencySummary.hasRestrictedBlockers &&
      n.dependencySummary.visibleUnsatisfiedCount === 0,
  );
  return new Set(independent.map((n) => n.id));
}
