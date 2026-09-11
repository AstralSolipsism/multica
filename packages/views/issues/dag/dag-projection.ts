import type { IssueGraph, IssueGraphNode } from "@multica/core/api";
import { projectIssueGraph } from "@multica/core/issues";
import {
  DAG_ISSUE_REP_PREFIX,
  DAG_NO_PROJECT_REP,
  DAG_PROJECT_REP_PREFIX,
  type DagGrouping,
} from "@multica/core/issues/stores/view-store";

/**
 * Visible projection of the complete issue graph (OL-38 §7/§8).
 *
 * The full compact graph stays in React Query; this module folds it into the
 * representatives the canvas lays out. All folding is display-only: aggregate
 * edges keep every real source edge id, and a collapsed group never deletes or
 * rewrites a business relation. Bidirectional aggregate edges between two
 * representatives are legal display output, not evidence of a task cycle.
 */

export type DagNodeKind = "issue" | "project" | "feature";

export interface DagVisibleNode {
  /** Issue id for plain issues; `project:<id>` / `project:none` /
   *  `issue:<id>` for representatives. */
  id: string;
  kind: DagNodeKind;
  /** The issue behind `issue` nodes and feature representatives. */
  issue: IssueGraphNode | null;
  title: string;
  identifier: string | null;
  /** Folded member issue ids. Plain issues hold only themselves. Feature
   *  representatives hold the feature itself plus its folded descendants. */
  memberIds: string[];
  matchCount: number;
  contextCount: number;
  /** Members whose server dependency summary reports unfinished prerequisites. */
  blockedMemberCount: number;
  /** Members whose dependency summary is unknown (malformed/missing). */
  unknownSummaryCount: number;
  hasRestrictedBlockers: boolean;
  /** Dependencies whose both ends folded into this representative. */
  internalEdgeCount: number;
  /** Aggregated live execution signal: any member running wins over queued.
   *  Representatives never read a single member's summary — a folded project
   *  with a running child shows "running", not "queued". */
  runState: "running" | "queued" | "none";
  /** "match" when the node itself or any folded member is a filter subject. */
  role: "match" | "context";
  /** Plain issue with at least one visible child — it can fold into its
   *  feature representative. Always false on representatives. */
  collapsible: boolean;
}

export interface DagVisibleEdge {
  id: string;
  source: string;
  target: string;
  sourceEdgeIds: string[];
  /** Original task endpoints behind every aggregated source edge. */
  sources: { edgeId: string; source: string; target: string }[];
}

export interface DagProjection {
  nodes: DagVisibleNode[];
  edges: DagVisibleEdge[];
  /** Full node-id → representative-id fold map behind this projection. */
  representatives: ReadonlyMap<string, string>;
  /** Issue nodes folded into a representative, for summary copy. */
  foldedNodeCount: number;
}

export function dagProjectRepId(projectId: string | null): string {
  return projectId ? `${DAG_PROJECT_REP_PREFIX}${projectId}` : DAG_NO_PROJECT_REP;
}

export function dagFeatureRepId(issueId: string): string {
  return `${DAG_ISSUE_REP_PREFIX}${issueId}`;
}

/** Issues that have at least one child inside this graph — the only nodes a
 *  feature fold can attach to. */
export function dagFeatureRepIds(graph: IssueGraph): Set<string> {
  const parents = new Set<string>();
  for (const node of graph.nodes) {
    if (node.parentIssueId) parents.add(node.parentIssueId);
  }
  return parents;
}

/** First-paint fold: project representatives (project grouping) plus every
 *  feature with visible children, so the initial canvas is the group level
 *  and the user expands layer by layer. */
export function defaultDagCollapsedIds(
  graph: IssueGraph,
  grouping: DagGrouping,
): string[] {
  const ids: string[] = [];
  if (grouping === "project") {
    const projectRepIds = new Set<string>();
    for (const node of graph.nodes) projectRepIds.add(dagProjectRepId(node.projectId));
    ids.push(...projectRepIds);
  }
  for (const id of dagFeatureRepIds(graph)) ids.push(dagFeatureRepId(id));
  return ids;
}

function memberRunState(node: IssueGraphNode): "running" | "queued" | "none" {
  const run = node.runSummary;
  if (!run) return "none";
  if (run.running > 0) return "running";
  if (run.queued > 0 || run.dispatched > 0 || run.waitingLocalDirectory > 0) {
    return "queued";
  }
  return "none";
}

function isBlocked(node: IssueGraphNode): boolean {
  const summary = node.dependencySummary;
  if (!summary) return false;
  return summary.hasRestrictedBlockers === true || summary.visibleUnsatisfiedCount > 0;
}

