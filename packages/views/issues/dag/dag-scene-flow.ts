import type { Node } from "@xyflow/react";
import {
  aggregateDagDependencyState,
  type DagDependencyState,
  type DagExternalGroup,
  type DagFrame,
  type DagFocusModel,
  type DagLineModel,
  type DagOverviewCard,
  type DagOverviewModel,
  type DagTask,
} from "@multica/core/issues/dag";
import type { DagFocusWay } from "@multica/core/issues/stores/view-store";
import { dagExternalNodeId, type DagSceneFrameBox, type DagSceneGeometry, type DagScenePlan } from "./dag-scene";
import { dagFocusLayoutInput } from "./dag-scene-inputs";
import { routeDagOverlays } from "./dag-scene-geometry";

/** What the canvas paints: exactly one navigation level (the independent
 *  grid is a line level without frames or internal edges). */
export type DagCanvasModel =
  | { kind: "overview"; overview: DagOverviewModel }
  | { kind: "line"; line: DagLineModel }
  | { kind: "focus"; focus: DagFocusModel; tasks: DagTask[]; frames: DagFrame[]; plan: DagScenePlan }
  | { kind: "independent"; tasks: readonly DagTask[] };

/** Fragment IDs belong to the scene; backing issues retain their raw identity. */
export function dagFocusCanvasModel(focus: DagFocusModel): Extract<DagCanvasModel, { kind: "focus" }> {
  const plan = dagFocusLayoutInput(focus);
  const frames = new Map(focus.groups.flatMap((group) => group.frames).map((frame) => [frame.id, frame]));
  const parents = new Map(plan.input.nodes.map((node) => [node.id, node.parentId]));
  return {
    kind: "focus", focus, plan,
    frames: plan.input.frames.map((frame) => ({ ...frames.get(frame.modelId)!, id: frame.id, parentId: frame.parentId })),
    tasks: focus.groups.flatMap((group) => group.tasks).map((task) => ({ ...task, parentId: parents.get(task.issue.id) ?? null })),
  };
}

export interface DagOverviewCardData extends Record<string, unknown> {
  card: DagOverviewCard;
  statusColor: string | null;
  /** Zoom degradation: the card renders as a plain block without text. */
  simplified?: boolean;
}
export interface DagTaskCardData extends Record<string, unknown> {
  task: DagTask;
  statusColor: string | null;
  projectTitle: string | null;
  /** Stage pill instead of band columns when the owning frame uses labels. */
  showStage: boolean;
  simplified?: boolean;
}
export interface DagFrameData extends Record<string, unknown> {
  frame: DagFrame;
  box: DagSceneFrameBox;
  statusColor: string | null;
  projectTitle: string | null;
  /** Zoom degradation: the frame renders as a plain block without text. */
  simplified?: boolean;
}
export interface DagExternalCardData extends Record<string, unknown> {
  group: DagExternalGroup;
  side: "upstream" | "downstream";
  simplified?: boolean;
}
export interface DagFrameData extends Record<string, unknown> {
  frame: DagFrame;
  box: DagSceneFrameBox;
  statusColor: string | null;
  projectTitle: string | null;
  /** Zoom degradation: the frame renders as a plain block without text. */
  simplified?: boolean;
}
export interface DagExternalCardData extends Record<string, unknown> {
  group: DagExternalGroup;
  side: "upstream" | "downstream";
  simplified?: boolean;
}

export type DagOverviewFlowNode = Node<DagOverviewCardData, "dagOverviewCard">;
export type DagTaskFlowNode = Node<DagTaskCardData, "dagTask">;
export type DagFrameFlowNode = Node<DagFrameData, "dagFrame">;
export type DagExternalFlowNode = Node<DagExternalCardData, "dagExternal">;
export type DagCanvasFlowNode =
  | DagOverviewFlowNode
  | DagTaskFlowNode
  | DagFrameFlowNode
  | DagExternalFlowNode;


/** Raw dependency id -> state, for resolving segment/junction membership
 *  through the current plan. Never cached on the geometry. */
