import { createDagTraversal, dagDependencyClosure } from "./traversal";
import type { IssueGraph, IssueGraphNode } from "../../api/issue-graph-schemas";
import { projectIssueGraph } from "../graph";
import { normalizeIssueStatusCategory } from "../config/status";
import { DAG_ISSUE_REP_PREFIX } from "../stores/view-store";

const identifierCollator = new Intl.Collator(undefined, { numeric: true });

export const DAG_INDEPENDENT_GROUP = "independent:root";
export type DagNodeKind = "issue" | "feature" | "independent";

export interface DagVisibleNode {
  id: string;
  kind: DagNodeKind;
  issue: IssueGraphNode | null;
  title: string;
  identifier: string | null;
  /** Immediate visible container, not a business dependency. */
  groupId: string | null;
  memberIds: string[];
  matchCount: number;
  contextCount: number;
  blockedMemberCount: number;
  unknownSummaryCount: number;
  hasRestrictedBlockers: boolean;
  internalEdgeCount: number;
  runState: "running" | "queued" | "none";
  role: "match" | "context";
  collapsible: boolean;
  /** Cancelled task kept visible because it still blocks visible unfinished
   *  work. Rendered alone with the context (dashed) style and a marker. */
  cancelledBlocking?: boolean;
}

export interface DagVisibleGroup {
  id: string;
  parentId: string | null;
  collapsed: boolean;
  independent: boolean;
  /** All authorized members, including the parent issue when one exists. */
  memberIds: string[];
  completedCount: number;
  taskCount: number;
}

export interface DagVisibleEdge {
  id: string;
  source: string;
  target: string;
  sourceEdgeIds: string[];
  sources: { edgeId: string; source: string; target: string }[];
}

export interface DagProjection {
  nodes: DagVisibleNode[];
  groups: DagVisibleGroup[];
  edges: DagVisibleEdge[];
  representatives: ReadonlyMap<string, string>;
  foldedNodeCount: number;
  /** What the "show completed" switch currently hides: whole task lines
   *  (`lines`, holding `lineTasks` tasks in total) and standalone tasks
   *  (`singles`). All zero while the switch is on. */
  hiddenCompleted: { lines: number; lineTasks: number; singles: number };
  /** Rep ids of the lines the completed filter hides, including nested
   *  sub-lines — batch expand/collapse must leave these untouched. */
  hiddenLineIds: readonly string[];
}

export function dagFeatureRepId(issueId: string): string {
  return `${DAG_ISSUE_REP_PREFIX}${issueId}`;
}

export function dagFeatureRepIds(graph: IssueGraph): Set<string> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return new Set(
    graph.nodes.flatMap((n) =>
      n.parentIssueId && ids.has(n.parentIssueId) && n.parentIssueId !== n.id
        ? [n.parentIssueId]
        : [],
    ),
  );
}

export function defaultDagCollapsedIds(graph: IssueGraph): string[] {
  return [...dagFeatureRepIds(graph)].map(dagFeatureRepId);
}

function memberRunState(node: IssueGraphNode): "running" | "queued" | "none" {
  const run = node.runSummary;
  if (!run) return "none";
  if (run.running > 0) return "running";
  return run.queued > 0 || run.dispatched > 0 || run.waitingLocalDirectory > 0 ? "queued" : "none";
}