export function computeDagProjection(
  graph: IssueGraph,
  grouping: DagGrouping,
  collapsedIds: readonly string[],
): DagProjection {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const featureRepIds = dagFeatureRepIds(graph);
  const collapsed = new Set(collapsedIds);

  // Pass 1: project folding. Every node of a collapsed project folds into the
  // project representative regardless of ancestry.
  const afterProject = new Map<string, string>();
  for (const node of graph.nodes) {
    if (grouping === "project") {
      const repId = dagProjectRepId(node.projectId);
      if (collapsed.has(repId)) {
        afterProject.set(node.id, repId);
        continue;
      }
    }
    afterProject.set(node.id, node.id);
  }

  // Pass 2: feature folding. A collapsed feature renders as its own
  // representative only when no collapsed feature ancestor shades it; every
  // other node folds into its nearest VISIBLE collapsed feature ancestor.
  // Nested folds therefore surface a single outermost representative whose
  // member list covers the whole folded subtree (root → middle → leaf with
  // both folded shows only `issue:root`, holding all three).
  const parentOf = (id: string): string | null =>
    nodesById.get(id)?.parentIssueId ?? null;
  const visibleFeatureMemo = new Map<string, boolean>();
  const isVisibleCollapsedFeature = (id: string): boolean => {
    const memoized = visibleFeatureMemo.get(id);
    if (memoized !== undefined) return memoized;
    let visible =
      afterProject.get(id) === id &&
      featureRepIds.has(id) &&
      collapsed.has(dagFeatureRepId(id));
    if (visible) {
      const visited = new Set<string>([id]);
      let current = parentOf(id);
      while (current !== null && !visited.has(current)) {
        visited.add(current);
        if (
          afterProject.get(current) === current &&
          featureRepIds.has(current) &&
          collapsed.has(dagFeatureRepId(current))
        ) {
          // A collapsed feature ancestor shades this one — regardless of
          // whether that ancestor is itself shaded further up.
          visible = false;
          break;
        }
        current = parentOf(current);
      }
    }
    visibleFeatureMemo.set(id, visible);
    return visible;
  };

  const representatives = new Map<string, string>();
  for (const node of graph.nodes) {
    if (afterProject.get(node.id) !== node.id) continue;
    if (isVisibleCollapsedFeature(node.id)) {
      // The feature renders AS its representative; edges to/from it land on
      // the rep node.
      representatives.set(node.id, dagFeatureRepId(node.id));
      continue;
    }
    const visited = new Set<string>([node.id]);
    let current = node.parentIssueId;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      if (isVisibleCollapsedFeature(current)) {
        representatives.set(node.id, dagFeatureRepId(current));
        break;
      }
      current = parentOf(current);
    }
  }
  for (const [nodeId, repId] of afterProject) {
    if (repId !== nodeId) representatives.set(nodeId, repId);
  }

  const { members, edges, internalEdgeCounts } = projectIssueGraph(
    graph,
    representatives,
  );

  const originalEdgeById = new Map(
    graph.edges.map((edge) => [
      edge.sourceEdgeId,
      { source: edge.source, target: edge.target },
    ]),
  );

  const projectTitleById = new Map(
    graph.projects.map((project) => [project.id, project.title]),
  );

  const nodes: DagVisibleNode[] = [];
  let foldedNodeCount = 0;
  for (const [repOrNodeId, memberIds] of members) {
    const memberNodes = memberIds
      .map((id) => nodesById.get(id))
      .filter((node): node is IssueGraphNode => !!node);
    const matchCount = memberNodes.filter((node) => node.role === "match").length;
    const contextCount = memberNodes.length - matchCount;
    const aggregate = {
      memberIds,
      matchCount,
      contextCount,
      blockedMemberCount: memberNodes.filter(isBlocked).length,
      unknownSummaryCount: memberNodes.filter(
        (node) => node.dependencySummary == null,
      ).length,
      hasRestrictedBlockers: memberNodes.some(
        (node) => node.dependencySummary?.hasRestrictedBlockers === true,
      ),
      internalEdgeCount: internalEdgeCounts.get(repOrNodeId) ?? 0,
      runState: memberNodes.reduce<"running" | "queued" | "none">(
        (state, node) => {
          const member = memberRunState(node);
          if (state === "running" || member === "none") return state;
          if (member === "running") return "running";
          return "queued";
        },
        "none",
      ),
      role: (matchCount > 0 ? "match" : "context") as "match" | "context",
    };

    if (repOrNodeId.startsWith(DAG_PROJECT_REP_PREFIX)) {
      foldedNodeCount += memberIds.length;
      const projectId =
        repOrNodeId === DAG_NO_PROJECT_REP
          ? null
          : repOrNodeId.slice(DAG_PROJECT_REP_PREFIX.length);
      nodes.push({
        id: repOrNodeId,
        kind: "project",
        issue: null,
        title: (projectId && projectTitleById.get(projectId)) || projectId || "",
        identifier: null,
        collapsible: false,
        ...aggregate,
      });
      continue;
    }
    if (repOrNodeId.startsWith(DAG_ISSUE_REP_PREFIX)) {
      const issueId = repOrNodeId.slice(DAG_ISSUE_REP_PREFIX.length);
      const issue = nodesById.get(issueId);
      if (!issue) continue;
      foldedNodeCount += memberIds.length - 1;
      nodes.push({
        id: repOrNodeId,
        kind: "feature",
        issue,
        title: issue.title,
        identifier: issue.identifier,
        collapsible: false,
        ...aggregate,
      });
      continue;
    }
    const issue = nodesById.get(repOrNodeId);
    if (!issue) continue;
    nodes.push({
      id: repOrNodeId,
      kind: "issue",
      issue,
      title: issue.title,
      identifier: issue.identifier,
      collapsible: featureRepIds.has(issue.id),
      ...aggregate,
    });
  }

  const visibleIds = new Set(nodes.map((node) => node.id));
  const visibleEdges: DagVisibleEdge[] = [];
  for (const edge of edges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
    const sources = edge.sourceEdgeIds.flatMap((edgeId) => {
      const original = originalEdgeById.get(edgeId);
      return original ? [{ edgeId, ...original }] : [];
    });
    if (sources.length === 0) continue;
    visibleEdges.push({
      id: `${edge.source}→${edge.target}`,
      source: edge.source,
      target: edge.target,
      sourceEdgeIds: edge.sourceEdgeIds,
      sources,
    });
  }

  return {
    nodes,
    edges: visibleEdges,
    representatives,
    foldedNodeCount,
  };
}