export function dagDependencyStates(
  model: DagCanvasModel,
): ReadonlyMap<string, DagDependencyState> {
  const states = new Map<string, DagDependencyState>();
  if (model.kind === "overview") {
    const bundles = [
      ...model.overview.dependencies,
      ...[...model.overview.satisfiedByCard.values()].flat(),
    ];
    for (const bundle of bundles)
      for (const dependency of bundle.dependencies) states.set(dependency.id, dependency.state);
  } else if (model.kind === "focus") {
    for (const dependency of model.focus.dependencies) states.set(dependency.id, dependency.state);
  } else if (model.kind === "line") {
    for (const dependency of model.line.dependencies) states.set(dependency.id, dependency.state);
    for (const side of ["upstream", "downstream"] as const)
      for (const group of model.line[side])
        for (const dependency of group.dependencies) states.set(dependency.id, dependency.state);
  }
  return states;
}

export interface DagEdgeDisplay {
  /** Displayed dependency count: satisfied originals ride a mixed bundle's
   *  trunk but only enter the number when the satisfied switch is on. */
  count: number;
  state: DagDependencyState;
}

function displayedRawIds(
  rawIds: readonly string[],
  states: ReadonlyMap<string, DagDependencyState>,
  filterSatisfied: boolean,
): string[] {
  const unique = [...new Set(rawIds)];
  return filterSatisfied
    ? unique.filter((id) => states.get(id) !== "satisfied")
    : unique;
}

/** The satisfied switch filters only inter-line surfaces (overview bundles and
 *  the external side cards, the latter already filtered in the model). Edges
 *  inside a line always paint, whatever their state. */
function filtersSatisfied(plan: DagScenePlan, showSatisfied: boolean): boolean {
  return plan.input.kind === "overview" && !showSatisfied;
}

/** Per scene edge (overview bundle or single line dependency). */
export function dagSceneEdgeDisplay(
  plan: DagScenePlan,
  edgeId: string,
  states: ReadonlyMap<string, DagDependencyState>,
  showSatisfied: boolean,
): DagEdgeDisplay | null {
  const rawIds = plan.dependencyIds[edgeId] ?? plan.overlayDependencyIds[edgeId];
  if (!rawIds) return null;
  const displayed = displayedRawIds(rawIds, states, filtersSatisfied(plan, showSatisfied));
  if (!displayed.length) return null;
  return {
    count: displayed.length,
    state: aggregateDagDependencyState(
      displayed.map((id) => states.get(id) ?? "blocking"),
    ),
  };
}

export interface DagSegmentDisplay {
  state: DagDependencyState;
  count: number;
  width: number;
}

/** One painted interval: the worst state and the deduped dependency count of
 *  everything sharing it, so an overlay can never paint over a blocker. */
export function dagSegmentDisplay(
  segmentEdgeIds: readonly string[],
  plan: DagScenePlan,
  states: ReadonlyMap<string, DagDependencyState>,
  showSatisfied: boolean,
): DagSegmentDisplay | null {
  const rawIds = new Set<string>();
  for (const edgeId of segmentEdgeIds) {
    const ids = plan.dependencyIds[edgeId] ?? plan.overlayDependencyIds[edgeId];
    if (ids) for (const id of ids) rawIds.add(id);
  }
  const displayed = displayedRawIds([...rawIds], states, filtersSatisfied(plan, showSatisfied));
  if (!displayed.length) return null;
  return {
    state: aggregateDagDependencyState(
      displayed.map((id) => states.get(id) ?? "blocking"),
    ),
    count: displayed.length,
    width: displayed.length > 3 ? 3 : displayed.length > 1 ? 2.2 : 1.4,
  };
}

/** Line-level satisfied filter: the switch covers inter-line dependencies, so
 *  only the external side groups are filtered — internal edges always paint.
 *  Groups left empty disappear, which is a layout input change by design. */
export function dagLineWithSatisfiedFilter(
  line: DagLineModel,
  showSatisfied: boolean,
): DagLineModel {
  if (showSatisfied) return line;
  const filterGroups = (groups: readonly DagExternalGroup[]): DagExternalGroup[] =>
    groups.flatMap((group) => {
      const dependencies = group.dependencies.filter((d) => d.state !== "satisfied");
      return dependencies.length
        ? [{ ...group, dependencies, count: dependencies.length }]
        : [];
    });
  return {
    ...line,
    upstream: filterGroups(line.upstream),
    downstream: filterGroups(line.downstream),
  };
}