function summarize(members: IssueGraphNode[]) {
  const matchCount = members.filter((n) => n.role === "match").length;
  return {
    memberIds: members.map((n) => n.id),
    matchCount,
    contextCount: members.length - matchCount,
    blockedMemberCount: members.filter(
      (n) =>
        n.dependencySummary &&
        (n.dependencySummary.hasRestrictedBlockers ||
          n.dependencySummary.visibleUnsatisfiedCount > 0),
    ).length,
    unknownSummaryCount: members.filter((n) => n.dependencySummary == null).length,
    hasRestrictedBlockers: members.some((n) => n.dependencySummary?.hasRestrictedBlockers === true),
    internalEdgeCount: 0,
    runState: members.reduce<"running" | "queued" | "none">((state, n) => {
      const next = memberRunState(n);
      return state === "running" || next === "none" ? state : next;
    }, "none"),
    role: (matchCount > 0 ? "match" : "context") as "match" | "context",
  };
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

const EMPTY_COMPLETED_VISIBILITY: DagCompletedVisibility = {
  hiddenRoots: new Set(),
  hiddenSingles: new Set(),
  keptCancelled: new Set(),
  hiddenLineIds: [],
};

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

/** Task-line containers are independent of project membership. Only authorized
 * nodes enter the model. A missing parent is never synthesized or named.
 *
 * With `showCompleted` off, finished work hides at the top level: a task line
 * whose parent and every nested member sit in a done/closed category hides as
 * a whole, and so does a standalone finished task. A line with anything still
 * open stays fully visible. Exception: a cancelled task that still blocks
 * visible unfinished work (the server only treats done as satisfied, so a
 * cancelled prerequisite stalls its downstream forever) stays on the canvas as
 * a lone context-styled card — even when that pulls it out of a hidden line. */
export function computeDagProjection(
  graph: IssueGraph,
  collapsedIds: readonly string[],
  independentExpanded = false,
  showCompleted = false,
): DagProjection {
  const forest = dagDisplayForest(graph);
  const { children, roots } = forest;
  const collapsed = new Set(collapsedIds);
  const independentIds = dagIndependentIssueIds(graph, forest);
  const independent = roots.filter((node) => independentIds.has(node.id));
  const nodes: DagVisibleNode[] = [];
  const groups: DagVisibleGroup[] = [];
  const representatives = new Map<string, string>();
  let foldedNodeCount = 0;
  const descendants = (root: IssueGraphNode) => dagDescendants(children, root);
  const hiddenCompleted = { lines: 0, lineTasks: 0, singles: 0 };
  const { hiddenRoots, hiddenSingles, keptCancelled, hiddenLineIds } = showCompleted
    ? EMPTY_COMPLETED_VISIBILITY
    : dagCompletedVisibility(graph, forest);
  /** A kept cancelled task renders as one flat card, never as a container —
   *  its line stays hidden and its children with it. */
  function pushKeptNode(node: IssueGraphNode, groupId: string | null) {
    representatives.set(node.id, node.id);
    nodes.push({
      id: node.id,
      kind: "issue",
      issue: node,
      title: node.title,
      identifier: node.identifier,
      groupId,
      collapsible: false,
      cancelledBlocking: true,
      ...summarize([node]),
    });
  }
  function visit(node: IssueGraphNode, groupId: string | null) {
    const nested = children.get(node.id);
    if (!nested) {
      representatives.set(node.id, node.id);
      nodes.push({
        id: node.id,
        kind: "issue",
        issue: node,
        title: node.title,
        identifier: node.identifier,
        groupId,
        collapsible: false,
        ...summarize([node]),
      });
      return;
    }
    const id = dagFeatureRepId(node.id),
      members = descendants(node);
    const isCollapsed = collapsed.has(id);
    groups.push({
      id,
      parentId: groupId,
      collapsed: isCollapsed,
      independent: false,
      memberIds: members.map((n) => n.id),
      taskCount: members.length - 1,
      completedCount: members.slice(1).filter((n) => n.statusCategory === "done").length,
    });
    nodes.push({
      id,
      kind: "feature",
      issue: node,
      title: node.title,
      identifier: node.identifier,
      groupId,
      collapsible: true,
      ...summarize(members),
    });
    representatives.set(node.id, id);
    if (isCollapsed) {
      foldedNodeCount += members.length - 1;
      for (const member of members) representatives.set(member.id, id);
    } else for (const child of nested ?? []) visit(child, id);
  }
  for (const node of roots) {
    if (independentIds.has(node.id)) continue;
    if (hiddenRoots.has(node.id)) {
      const members = descendants(node);
      const kept = members.filter((member) => keptCancelled.has(member.id));
      hiddenCompleted.lines += 1;
      hiddenCompleted.lineTasks += members.length - kept.length;
      for (const member of kept) pushKeptNode(member, null);
      continue;
    }
    if (hiddenSingles.has(node.id)) {
      if (keptCancelled.has(node.id)) pushKeptNode(node, null);
      else hiddenCompleted.singles += 1;
      continue;
    }
    visit(node, null);
  }
  // Independent members never join keptCancelled: the group requires no edges
  // and no blockers, so a hidden independent task can never still block work.
  const shownIndependent = independent.filter((n) => !hiddenSingles.has(n.id));
  hiddenCompleted.singles += independent.length - shownIndependent.length;
  if (shownIndependent.length) {
    const id = DAG_INDEPENDENT_GROUP;
    groups.push({
      id,
      parentId: null,
      independent: true,
      collapsed: !independentExpanded,
      memberIds: shownIndependent.map((n) => n.id),
      taskCount: shownIndependent.length,
      completedCount: shownIndependent.filter((n) => n.statusCategory === "done").length,
    });
    nodes.push({
      id,
      kind: "independent",
      issue: null,
      title: "",
      identifier: null,
      groupId: null,
      collapsible: true,
      ...summarize(shownIndependent),
    });
    if (independentExpanded) for (const node of shownIndependent) visit(node, id);
    else {
      foldedNodeCount += shownIndependent.length;
      for (const node of shownIndependent) representatives.set(node.id, id);
    }
  }
  const folded = projectIssueGraph(graph, representatives);
  for (const node of nodes) node.internalEdgeCount = folded.internalEdgeCounts.get(node.id) ?? 0;
  const original = new Map(graph.edges.map((e) => [e.sourceEdgeId, e]));
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = folded.edges.flatMap((e): DagVisibleEdge[] => {
    if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) return [];
    const sources = e.sourceEdgeIds.flatMap((edgeId) => {
      const edge = original.get(edgeId);
      return edge ? [{ edgeId, source: edge.source, target: edge.target }] : [];
    });
    return sources.length
      ? [
          {
            id: `${e.source}→${e.target}`,
            source: e.source,
            target: e.target,
            sourceEdgeIds: e.sourceEdgeIds,
            sources,
          },
        ]
      : [];
  });
  return { nodes, groups, edges, representatives, foldedNodeCount, hiddenCompleted, hiddenLineIds };
}

