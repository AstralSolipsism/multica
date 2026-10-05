import { MarkerType } from "@xyflow/react";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import type { DagFlowNode, DagFlowNodeData } from "./dag-node";
import type { DagFlowGroup } from "./dag-group";
import type { DagFlowEdge } from "./dag-edge";
import type { DagProjection } from "./dag-projection";
import type { DagLayoutResult, DagPoint, DagPort } from "./dag-layout";
import { dagNodeSize } from "./dag-constants";

export type CanvasNode = DagFlowNode | DagFlowGroup;
const NO_PORTS: DagPort[] = [];

interface FlowGeometry {
  projection: DagProjection;
  positions: ReadonlyMap<string, DagPoint>;
  geometry: DagLayoutResult;
}

interface FlowSelection {
  selectedNodeId: string | null;
  focusSet: ReadonlySet<string> | null;
}

/** Map committed layout geometry to React Flow without touching its store. */
export function toFlowNodes({
  projection,
  positions,
  geometry,
  direction,
  projectNames,
  statusColorOf,
  measurements,
  toggle,
  onFocusGroup,
  openIssue,
}: FlowGeometry & {
  direction: DagDirection;
  projectNames: ReadonlyMap<string, string>;
  statusColorOf: (statusKey: string) => string | null;
  measurements: ReadonlyMap<string, CanvasNode["measured"]>;
  toggle: (id: string) => void;
  onFocusGroup: (id: string) => void;
  openIssue: (id: string) => void;
}): CanvasNode[] {
  const models = new Map(projection.nodes.map((node) => [node.id, node]));
  const groupModels = new Map(
    projection.groups.map((group) => [group.id, group]),
  );
  return projection.nodes.flatMap((model): CanvasNode[] => {
    const absolute = positions.get(model.id);
    if (!absolute) return [];
    const group = groupModels.get(model.id),
      bounds = geometry.groups[model.id];
    if (group && !bounds) return [];
    const parent = model.groupId ? positions.get(model.groupId) : undefined;
    const parentIssue = model.groupId ? models.get(model.groupId)?.issue : null;
    const projectTitle =
      model.issue?.projectId &&
      (group || model.issue.projectId !== parentIssue?.projectId)
        ? (projectNames.get(model.issue.projectId) ?? null)
        : null;
    const data: DagFlowNodeData = {
      model,
      projectTitle,
      statusColor: model.issue ? statusColorOf(model.issue.status) : null,
      ports: geometry.ports[model.id] ?? NO_PORTS,
      showStage:
        !model.groupId || !geometry.groups[model.groupId]?.bands.length,
      focused: false,
      dimmed: false,
    };
    const size = bounds ?? dagNodeSize(model.kind);
    const shared = {
      id: model.id,
      position: parent
        ? { x: absolute.x - parent.x, y: absolute.y - parent.y }
        : absolute,
      parentId: model.groupId ?? undefined,
      width: size.width,
      height: size.height,
      style: { width: size.width, height: size.height },
      measured: measurements.get(model.id),
      selected: false,
      draggable: false,
      connectable: false,
    };
    if (group && bounds)
      return [
        {
          ...shared,
          type: "dagGroup",
          zIndex: 0,
          data: {
            ...data,
            group,
            bounds,
            direction,
            activeStage: null,
            onToggle: toggle,
            onFocus: onFocusGroup,
            onOpen: openIssue,
          },
        },
      ];
    return [{ ...shared, type: "dagNode", zIndex: 2, data }];
  });
}

/** Preserve the base node objects for cards unaffected by selection or focus. */
export function selectFlowNodes(
  baseNodes: readonly CanvasNode[],
  {
    selectedNodeId,
    focusSet,
    selectionContext,
  }: FlowSelection & {
    selectionContext: {
      activeGroups: ReadonlySet<string>;
      stages: ReadonlyMap<string, number>;
    };
  },
): CanvasNode[] {
  return baseNodes.map((node) => {
    const selected = selectedNodeId === node.id;
    if (node.type === "dagGroup") {
      const focused =
        selectionContext.activeGroups.has(node.id) ||
        focusSet?.has(node.id) === true;
      return {
        ...node,
        selected,
        data: {
          ...node.data,
          focused,
          activeStage: selectionContext.stages.get(node.id) ?? null,
        },
      };
    }
    const focused = selected || focusSet?.has(node.id) === true;
    return selected || focused
      ? { ...node, selected, data: { ...node.data, focused } }
      : node;
  });
}

export function toFlowEdges({
  projection,
  positions,
  geometry,
  selectedNodeId,
  selectedEdgeId,
  focusSet,
  selectEdge,
}: FlowGeometry &
  FlowSelection & {
    selectedEdgeId: string | null;
    selectEdge: (id: string) => void;
  }): DagFlowEdge[] {
  const groupModels = new Map(
    projection.groups.map((group) => [group.id, group]),
  );
  return projection.edges.flatMap((model): DagFlowEdge[] => {
    const route = geometry.routes[model.id];
    if (!route || !positions.has(model.source) || !positions.has(model.target))
      return [];
    const focused = focusSet
      ? focusSet.has(model.source) && focusSet.has(model.target)
      : model.source === selectedNodeId || model.target === selectedNodeId;
    const aggregate =
      model.sourceEdgeIds.length > 1 ||
      groupModels.get(model.source)?.collapsed === true ||
      groupModels.get(model.target)?.collapsed === true;
    return [
      {
        id: model.id,
        source: model.source,
        target: model.target,
        sourceHandle: `source:${model.id}`,
        targetHandle: `target:${model.id}`,
        type: "dagEdge",
        zIndex: 1,
        selected: selectedEdgeId === model.id,
        data: { model, focused, aggregate, route, onSelect: selectEdge },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color:
            focused || selectedEdgeId === model.id
              ? "var(--brand)"
              : "var(--muted-foreground)",
        },
      },
    ];
  });
}
