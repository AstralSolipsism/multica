import type { Node } from "@xyflow/react";
import {
  aggregateDagDependencyState,
  type DagDependencyState,
  type DagExternalGroup,
  type DagFrame,
  type DagLineModel,
  type DagOverviewCard,
  type DagOverviewModel,
  type DagTask,
} from "@multica/core/issues/dag";
import type { DagFocusWay } from "@multica/core/issues/stores/view-store";
import type { DagSceneFrameBox, DagSceneGeometry, DagScenePlan } from "./dag-scene";
import { routeDagOverlays } from "./dag-scene-geometry";
import { dagProjectColor } from "./dag-project-colors";

/** What the canvas paints: exactly one of the two levels (the independent
 *  grid is a line level without frames or internal edges). */
export type DagCanvasModel =
  | { kind: "overview"; overview: DagOverviewModel }
  | { kind: "line"; line: DagLineModel }
  | { kind: "independent"; tasks: readonly DagTask[] };

export interface DagOverviewCardData extends Record<string, unknown> {
  card: DagOverviewCard;
  color: string;
  statusColor: string | null;
  dimmed: boolean;
}
export interface DagTaskCardData extends Record<string, unknown> {
  task: DagTask;
  statusColor: string | null;
  projectTitle: string | null;
  /** Stage pill instead of band columns when the owning frame uses labels. */
  showStage: boolean;
  dimmed: boolean;
}
export interface DagFrameData extends Record<string, unknown> {
  frame: DagFrame;
  box: DagSceneFrameBox;
  statusColor: string | null;
  projectTitle: string | null;
  selected: boolean;
}
export interface DagExternalCardData extends Record<string, unknown> {
  group: DagExternalGroup;
  side: "upstream" | "downstream";
  dimmed: boolean;
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

/** The id the scene gives an external side card; decode for the jump action. */
export function dagExternalNodeId(side: "upstream" | "downstream", groupId: string): string {
  return JSON.stringify(["external", side, groupId]);
}
export function parseDagExternalNodeId(
  id: string,
): { side: "upstream" | "downstream"; groupId: string } | null {
  try {
    const parsed = JSON.parse(id) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed[0] === "external" &&
      (parsed[1] === "upstream" || parsed[1] === "downstream") &&
      typeof parsed[2] === "string"
    )
      return { side: parsed[1], groupId: parsed[2] };
  } catch {
    /* not an external id */
  }
  return null;
}

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
  showSatisfied: boolean,
): string[] {
  const unique = [...new Set(rawIds)];
  return showSatisfied
    ? unique
    : unique.filter((id) => states.get(id) !== "satisfied");
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
  const displayed = displayedRawIds(rawIds, states, showSatisfied);
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
  const displayed = displayedRawIds([...rawIds], states, showSatisfied);
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
      };
    return {
      kind: card.kind === "line" ? "line-card" : "standalone",
      id: card.id,
      identifier: card.issue?.identifier ?? null,
      title: card.issue?.title ?? null,
      issueId: card.issue?.id ?? null,
      enterLineId: card.kind === "line" ? card.issue!.id : null,
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
    };
  if (model.kind === "line") {
    const frame = model.line.frames.find((item) => item.id === selectedId);
    if (frame)
      return {
        kind: "frame",
        id: frame.id,
        identifier: frame.issue.identifier,
        title: frame.issue.title,
        issueId: frame.issue.id,
        enterLineId: null,
      };
  }
  return null;
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
 *  connectivity — so an unselected branch sharing a trunk stays dim. */
export function dagSceneFocusSet(
  plan: DagScenePlan,
  anchorId: string,
  way: DagFocusWay,
): DagFocusSet | null {
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
  focus: DagFocusSet | null;
  selectedNodeId: string | null;
}

export function dagSceneFlowNodes(
  model: DagCanvasModel,
  options: DagFlowNodesOptions,
): DagCanvasFlowNode[] {
  const { geometry, statusColorOf, projectNames, focus, selectedNodeId } = options;
  const dimmed = (id: string) => (focus ? !focus.nodeIds.has(id) : false);
  if (model.kind === "overview") {
    return model.overview.cards.flatMap((card) => {
      const box = geometry.nodes[card.id];
      if (!box) return [];
      return [{
        id: card.id,
        type: "dagOverviewCard" as const,
        position: { x: box.x, y: box.y },
        data: {
          card,
          color: dagProjectColor(card.project?.id),
          statusColor: card.issue ? statusColorOf(card.issue.status) : null,
          dimmed: dimmed(card.id),
        },
        selected: selectedNodeId === card.id,
        draggable: false,
        zIndex: 2,
      }];
    });
  }
  const nodes: DagCanvasFlowNode[] = [];
  if (model.kind === "line") {
    const stageLabels = new Map(
      Object.entries(geometry.frames).map(([id, box]) => [id, box.stageMode === "labels"] as const),
    );
    // Frames first (parents must precede children), shallowest before deepest.
    const frameById = new Map(model.line.frames.map((frame) => [frame.id, frame]));
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
    const frames = [...model.line.frames].sort((a, b) => depth(a) - depth(b));
    for (const frame of frames) {
      const box = geometry.frames[frame.id];
      if (!box) continue;
      const { parentId, ...position } = relativePosition(box, frame.parentId, geometry);
      nodes.push({
        id: frame.id,
        type: "dagFrame" as const,
        position,
        parentId,
        data: {
          frame,
          box,
          statusColor: statusColorOf(frame.issue.status),
          projectTitle: frame.issue.projectId ? projectNames.get(frame.issue.projectId) ?? null : null,
          selected: selectedNodeId === frame.id,
        },
        draggable: false,
        selectable: false,
        zIndex: 0,
        style: { width: box.width, height: box.height },
      });
    }
    for (const task of model.line.tasks) {
      const box = geometry.nodes[task.issue.id];
      if (!box) continue;
      const { parentId, ...position } = relativePosition(box, task.parentId, geometry);
      nodes.push({
        id: task.issue.id,
        type: "dagTask" as const,
        position,
        parentId,
        data: {
          task,
          statusColor: statusColorOf(task.issue.status),
          projectTitle: task.issue.projectId ? projectNames.get(task.issue.projectId) ?? null : null,
          showStage: parentId ? stageLabels.get(parentId) === true : true,
          dimmed: dimmed(task.issue.id),
        },
        selected: selectedNodeId === task.issue.id,
        draggable: false,
        zIndex: 2,
      });
    }
    for (const side of ["upstream", "downstream"] as const) {
      for (const group of model.line[side]) {
        const id = dagExternalNodeId(side, group.id);
        const box = geometry.nodes[id];
        if (!box) continue;
        nodes.push({
          id,
          type: "dagExternal" as const,
          position: { x: box.x, y: box.y },
          data: { group, side, dimmed: dimmed(id) },
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
      data: {
        task,
        statusColor: statusColorOf(task.issue.status),
        projectTitle: task.issue.projectId ? projectNames.get(task.issue.projectId) ?? null : null,
        showStage: true,
        dimmed: false,
      },
      selected: selectedNodeId === task.issue.id,
      draggable: false,
      zIndex: 2,
    });
  }
  return nodes;
}