export type DagSelectionKind =
  | "line-card"
  | "standalone"
  | "independent"
  | "task"
  | "frame";

export interface DagSelectionTarget {
  kind: DagSelectionKind;
  id: string;
  identifier: string | null;
  title: string | null;
  /** Backing issue for open/edit/assign; the independent card has none. */
  issueId: string | null;
  /** Cards that open a second level carry their line id here. */
  enterLineId: string | null;
  /** Line-level members can recenter on their innermost sub-line frame. */
  focusFrameId: string | null;
}

/** Resolve the store's selected node id against the painted model. */
export function resolveDagSelection(
  model: DagCanvasModel,
  selectedId: string | null,
): DagSelectionTarget | null {
  if (!selectedId) return null;
  if (model.kind === "overview") {
    const card = model.overview.cards.find((c) => c.id === selectedId);
    if (!card) return null;
    if (card.kind === "independent")
      return {
        kind: "independent",
        id: card.id,
        identifier: null,
        title: null,
        issueId: null,
        enterLineId: card.id,
        focusFrameId: null,
      };
    return {
      kind: card.kind === "line" ? "line-card" : "standalone",
      id: card.id,
      identifier: card.issue?.identifier ?? null,
      title: card.issue?.title ?? null,
      issueId: card.issue?.id ?? null,
      enterLineId: card.kind === "line" ? card.issue!.id : null,
      focusFrameId: null,
    };
  }
  const tasks = model.kind === "line" ? model.line.tasks : model.tasks;
  const task = tasks.find((item) => item.issue.id === selectedId);
  if (task)
    return {
      kind: "task",
      id: task.issue.id,
      identifier: task.issue.identifier,
      title: task.issue.title,
      issueId: task.issue.id,
      enterLineId: null,
      focusFrameId: task.parentId,
    };
  if (model.kind === "line" || model.kind === "focus") {
    const frame = (model.kind === "line" ? model.line.frames : model.frames).find((item) => item.id === selectedId);
    if (frame)
      return {
        kind: "frame",
        id: frame.id,
        identifier: frame.issue.identifier,
        title: frame.issue.title,
        issueId: frame.issue.id,
        enterLineId: null,
        focusFrameId: frame.id,
      };
  }
  return null;
}

/** Idle-zone statistics over the painted content: match/context counts come
 *  from the model; the dependency count follows the same display rules as the
 *  painted edges (satisfied originals count only when the switch is on, and
 *  never inside a line). */
export function dagSceneStats(
  model: DagCanvasModel,
  plan: DagScenePlan | null,
  showSatisfied: boolean,
): { matched: number; context: number; edges: number } {
  if (model.kind === "overview") {
    let matched = 0,
      context = 0;
    for (const card of model.overview.cards) {
      matched += card.matchCount;
      context += card.contextCount;
    }
    let edges = 0;
    if (plan) {
      const states = dagDependencyStates(model);
      for (const edgeId of [
        ...plan.input.edges.map((e) => e.id),
        ...(showSatisfied ? plan.overlays.map((e) => e.id) : []),
      ]) {
        edges += dagSceneEdgeDisplay(plan, edgeId, states, showSatisfied)?.count ?? 0;
      }
    }
    return { matched, context, edges };
  }
  if (model.kind === "focus") {
    const members = new Map([
      ...model.tasks.map((task) => [task.issue.id, task.role] as const),
      ...model.frames.map((frame) => [frame.issue.id, frame.contextOnly ? "context" : frame.issue.role] as const),
    ]);
    const matched = [...members.values()].filter((role) => role === "match").length;
    return { matched, context: members.size - matched, edges: model.focus.dependencies.length };
  }
  if (model.kind === "line") {
    const members = model.line.input.members;
    return {
      matched: members.filter((m) => m.role === "match").length,
      context: members.filter((m) => m.role !== "match").length,
      edges:
        model.line.dependencies.filter((d) => !d.hiddenByDefault).length +
        model.line.upstream.reduce((n, g) => n + g.count, 0) +
        model.line.downstream.reduce((n, g) => n + g.count, 0),
    };
  }
  return {
    matched: model.tasks.filter((task) => task.role === "match").length,
    context: model.tasks.filter((task) => task.role !== "match").length,
    edges: 0,
  };
}

