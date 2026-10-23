import type { DagDependency, DagFocusModel, DagFrame, DagLineModel, DagOverviewModel, DagTask } from "@multica/core/issues/dag";
import { DAG_EXTERNAL_SIZE, DAG_NODE_HEIGHT, DAG_NODE_WIDTH, DAG_OVERVIEW_SIZE } from "./dag-constants";
import { dagExternalNodeId, type DagSceneEdge, type DagSceneNode, type DagScenePlan, type DagSceneSide } from "./dag-scene";

function edgeInput({ id, source, target, sourceKind, targetKind }: DagDependency): DagSceneEdge {
  return { id, source, target, sourceKind, targetKind };
}
function taskInput(task: DagTask) {
  return { id: task.issue.id, parentId: task.parentId, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT, stage: task.issue.stage };
}
function frameInput(frame: DagFrame) {
  return { id: frame.id, modelId: frame.id, parentId: frame.parentId };
}

export function dagOverviewLayoutInput(model: DagOverviewModel): DagScenePlan {
  const edges: DagSceneEdge[] = [], overlays: DagSceneEdge[] = [];
  const dependencyIds: Record<string, string[]> = {}, overlayDependencyIds: Record<string, string[]> = {};
  for (const edge of model.dependencies) {
    const input = { id: edge.id, source: edge.source, target: edge.target, sourceKind: "task" as const, targetKind: "task" as const };
    if (edge.state === "satisfied") {
      overlays.push(input);
      overlayDependencyIds[edge.id] = edge.sourceEdgeIds;
    } else {
      edges.push(input);
      dependencyIds[edge.id] = edge.sourceEdgeIds;
    }
  }
  return {
    input: { kind: "overview", id: "overview", nodes: model.cards.map((card) => ({ id: card.id, parentId: null, ...DAG_OVERVIEW_SIZE, stage: null })), frames: [], edges },
    dependencyIds, overlays, overlayDependencyIds,
  };
}

/** Selecting or focusing an overview card can include satisfied subsets of
 *  mixed bundles without a layout call. */
export function dagOverviewSatisfiedEdges(model: DagOverviewModel, cardId: string) {
  return (model.satisfiedByCard.get(cardId) ?? []).map((edge) => ({
    edge: { id: edge.id, source: edge.source, target: edge.target, sourceKind: "task" as const, targetKind: "task" as const },
    dependencyIds: edge.sourceEdgeIds,
  }));
}

export function dagLineLayoutInput(model: DagLineModel): DagScenePlan {
  const nodes: DagSceneNode[] = model.tasks.map(taskInput);
  const edges = model.dependencies.filter((e) => !e.hiddenByDefault).map(edgeInput);
  const dependencyIds = Object.fromEntries(edges.map((e) => [e.id, [e.id]]));
  for (const side of ["upstream", "downstream"] as const) {
    for (const group of model[side]) {
      const id = dagExternalNodeId(side, group.id);
      nodes.push({ id, parentId: null, ...DAG_EXTERNAL_SIZE, stage: null, side });
      for (const dependency of group.dependencies) {
        edges.push({ ...edgeInput(dependency), ...(side === "upstream" ? { source: id, sourceKind: "task" as const } : { target: id, targetKind: "task" as const }) });
        dependencyIds[dependency.id] = [dependency.id];
      }
    }
  }
  return { input: { kind: "line", id: model.id, nodes, frames: model.frames.map(frameInput), edges }, dependencyIds, overlays: [], overlayDependencyIds: {} };
}

/** Independent members are already resolved by the overview/model index. */
export function dagIndependentLayoutInput(tasks: readonly DagTask[]): DagScenePlan {
  return { input: { kind: "line", id: "independent:root", nodes: tasks.map((task) => ({ ...taskInput(task), parentId: null })), frames: [], edges: [], grid: true }, dependencyIds: {}, overlays: [], overlayDependencyIds: {} };
}

export function dagFocusLayoutInput(model: DagFocusModel): DagScenePlan {
  const sideOf = (id: string): DagSceneSide => {
    const upstream = model.upstreamIds.has(id);
    if (id === model.issueId || (upstream && model.downstreamIds.has(id))) return "current";
    // Upstream traversal already includes ancestors. Any remaining context
    // ancestor therefore belongs to a downstream member (including cancelled ones).
    return upstream ? "upstream" : "downstream";
  };
  const frames = model.groups.flatMap((group) => group.frames);
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const input: DagScenePlan["input"] = { kind: "focus", id: model.issueId, nodes: [], frames: [], edges: [] };
  const present = new Set<string>();
  // A line that straddles the focus appears in separate side fragments. This
  // preserves strict upstream/current/downstream placement without overlapping
  // frames; modelId lets the UI give all fragments the same line identity.
  function includeFrame(id: string | null, side: DagSceneSide): string | null {
    const frame = byId.get(id ?? "");
    if (!frame) return null;
    const key = JSON.stringify(["focus-frame", side, frame.id]);
    if (!present.has(key)) {
      present.add(key);
      const parentId = includeFrame(frame.parentId, side);
      input.frames.push({ id: key, modelId: frame.id, parentId, side });
    }
    return key;
  }
  for (const group of model.groups) {
    for (const task of group.tasks) {
      const side = sideOf(task.issue.id);
      input.nodes.push({ ...taskInput(task), parentId: includeFrame(task.parentId, side), side });
    }
  }
  // Members and dependency endpoints create their own containing fragments.
  // Only the seed frame itself needs a fragment without either of those.
  includeFrame(model.issueId, "current");
  const endpoint = (id: string, kind: "task" | "frame") => kind === "frame" ? includeFrame(id, sideOf(id))! : id;
  input.edges = model.dependencies.map((edge) => ({ ...edgeInput(edge), source: endpoint(edge.source, edge.sourceKind), target: endpoint(edge.target, edge.targetKind) }));
  return { input, dependencyIds: Object.fromEntries(input.edges.map((e) => [e.id, [e.id]])), overlays: [], overlayDependencyIds: {} };
}
