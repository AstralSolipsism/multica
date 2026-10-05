import type { IssueGraph, IssueGraphNode } from "@multica/core/api";
import { projectIssueGraph } from "@multica/core/issues";
import { DAG_ISSUE_REP_PREFIX } from "@multica/core/issues/stores/view-store";

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

/** Task-line containers are independent of project membership. Only authorized
 * nodes enter the model. A missing parent is never synthesized or named. */
export function computeDagProjection(
  graph: IssueGraph,
  collapsedIds: readonly string[],
  independentExpanded = false,
): DagProjection {
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
  // This repairs only the display forest; the source graph stays untouched.
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
    a.identifier.localeCompare(b.identifier, undefined, { numeric: true }) ||
    a.id.localeCompare(b.id);
  roots.sort(compare);
  for (const list of children.values()) list.sort(compare);
  const incident = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const collapsed = new Set(collapsedIds);
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
  const independentIds = new Set(independent.map((n) => n.id));
  const nodes: DagVisibleNode[] = [];
  const groups: DagVisibleGroup[] = [];
  const representatives = new Map<string, string>();
  let foldedNodeCount = 0;
  function descendants(root: IssueGraphNode): IssueGraphNode[] {
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
  for (const node of roots) if (!independentIds.has(node.id)) visit(node, null);
  if (independent.length) {
    const id = DAG_INDEPENDENT_GROUP;
    groups.push({
      id,
      parentId: null,
      independent: true,
      collapsed: !independentExpanded,
      memberIds: independent.map((n) => n.id),
      taskCount: independent.length,
      completedCount: independent.filter((n) => n.statusCategory === "done").length,
    });
    nodes.push({
      id,
      kind: "independent",
      issue: null,
      title: "",
      identifier: null,
      groupId: null,
      collapsible: true,
      ...summarize(independent),
    });
    if (independentExpanded) for (const node of independent) visit(node, id);
    else {
      foldedNodeCount += independent.length;
      for (const node of independent) representatives.set(node.id, id);
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
  return { nodes, groups, edges, representatives, foldedNodeCount };
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
 * The returned set holds canvas node ids.
 */
export function dagFocusNeighborhood(
  projection: DagProjection,
  graph: IssueGraph,
  nodeId: string,
  way: "upstream" | "downstream",
): Set<string> {
  const backEdges = new Map<string, string[]>();
  const fwdEdges = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, from: string, to: string) => {
    const list = map.get(from) ?? [];
    list.push(to);
    map.set(from, list);
  };
  const childrenOf = new Map<string, string[]>();
  const parentById = new Map<string, string | null>();
  for (const node of graph.nodes) {
    parentById.set(node.id, node.parentIssueId);
    if (node.parentIssueId) push(childrenOf, node.parentIssueId, node.id);
  }
  for (const edge of graph.edges) {
    push(fwdEdges, edge.source, edge.target);
    push(backEdges, edge.target, edge.source);
  }
  const edgeNext = way === "upstream" ? backEdges : fwdEdges;

  const selected = projection.nodes.find((candidate) => candidate.id === nodeId);
  const seeds = selected ? selected.memberIds : [nodeId];

  const issueSeen = new Set(seeds);
  // Downstream propagation state: a node that a forward edge (waiter) or a
  // descent (inheritor) reached carries the wait and passes it to children.
  // Seeds already cover their displayed members; only new arrivals propagate.
  const affected = new Set<string>();
  const queue = [...issueSeen];
  const markAffected = (id: string) => {
    if (issueSeen.has(id)) return;
    issueSeen.add(id);
    affected.add(id);
    queue.push(id);
  };
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of edgeNext.get(current) ?? []) {
      const isNew = !issueSeen.has(next);
      if (way === "downstream") markAffected(next);
      else if (isNew) {
        issueSeen.add(next);
        queue.push(next);
      }
    }
    if (way === "upstream") {
      let ancestor = parentById.get(current) ?? null;
      const guard = new Set<string>();
      while (ancestor !== null && !guard.has(ancestor)) {
        guard.add(ancestor);
        if (!issueSeen.has(ancestor)) {
          issueSeen.add(ancestor);
          queue.push(ancestor);
        }
        ancestor = parentById.get(ancestor) ?? null;
      }
    } else if (affected.has(current)) {
      for (const child of childrenOf.get(current) ?? []) {
        markAffected(child);
      }
    }
  }

  const visibleIds = new Set(projection.nodes.map((node) => node.id));
  const result = new Set<string>();
  for (const issueId of issueSeen) {
    const canvasId = projection.representatives.get(issueId) ?? issueId;
    if (visibleIds.has(canvasId)) result.add(canvasId);
  }
  return result;
}