/** How many tasks on the focused chain are hidden behind the completed
 *  filter. The overview is the only level that hides lines, so the hint
 *  belongs there; the closure walks the raw graph, and "hidden" means the
 *  task has no visible overview card. */
export function dagFocusHiddenCount(params: {
  edges: readonly { source: string; target: string }[];
  card: DagOverviewCard;
  representatives: ReadonlyMap<string, string>;
  way: DagFocusWay;
}): number {
  const { edges, card, representatives, way } = params;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const links: [string, string][] =
      way === "both"
        ? [
            [edge.target, edge.source],
            [edge.source, edge.target],
          ]
        : [[way === "upstream" ? edge.target : edge.source, way === "upstream" ? edge.source : edge.target]];
    for (const [from, to] of links) {
      const list = adjacency.get(from) ?? [];
      list.push(to);
      adjacency.set(from, list);
    }
  }
  const seen = new Set(card.memberIds);
  const stack = [...card.memberIds];
  let hidden = 0;
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (!representatives.has(next)) hidden++;
      stack.push(next);
    }
  }
  return hidden;
}

/** The displayed route set: base geometry, or base + satisfied overlays when
 *  the switch is on. Overlay composition never moves boxes. */
export function dagDisplayedRoutes(
  geometry: DagSceneGeometry,
  plan: DagScenePlan,
  showSatisfied: boolean,
): { routes: Record<string, import("./dag-scene").DagPoint[]>; segments: DagSceneGeometry["segments"]; junctions: DagSceneGeometry["junctions"] } {
  if (!showSatisfied || plan.overlays.length === 0)
    return { routes: geometry.routes, segments: geometry.segments, junctions: geometry.junctions };
  const composed = routeDagOverlays(geometry, plan.overlays, plan.input.edges);
  return composed;
}

export interface DagFocusSet {
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
}

/** Neighborhood highlight walks real dependencies only — never geometric bus
 *  connectivity — so an unselected branch sharing a trunk stays dim. "both"
 *  unions the upstream and downstream closures (the click-cycle mode); it is
 *  not an undirected walk, which would pull in sibling branches. */
export function dagSceneFocusSet(
  plan: DagScenePlan,
  anchorId: string,
  way: DagFocusWay,
): DagFocusSet | null {
  if (way === "both") {
    const upstream = dagSceneFocusSet(plan, anchorId, "upstream");
    const downstream = dagSceneFocusSet(plan, anchorId, "downstream");
    return {
      nodeIds: new Set([...(upstream?.nodeIds ?? []), ...(downstream?.nodeIds ?? [])]),
      edgeIds: new Set([...(upstream?.edgeIds ?? []), ...(downstream?.edgeIds ?? [])]),
    };
  }
  const edges = [...plan.input.edges, ...plan.overlays];
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const byEndpoint = new Map<string, string[]>();
  for (const edge of edges) {
    (forward.get(edge.source) ?? forward.set(edge.source, []).get(edge.source)!).push(edge.target);
    (backward.get(edge.target) ?? backward.set(edge.target, []).get(edge.target)!).push(edge.source);
    const key = way === "upstream" ? edge.target : edge.source;
    (byEndpoint.get(key) ?? byEndpoint.set(key, []).get(key)!).push(edge.id);
  }
  const adjacency = way === "upstream" ? backward : forward;
  const nodeIds = new Set<string>([anchorId]);
  const edgeIds = new Set<string>();
  const stack = [anchorId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of adjacency.get(id) ?? []) {
      if (nodeIds.has(next)) continue;
      nodeIds.add(next);
      stack.push(next);
    }
    for (const edgeId of byEndpoint.get(id) ?? []) edgeIds.add(edgeId);
  }
  return { nodeIds, edgeIds };
}

function relativePosition(
  box: { x: number; y: number },
  parentId: string | null,
  geometry: DagSceneGeometry,
): { x: number; y: number; parentId: string | undefined } {
  const parent = parentId ? geometry.frames[parentId] : undefined;
  if (!parent) return { x: box.x, y: box.y, parentId: undefined };
  return { x: box.x - parent.x, y: box.y - parent.y, parentId: parentId! };
}

