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
 * Drop only PROVABLY inert folds: an `issue:` rep whose feature is present in
 * the current graph but no longer has any visible child. Everything else
 * stays — a filtered-out or permission-hidden owner is not proof of
 * deletion, and pruning it would silently discard a valid personal
 * preference (OL-38 §8 allows cleanup only when the owner id is invalid).
 */
export function pruneDagCollapsedIds(
  collapsedIds: readonly string[],
  graph: IssueGraph,
): string[] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const featureRepIds = dagFeatureRepIds(graph);
  return collapsedIds.filter((id) => {
    if (!id.startsWith(DAG_ISSUE_REP_PREFIX)) return true;
    const issueId = id.slice(DAG_ISSUE_REP_PREFIX.length);
    if (!nodeIds.has(issueId)) return true;
    return featureRepIds.has(issueId);
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
 * The visible neighborhood a focus action highlights, computed to a fixpoint
 * over BOTH relations the dependency semantics mix:
 *
 * - upstream: reversed dependency edges (everything the node waits on,
 *   directly or through aggregates) plus ancestor ascent from every reached
 *   node — inherited prerequisites enter through a visible ancestor's own
 *   direct edges, and ascent repeats for newly reached nodes until the set
 *   stops growing. An ancestor is inheritance CONTEXT, not a prerequisite of
 *   its own: the parent's status never counts as a wait condition.
 * - downstream: forward dependency edges plus descent into the children of
 *   every reached NON-root node — they inherit the wait. The root's own
 *   children are excluded: a child does not wait on its parent's dependents.
 *
 * All ids are canvas node ids: issue ids translate through the fold map so a
 * folded ancestor/descendant lights its representative instead of a ghost.
 */
export function dagFocusNeighborhood(
  projection: DagProjection,
  graph: IssueGraph,
  nodeId: string,
  way: "upstream" | "downstream",
): Set<string> {
  const edgeNext = new Map<string, string[]>();
  for (const edge of projection.edges) {
    const from = way === "upstream" ? edge.target : edge.source;
    const to = way === "upstream" ? edge.source : edge.target;
    const list = edgeNext.get(from) ?? [];
    list.push(to);
    edgeNext.set(from, list);
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const canvasId = (issueId: string) =>
    projection.representatives.get(issueId) ?? issueId;
  const membersByCanvasId = new Map<string, string[]>();
  for (const node of projection.nodes) {
    membersByCanvasId.set(node.id, node.memberIds);
  }
  // The issues a canvas node speaks for when ascending/descending the
  // hierarchy: itself for plain issues, the carried issue for feature reps,
  // all folded members for project reps.
  const hierarchySeeds = (canvasNodeId: string): string[] => {
    if (canvasNodeId.startsWith(DAG_ISSUE_REP_PREFIX)) {
      return [canvasNodeId.slice(DAG_ISSUE_REP_PREFIX.length)];
    }
    return membersByCanvasId.get(canvasNodeId) ?? [canvasNodeId];
  };

  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of edgeNext.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
    for (const seed of hierarchySeeds(current)) {
      if (way === "upstream") {
        // Ancestors of every reached node are inheritance sources.
        let ancestor = nodesById.get(seed)?.parentIssueId ?? null;
        const guard = new Set<string>();
        while (ancestor !== null && !guard.has(ancestor)) {
          guard.add(ancestor);
          const visibleId = canvasId(ancestor);
          ancestor = nodesById.get(ancestor)?.parentIssueId ?? null;
          if (seen.has(visibleId)) continue;
          seen.add(visibleId);
          queue.push(visibleId);
        }
      } else if (current !== nodeId) {
        // Descendants of a reached node inherit its wait — but the root's own
        // children never wait on the root.
        for (const candidate of graph.nodes) {
          if (candidate.parentIssueId !== seed) continue;
          const visibleId = canvasId(candidate.id);
          if (seen.has(visibleId)) continue;
          seen.add(visibleId);
          queue.push(visibleId);
        }
      }
    }
  }
  return seen;
}