export function repsToRevealIssues(
  graph: IssueGraph,
  collapsedIds: readonly string[],
  issueIds: readonly string[],
): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const collapsed = new Set(collapsedIds),
    removal = new Set<string>();
  for (const id of issueIds) {
    let parent = byId.get(id)?.parentIssueId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const rep = dagFeatureRepId(parent);
      if (collapsed.has(rep)) removal.add(rep);
      parent = byId.get(parent)?.parentIssueId;
    }
  }
  return [...removal];
}

/** An edge reads as a summary of several dependencies when it bundles
 *  multiple original pairs or touches a folded task line. */
export function isAggregateEdge(
  edge: DagVisibleEdge,
  groups: ReadonlyMap<string, DagVisibleGroup>,
): boolean {
  return (
    edge.sourceEdgeIds.length > 1 ||
    groups.get(edge.source)?.collapsed === true ||
    groups.get(edge.target)?.collapsed === true
  );
}

/**
 * The visible neighborhood a focus action highlights. The closure runs over
 * RAW issue ids on the untransformed graph — dependency edges plus the
 * hierarchy — and only then maps to canvas representatives. Mapping first
 * would truncate the traversal: several folded issues share one
 * representative, and display-level dedup must not stop a business walk
 * (a cross-project child folded into another project still inherits).
 *
 * - Seeds cover every member the selected canvas node stands for: a
 *   representative's canvas edges aggregate its members' real edges, so the
 *   focus walk honors exactly what the canvas shows. A plain unfolded issue
 *   keeps the narrow boundary — its children never join its downstream on
 *   parentage alone.
 * - upstream: reversed dependency edges plus ancestor ascent from every
 *   reached issue — ancestors are inheritance SOURCES, never wait conditions
 *   of their own (a parent's status does not gate its children).
 * - downstream: forward dependency edges from every reached issue, plus
 *   descent into children of AFFECTED issues only. Affected means reached as
 *   a waiter (forward-edge target) or as an inheritor (child of an affected
 *   issue). Seeds already contain all descendants of a selected task line,
 *   so visiting them again cannot extend the closure.
 *
 * `nodeIds` holds canvas node ids. `hiddenIssueCount` counts closure issues
 * that map to nothing on the canvas — tasks hidden by the "show completed"
 * switch, so the toolbar can say how much of the chain is out of sight.
 */
export function dagFocusNeighborhood(
  projection: DagProjection,
  graph: IssueGraph,
  nodeId: string,
  way: "upstream" | "downstream",
): { nodeIds: Set<string>; hiddenIssueCount: number } {
  const selected = projection.nodes.find((candidate) => candidate.id === nodeId);
  const seeds = selected ? selected.memberIds : [nodeId];
  const issueSeen = dagDependencyClosure(createDagTraversal(graph, dagDisplayForest(graph)), seeds, way);

  const visibleIds = new Set(projection.nodes.map((node) => node.id));
  const nodeIds = new Set<string>();
  let hiddenIssueCount = 0;
  for (const issueId of issueSeen) {
    const canvasId = projection.representatives.get(issueId) ?? issueId;
    if (visibleIds.has(canvasId)) nodeIds.add(canvasId);
    else hiddenIssueCount += 1;
  }
  return { nodeIds, hiddenIssueCount };
}