export interface DagFlowNodesOptions {
  geometry: DagSceneGeometry;
  statusColorOf: (statusKey: string) => string | null;
  projectNames: ReadonlyMap<string, string>;
}

export function dagSceneFlowNodes(
  model: DagCanvasModel,
  options: DagFlowNodesOptions,
): DagCanvasFlowNode[] {
  const { geometry, statusColorOf, projectNames } = options;
  if (model.kind === "overview") {
    return model.overview.cards.flatMap((card) => {
      const box = geometry.nodes[card.id];
      if (!box) return [];
      return [{
        id: card.id,
        type: "dagOverviewCard" as const,
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        data: {
          card,
          statusColor: card.issue ? statusColorOf(card.issue.status) : null,
        },
        selected: false,
        draggable: false,
        zIndex: 2,
      }];
    });
  }
  const nodes: DagCanvasFlowNode[] = [];
  if (model.kind === "line" || model.kind === "focus") {
    const detail = model.kind === "line" ? model.line : model;
    const stageLabels = new Map(
      Object.entries(geometry.frames).map(([id, box]) => [id, box.stageMode === "labels"] as const),
    );
    // Frames first (parents must precede children), shallowest before deepest.
    const frameById = new Map(detail.frames.map((frame) => [frame.id, frame]));
    const depth = (frame: DagFrame): number => {
      let d = 0;
      let current: DagFrame | undefined = frame;
      const seen = new Set<string>();
      while (current?.parentId && !seen.has(current.id)) {
        seen.add(current.id);
        d++;
        current = frameById.get(current.parentId);
      }
      return d;
    };
    const frames = [...detail.frames].sort((a, b) => depth(a) - depth(b));
    for (const frame of frames) {
      const box = geometry.frames[frame.id];
      if (!box) continue;
      const { parentId, ...position } = relativePosition(box, frame.parentId, geometry);
      nodes.push({
        id: frame.id,
        type: "dagFrame" as const,
        position,
        parentId,
        width: box.width,
        height: box.height,
        data: {
          frame,
          box,
          statusColor: statusColorOf(frame.issue.status),
          projectTitle: frame.issue.projectId ? projectNames.get(frame.issue.projectId) ?? null : null,
        },
        draggable: false,
        selectable: false,
        zIndex: 0,
        style: { width: box.width, height: box.height },
      });
    }
    for (const task of detail.tasks) {
      const box = geometry.nodes[task.issue.id];
      if (!box) continue;
      const { parentId, ...position } = relativePosition(box, task.parentId, geometry);
      nodes.push({
        id: task.issue.id,
        type: "dagTask" as const,
        position,
        parentId,
        width: box.width,
        height: box.height,
        data: {
          task,
          statusColor: statusColorOf(task.issue.status),
          projectTitle: task.issue.projectId ? projectNames.get(task.issue.projectId) ?? null : null,
          showStage: parentId ? stageLabels.get(parentId) === true : true,
        },
        selected: false,
        draggable: false,
        zIndex: 2,
      });
    }
    if (model.kind === "line") for (const side of ["upstream", "downstream"] as const) {
      for (const group of model.line[side]) {
        const id = dagExternalNodeId(side, group.id);
        const box = geometry.nodes[id];
        if (!box) continue;
        nodes.push({
          id,
          type: "dagExternal" as const,
          position: { x: box.x, y: box.y },
          width: box.width,
          height: box.height,
          data: { group, side },
          draggable: false,
          selectable: false,
          zIndex: 2,
        });
      }
    }
    return nodes;
  }
  // independent grid: flat task cards, no frames or internal edges
  for (const task of model.tasks) {
    const box = geometry.nodes[task.issue.id];
    if (!box) continue;
    nodes.push({
      id: task.issue.id,
      type: "dagTask" as const,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      data: {
        task,
        statusColor: statusColorOf(task.issue.status),
        projectTitle: task.issue.projectId ? projectNames.get(task.issue.projectId) ?? null : null,
        showStage: true,
      },
      selected: false,
      draggable: false,
      zIndex: 2,
    });
  }
  return nodes;
}
