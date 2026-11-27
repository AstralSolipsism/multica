import type {
  DagFocusModel,
  DagLineModel,
  DagModelIndex,
  DagTask,
} from "@multica/core/issues/dag";
import { DAG_EXTERNAL_SIZE, DAG_NODE_HEIGHT, DAG_NODE_WIDTH } from "./dag-constants";
import { dagExternalNodeId, type DagSceneEdge, type DagScenePlan, type DagSceneSide } from "./dag-scene";
import { dagFocusCanvasModel, type DagCanvasModel } from "./dag-scene-flow";
import { dagLineLayoutInput } from "./dag-scene-inputs";

/** Adds only display-only wakeup context. Strong blocker models stay intact;
 * external endpoints still use the repository's DagExternalCard. */
export function starMapLineScene(line: DagLineModel, index: DagModelIndex) {
  const upstream = line.upstream.map((group) => ({ ...group, dependencies: [...group.dependencies] }));
  const downstream = line.downstream.map((group) => ({ ...group, dependencies: [...group.dependencies] }));
  const model: DagLineModel = { ...line, upstream, downstream };
  const plan = dagLineLayoutInput(model);
  const members = new Set(line.input.members.map((member) => member.issue.id));

  for (const edge of index.weakEdges) {
    if (edge.kind !== "wakeup") continue;
    const fromInside = members.has(edge.from);
    const toInside = members.has(edge.to);
    if (fromInside === toInside) continue;
    const side: DagSceneSide = toInside ? "upstream" : "downstream";
    const insideId = toInside ? edge.to : edge.from;
    const outsideId = toInside ? edge.from : edge.to;
    const rootId = index.rootOf.get(outsideId) ?? outsideId;
    if (rootId === line.id || !index.issues.has(rootId)) continue;
    const externalId = dagExternalNodeId(side, rootId);
    const groups = model[side];
    let group = groups.find((candidate) => candidate.id === rootId);
    if (!group) {
      const issue = index.issues.get(rootId)!;
      group = {
        id: rootId,
        kind: index.forest.children.has(rootId) ? "line" : "issue",
        issue,
        project: index.projects.get(issue.projectId ?? "") ?? null,
        count: 0,
        dependencies: [],
      };
      groups.push(group);
      plan.input.nodes.push({ id: externalId, parentId: null, ...DAG_EXTERNAL_SIZE, stage: null, side });
    }
    group.count++;
    const insideKind = index.forest.children.has(insideId) ? "frame" : "task";
    plan.input.edges.push({
      id: `wakeup:${edge.from}:${edge.to}`,
      source: toInside ? externalId : insideId,
      target: toInside ? insideId : externalId,
      sourceKind: toInside ? "task" : insideKind,
      targetKind: toInside ? insideKind : "task",
      kind: "wakeup",
      untilState: edge.untilState,
    });
  }
  return { model: { kind: "line" as const, line: model }, plan };
}

function focusEndpoint(plan: DagScenePlan, issueId: string, index: DagModelIndex) {
  if (plan.input.nodes.some((node) => node.id === issueId))
    return { id: issueId, kind: "task" as const };
  const frame = plan.input.frames.find((candidate) => candidate.modelId === issueId && candidate.side === "current")
    ?? plan.input.frames.find((candidate) => candidate.modelId === issueId);
  if (frame) return { id: frame.id, kind: "frame" as const };
  return index.forest.children.has(issueId) ? null : { id: issueId, kind: "task" as const };
}

/** Focus keeps computeDagFocus topology and appends wakeup peers as dashed
 * context task cards on the correct left/right side. */
export function starMapFocusScene(focus: DagFocusModel, index: DagModelIndex) {
  const base = dagFocusCanvasModel(focus);
  const plan: DagScenePlan = {
    ...base.plan,
    input: { ...base.plan.input, nodes: [...base.plan.input.nodes], edges: [...base.plan.input.edges] },
    dependencyIds: { ...base.plan.dependencyIds },
  };
  const tasks: DagTask[] = [...base.tasks];
  const present = new Set(tasks.map((task) => task.issue.id));
  for (const frame of plan.input.frames) present.add(frame.modelId);

  for (const edge of index.weakEdges) {
    if (edge.kind !== "wakeup") continue;
    const fromInside = present.has(edge.from);
    const toInside = present.has(edge.to);
    if (fromInside === toInside) continue;
    const from = focusEndpoint(plan, edge.from, index);
    const to = focusEndpoint(plan, edge.to, index);
    if (!from || !to) continue;
    const outsideId = toInside ? edge.from : edge.to;
    const issue = index.issues.get(outsideId);
    if (!issue) continue;
    const side: DagSceneSide = toInside ? "upstream" : "downstream";
    if (!present.has(outsideId)) {
      present.add(outsideId);
      tasks.push({ issue, parentId: null, isFrame: false, role: "context" });
      plan.input.nodes.push({
        id: outsideId,
        parentId: null,
        width: DAG_NODE_WIDTH,
        height: DAG_NODE_HEIGHT,
        stage: issue.stage,
        side,
      });
    }
    const sceneEdge: DagSceneEdge = {
      id: `wakeup:${edge.from}:${edge.to}`,
      source: from.id,
      target: to.id,
      sourceKind: from.kind,
      targetKind: to.kind,
      kind: "wakeup",
      untilState: edge.untilState,
    };
    plan.input.edges.push(sceneEdge);
  }
  const model: Extract<DagCanvasModel, { kind: "focus" }> = { ...base, tasks, plan };
  return { model, plan };
}
