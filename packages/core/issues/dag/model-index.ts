import { replaceEqualDeep } from "@tanstack/react-query";
import type { IssueGraph, IssueGraphNode } from "../../api/issue-graph-schemas";
import { dagDisplayForest, dagDescendants, dagCompletedVisibility, dagIndependentIssueIds } from "./projection";
import { dagDependencyState, dagIssueFinished, type DagDependencyState } from "./state";
import { createDagTraversal } from "./traversal";

/** Snapshot timestamps belong to the transport, not to a line's display
 * identity. A polling refresh with identical counters must preserve it. */
export type DagIssue = Omit<IssueGraphNode, "runSummary"> & {
  runSummary: Omit<NonNullable<IssueGraphNode["runSummary"]>, "capturedAt"> | null;
};

function modelIssue(issue: IssueGraphNode): DagIssue {
  const run = issue.runSummary;
  return { ...issue, runSummary: run ? {
    queued: run.queued, dispatched: run.dispatched, running: run.running, waitingLocalDirectory: run.waitingLocalDirectory,
  } : null };
}

export interface DagDependency {
  id: string;
  source: string;
  target: string;
  state: DagDependencyState;
  sourceKind: "frame" | "task";
  targetKind: "frame" | "task";
}

export interface DagTask {
  issue: DagIssue;
  /** Repaired display parent; the original payload is never modified. */
  parentId: string | null;
  isFrame: boolean;
  role: "match" | "context";
  cancelledBlocking: boolean;
}

export interface DagExternalGroup {
  id: string;
  kind: "line" | "issue";
  issue: DagIssue;
  project: IssueGraph["projects"][number] | null;
  count: number;
  dependencies: DagDependency[];
}

export interface DagLineInput {
  id: string;
  members: DagTask[];
  project: IssueGraph["projects"][number] | null;
  dependencies: DagDependency[];
  upstream: DagExternalGroup[];
  downstream: DagExternalGroup[];
  hasRestrictedContext: boolean;
}

export interface DagModelIndex {
  graph: IssueGraph;
  issues: ReadonlyMap<string, DagIssue>;
  forest: ReturnType<typeof dagDisplayForest>;
  traversal: ReturnType<typeof createDagTraversal>;
  rootOf: ReadonlyMap<string, string>;
  subtreeFinished: ReadonlyMap<string, boolean>;
  projects: ReadonlyMap<string, IssueGraph["projects"][number]>;
  lineInputs: ReadonlyMap<string, DagLineInput>;
  dependencies: readonly DagDependency[];
  cancelledBlockedIds: ReadonlySet<string>;
  visibility: ReturnType<typeof dagCompletedVisibility>;
  independentIds: ReadonlySet<string>;
}

/** Build once per authorized snapshot. The three model builders share this
 * index; no layout, query, or canvas state is embedded in a model. */
export function createDagModelIndex(graph: IssueGraph, previous?: DagModelIndex): DagModelIndex {
  const forest = dagDisplayForest(graph);
  const issues = new Map(graph.nodes.map((node) => [node.id, modelIssue(node)]));
  const traversal = createDagTraversal(graph, forest);
  const rootOf = new Map<string, string>();
  const subtreeFinished = new Map<string, boolean>();
  const projects = new Map(graph.projects.map((p) => [p.id, p]));
  const lineInputs = new Map<string, DagLineInput>();
  for (const root of forest.roots) {
    const members = dagDescendants(forest.children, root);
    for (const member of members) rootOf.set(member.id, root.id);
    for (let i = members.length - 1; i >= 0; i--) {
      const member = members[i]!;
      subtreeFinished.set(member.id, dagIssueFinished(member) &&
        (forest.children.get(member.id) ?? []).every((child) => subtreeFinished.get(child.id)));
    }
    lineInputs.set(root.id, {
      id: root.id,
      members: members.map((issue) => ({
        issue: issues.get(issue.id)!, parentId: forest.parentOf.get(issue.id) ?? null, isFrame: forest.children.has(issue.id),
        role: issue.role, cancelledBlocking: false,
      })),
      project: projects.get(root.projectId ?? "") ?? null,
      dependencies: [], upstream: [], downstream: [],
      hasRestrictedContext: graph.hasRestrictedContext,
    });
  }
  const dependencies: DagDependency[] = [];
  const cancelledBlockedIds = new Set<string>();
  const external = new Map<string, DagExternalGroup>();
  function addExternal(lineId: string, otherId: string, way: "upstream" | "downstream", edge: DagDependency) {
    const key = JSON.stringify([lineId, otherId, way]);
    let group = external.get(key);
    if (!group) {
      const issue = issues.get(otherId)!;
      group = {
        id: otherId, kind: forest.children.has(otherId) ? "line" : "issue", issue,
        project: projects.get(issue.projectId ?? "") ?? null, count: 0, dependencies: [],
      };
      external.set(key, group);
      lineInputs.get(lineId)![way].push(group);
    }
    group.dependencies.push(edge);
    group.count++;
  }
  for (const edge of graph.edges) {
    const source = forest.byId.get(edge.source), target = forest.byId.get(edge.target);
    if (!source || !target) continue;
    const dependency: DagDependency = {
      id: edge.sourceEdgeId, source: source.id, target: target.id,
      state: dagDependencyState(source, subtreeFinished.get(target.id) === true),
      sourceKind: forest.children.has(source.id) ? "frame" : "task",
      targetKind: forest.children.has(target.id) ? "frame" : "task",
    };
    dependencies.push(dependency);
    if (dependency.state === "cancelled-blocking") cancelledBlockedIds.add(target.id);
    const sourceRoot = rootOf.get(source.id)!, targetRoot = rootOf.get(target.id)!;
    if (sourceRoot === targetRoot) lineInputs.get(sourceRoot)!.dependencies.push(dependency);
    else {
      addExternal(sourceRoot, targetRoot, "downstream", dependency);
      addExternal(targetRoot, sourceRoot, "upstream", dependency);
    }
  }
  // Share unchanged line inputs across snapshots, including independently
  // parsed snapshots. External endpoint states/projects are part of the input.
  for (const [id, input] of lineInputs) {
    lineInputs.set(id, replaceEqualDeep(previous?.lineInputs.get(id), input));
  }
  return {
    graph, issues, forest, traversal, rootOf, subtreeFinished, projects, lineInputs,
    dependencies, cancelledBlockedIds, visibility: dagCompletedVisibility(graph, forest),
    independentIds: dagIndependentIssueIds(graph, forest),
  };
}
