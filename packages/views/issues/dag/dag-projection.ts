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
  /** Self or any folded member has queued/dispatched/running/waiting rows. */
  hasActiveRun: boolean;
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
  /** Representatives that exist in the current graph, regardless of grouping:
   *  every present project rep plus every issue with a visible child. Folded
   *  ids outside this set are stale and pruned by the view. */
  existingRepIds: Set<string>;
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

/** Representatives that exist for pruning purposes (grouping-independent). */
export function existingDagRepIds(graph: IssueGraph): Set<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes) ids.add(dagProjectRepId(node.projectId));
  for (const id of dagFeatureRepIds(graph)) ids.add(dagFeatureRepId(id));
  return ids;
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

function hasActiveRun(node: IssueGraphNode): boolean {
  const run = node.runSummary;
  if (!run) return false;
  return (
    run.queued > 0 ||
    run.dispatched > 0 ||
    run.running > 0 ||
    run.waitingLocalDirectory > 0
  );
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

  // Pass 2: feature folding. A surviving node folds into its nearest visible
  // collapsed feature ancestor; ancestors already folded into a project are
  // skipped (their representative cannot accept members it cannot show).
  const representatives = new Map<string, string>();
  for (const node of graph.nodes) {
    if (afterProject.get(node.id) !== node.id) continue;
    const visited = new Set<string>([node.id]);
    let current = node.parentIssueId;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      if (
        afterProject.get(current) === current &&
        featureRepIds.has(current) &&
        collapsed.has(dagFeatureRepId(current))
      ) {
        representatives.set(node.id, dagFeatureRepId(current));
        break;
      }
      current = nodesById.get(current)?.parentIssueId ?? null;
    }
  }
  // A collapsed feature that survived project folding renders AS its
  // representative, so edges to/from the feature itself land on the rep node.
  for (const node of graph.nodes) {
    if (
      afterProject.get(node.id) === node.id &&
      featureRepIds.has(node.id) &&
      collapsed.has(dagFeatureRepId(node.id))
    ) {
      representatives.set(node.id, dagFeatureRepId(node.id));
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
      hasActiveRun: memberNodes.some(hasActiveRun),
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
    existingRepIds: existingDagRepIds(graph),
    foldedNodeCount,
  };
}

/** Drop folded ids whose representative no longer exists in the graph while
 *  keeping every other personal entry untouched. */
export function pruneDagCollapsedIds(
  collapsedIds: readonly string[],
  existingRepIds: ReadonlySet<string>,
): string[] {
  return collapsedIds.filter((id) => existingRepIds.has(id));
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
 * The visible neighborhood a focus action highlights. Upstream walks reversed
 * edges (everything this node waits on, directly or through aggregates), then
 * adds the ancestor chain — inherited prerequisites enter the explanation
 * through a visible ancestor's own direct edges. Downstream walks forward
 * edges. All ids are canvas node ids: ancestors translate through the fold
 * map so a folded ancestor lights its representative instead of a ghost.
 */
export function dagFocusNeighborhood(
  projection: DagProjection,
  graph: IssueGraph,
  nodeId: string,
  way: "upstream" | "downstream",
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of projection.edges) {
    const from = way === "upstream" ? edge.target : edge.source;
    const to = way === "upstream" ? edge.source : edge.target;
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  }
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  const drain = () => {
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  };
  drain();

  if (way === "upstream") {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const canvasId = (issueId: string) =>
      projection.representatives.get(issueId) ?? issueId;
    const starts = [...seen];
    for (const start of starts) {
      // Canvas ids double as issue ids for plain nodes; a feature rep carries
      // its issue behind the prefix; project reps have no parent chain.
      const startIssueId = start.startsWith(DAG_ISSUE_REP_PREFIX)
        ? start.slice(DAG_ISSUE_REP_PREFIX.length)
        : start;
      let current = nodesById.get(startIssueId)?.parentIssueId ?? null;
      const guard = new Set<string>();
      while (current !== null && !guard.has(current)) {
        guard.add(current);
        const visibleId = canvasId(current);
        if (seen.has(visibleId)) break;
        seen.add(visibleId);
        queue.push(visibleId);
        current = nodesById.get(current)?.parentIssueId ?? null;
      }
    }
    drain();
  }
  return seen;
}