/**
 * Drop folds that are PROVABLY inert, and only then. Proof requires a
 * complete membership read: `membershipComplete` must be false whenever the
 * graph was produced with any filter/search/sub-issue narrowing or carries
 * restricted context — under all of those, a missing node or a feature
 * without visible children is a display artifact, not evidence of deletion
 * (a todo filter hides a done child; the fold must survive). With a complete
 * read, absence and childlessness are real, and stale entries are cleared
 * while every other personal setting stays (OL-38 §8).
 */
export function pruneDagCollapsedIds(
  collapsedIds: readonly string[],
  graph: IssueGraph,
  membershipComplete: boolean,
): string[] {
  if (!membershipComplete) return [...collapsedIds];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const featureRepIds = dagFeatureRepIds(graph);
  const projectRepIds = new Set(
    graph.nodes.map((node) => dagProjectRepId(node.projectId)),
  );
  return collapsedIds.filter((id) => {
    if (id.startsWith(DAG_ISSUE_REP_PREFIX)) {
      const issueId = id.slice(DAG_ISSUE_REP_PREFIX.length);
      return nodeIds.has(issueId) && featureRepIds.has(issueId);
    }
    if (id.startsWith(DAG_PROJECT_REP_PREFIX)) return projectRepIds.has(id);
    return false;
  });
}

/**
 * Representatives to unfold so every given issue becomes visible. Nested
 * folding means removing one rep can leave the node inside another collapsed
 * rep (project expanded → feature still folded), so resolve iteratively
 * against a working fold set. Bounded: each round removes at least one rep or
 * stops.
 */
export function repsToRevealIssues(
  graph: IssueGraph,
  grouping: DagGrouping,
  collapsedIds: readonly string[],
  issueIds: readonly string[],
): string[] {
  const targets = new Set(issueIds);
  const removal = new Set<string>();
  let working: readonly string[] = collapsedIds;
  for (let round = 0; round < 16; round++) {
    const projection = computeDagProjection(graph, grouping, working);
    const visibleIds = new Set(projection.nodes.map((node) => node.id));
    let changed = false;
    for (const id of targets) {
      if (visibleIds.has(id)) continue;
      const rep = projection.representatives.get(id);
      if (rep && !removal.has(rep)) {
        removal.add(rep);
        changed = true;
      }
    }
    if (!changed) return [...removal];
    working = working.filter((repId) => !removal.has(repId));
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
 *   issue); both arrival kinds requeue an already-processed seed so its
 *   descent still runs. An initial seed that is never affected keeps the
 *   narrow boundary — its children do not wait on it.
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

  const issueSeen = new Set<string>();
  // Downstream propagation state: a node that a forward edge (waiter) or a
  // descent (inheritor) reached carries the wait and passes it to children.
  // Initial seeds are queued without it; either arrival kind (re)queues them.
  const affected = new Set<string>();
  const queue: string[] = [];
  const markAffected = (id: string) => {
    if (affected.has(id)) return;
    affected.add(id);
    queue.push(id);
  };
  for (const seed of seeds) {
    if (!issueSeen.has(seed)) {
      issueSeen.add(seed);
      queue.push(seed);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of edgeNext.get(current) ?? []) {
      const isNew = !issueSeen.has(next);
      if (isNew) issueSeen.add(next);
      if (way === "downstream") markAffected(next);
      else if (isNew) queue.push(next);
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
        if (!issueSeen.has(child)) issueSeen.add(child);
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
