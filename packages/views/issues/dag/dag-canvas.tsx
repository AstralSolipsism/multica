"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import type { IssueGraph } from "@multica/core/api";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import { useViewStore, useViewStoreApi } from "@multica/core/issues/stores/view-store-context";
import { DagFlowEdgeLine, type DagFlowEdge } from "./dag-edge";
import { toFlowNodes, selectFlowNodes, toFlowEdges, type CanvasNode } from "./dag-flow";
import {
  anchorShift,
  constrainDagViewport,
  dagViewportTargets,
  dagViewportExtent,
  sameDagViewport,
} from "./dag-viewport";
import { DagFlowNodeCard } from "./dag-node";
import { DagFlowGroupCard } from "./dag-group";
import { dagFocusNeighborhood, type DagProjection } from "./dag-projection";
import type { DagLayoutResult, DagPoint } from "./dag-layout";

import { DagPortUpdateProvider } from "./dag-ports";

const nodeTypes = { dagNode: DagFlowNodeCard, dagGroup: DagFlowGroupCard };
const edgeTypes = { dagEdge: DagFlowEdgeLine };
export interface DagCanvasCallbacks {
  onOpenIssue: (issueId: string) => void;
  onToggleCollapsed: (id: string) => void;
  onFocusGroup: (id: string) => void;
}
/** What the canvas exposes to the toolbar, which lives outside the React Flow
 *  tree: the live viewport getter (so opening an issue can persist an
 *  in-flight pan) and the anchored line toggle (so a fold keeps the line
 *  header at its screen position). */
export interface DagCanvasApi {
  getViewport: () => Viewport;
  toggleLine: (id: string) => void;
}

export interface DagCanvasProps extends DagCanvasCallbacks {
  graph: IssueGraph;
  projection: DagProjection;
  positions: ReadonlyMap<string, DagPoint>;
  geometry: DagLayoutResult;
  direction: DagDirection;
  statusColorOf: (statusKey: string) => string | null;
  focusRequest: { issueIds: string[]; groupId?: string; nonce: number } | null;
  registerCanvasApi?: (api: DagCanvasApi | null) => void;
}

export function DagCanvasInner({
  graph,
  projection,
  positions,
  geometry,
  direction,
  statusColorOf,
  focusRequest,
  onOpenIssue,
  onToggleCollapsed,
  onFocusGroup,
  registerCanvasApi,
}: DagCanvasProps) {
  const storeApi = useViewStoreApi();
  const selectedNodeId = useViewStore((s) => s.dagSelectedNodeId);
  const selectedEdgeId = useViewStore((s) => s.dagSelectedEdgeId);
  const focus = useViewStore((s) => s.dagFocus);
  const { getViewport, setViewport, getInternalNode, viewportInitialized } = useReactFlow<
    CanvasNode,
    DagFlowEdge
  >();
  const { resolvedTheme: colorMode } = useTheme();
  const initialViewport = useRef(storeApi.getState().dagViewport ?? { x: 20, y: 20, zoom: 1 });
  const anchor = useRef<{ id: string; position: DagPoint } | null>(null);
  const handledFocus = useRef(0);
  const canvasWidth = useFlowStore((state) => state.width);
  const canvasHeight = useFlowStore((state) => state.height);
  const viewportTargets = useMemo(() => dagViewportTargets(geometry), [geometry]);
  const zoom = useFlowStore((state) => state.transform[2]);
  const translateExtent = useMemo(
    () => dagViewportExtent(viewportTargets, { width: canvasWidth, height: canvasHeight }, zoom),
    [viewportTargets, canvasWidth, canvasHeight, zoom],
  );
  // React Flow installs callbacks after layout effects. Ref-backed geometry
  // prevents an older callback from undoing the new layout's correction.
  const viewportBounds = useRef({
    targets: viewportTargets,
    width: canvasWidth,
    height: canvasHeight,
  });
  viewportBounds.current = { targets: viewportTargets, width: canvasWidth, height: canvasHeight };
  const boundedViewport = useCallback((viewport: Viewport, preferredId?: string) => {
    const bounds = viewportBounds.current;
    return constrainDagViewport(viewport, bounds, bounds.targets, preferredId);
  }, []);
  const settleViewport = useCallback(() => {
    // A delayed move-end event may predate a fold or resize. Read the live
    // viewport, never persist that event's obsolete coordinates.
    const current = getViewport();
    const bounded = boundedViewport(current);
    if (!sameDagViewport(current, bounded)) void setViewport(bounded);
    storeApi.getState().setDagViewport(bounded);
  }, [boundedViewport, getViewport, setViewport, storeApi]);
  const models = useMemo(() => new Map(projection.nodes.map((n) => [n.id, n])), [projection]);
  const groupModels = useMemo(() => new Map(projection.groups.map((g) => [g.id, g])), [projection]);
  const projectNames = useMemo(
    () => new Map(graph.projects.map((p) => [p.id, p.title])),
    [graph.projects],
  );
  const focusSet = useMemo(
    () =>
      focus && models.has(focus.nodeId)
        ? dagFocusNeighborhood(projection, graph, focus.nodeId, focus.way).nodeIds
        : null,
    [focus, graph, models, projection],
  );
  const selectionContext = useMemo(() => {
    const activeGroups = new Set<string>(),
      stages = new Map<string, number>();
    let node = selectedNodeId ? models.get(selectedNodeId) : undefined;
    if (node && groupModels.has(node.id)) activeGroups.add(node.id);
    const seen = new Set<string>();
    while (node?.groupId && !seen.has(node.groupId)) {
      seen.add(node.groupId);
      activeGroups.add(node.groupId);
      if (node.issue?.stage != null) stages.set(node.groupId, node.issue.stage);
      node = models.get(node.groupId);
    }
    return { activeGroups, stages };
  }, [groupModels, models, selectedNodeId]);
  const selectNode = useCallback(
    (id: string | null) => {
      storeApi.getState().setDagSelectedNodeId(id);
    },
    [storeApi],
  );
  const selectEdge = useCallback(
    (id: string) => {
      storeApi.getState().setDagSelectedEdgeId(id);
    },
    [storeApi],
  );
  const openIssue = useCallback(
    (id: string) => {
      storeApi.getState().setDagViewport(getViewport());
      onOpenIssue(id);
    },
    [getViewport, onOpenIssue, storeApi],
  );
  const toggle = useCallback(
    (id: string) => {
      const position = positions.get(id);
      if (position) anchor.current = { id, position };
      onToggleCollapsed(id);
    },
    [onToggleCollapsed, positions],
  );
  useEffect(() => {
    registerCanvasApi?.({ getViewport, toggleLine: toggle });
    return () => registerCanvasApi?.(null);
  }, [getViewport, toggle, registerCanvasApi]);
  // Preserve the toggled header when possible, then recover only if the
  // committed content/size no longer admits the current viewport.
  useLayoutEffect(() => {
    if (!viewportInitialized || !canvasWidth || !canvasHeight) return;
    const current = getViewport();
    let nextViewport = current;
    const saved = anchor.current;
    const next = saved ? positions.get(saved.id) : undefined;
    if (saved && next && next !== saved.position) {
      anchor.current = null;
      nextViewport = anchorShift(saved.position, next, current);
    } else if (saved && !next) anchor.current = null;
    const bounded = boundedViewport(nextViewport, saved?.id);
    if (!sameDagViewport(current, bounded)) void setViewport(bounded);
  }, [
    positions,
    viewportTargets,
    canvasWidth,
    canvasHeight,
    boundedViewport,
    getViewport,
    setViewport,
    viewportInitialized,
  ]);
  useEffect(() => {
    if (!viewportInitialized || !focusRequest || handledFocus.current === focusRequest.nonce)
      return;
    const id =
      focusRequest.groupId ??
      focusRequest.issueIds
        .map((issueId) => projection.representatives.get(issueId) ?? issueId)
        .find((item) => positions.has(item));
    const position = id ? positions.get(id) : undefined;
    if (!id || !position) return;
    handledFocus.current = focusRequest.nonce;
    anchor.current = null;
    selectNode(id);
    const zoom = Math.max(0.85, getViewport().zoom);
    // Position explicit focus in one step so a delayed scroll-end callback
    // cannot interrupt a transition through empty space between task lines.
    void setViewport({ x: 24 - position.x * zoom, y: 24 - position.y * zoom, zoom });
  }, [
    focusRequest,
    getViewport,
    positions,
    projection.representatives,
    selectNode,
    setViewport,
    viewportInitialized,
  ]);
  const baseNodes = useMemo(
    () =>
      toFlowNodes({
        projection,
        positions,
        geometry,
        direction,
        projectNames,
        statusColorOf,
        measurements: new Map(
          projection.nodes.map((node) => [node.id, getInternalNode(node.id)?.measured]),
        ),
        toggle,
        onFocusGroup,
        openIssue,
      }),
    [
      projection,
      positions,
      geometry,
      direction,
      projectNames,
      statusColorOf,
      getInternalNode,
      toggle,
      onFocusGroup,
      openIssue,
    ],
  );
  const rfNodes = useMemo(
    () => selectFlowNodes(baseNodes, { selectedNodeId, focusSet, selectionContext }),
    [baseNodes, selectedNodeId, focusSet, selectionContext],
  );
  const rfEdges = useMemo(
    () =>
      toFlowEdges({
        projection,
        positions,
        geometry,
        selectedNodeId,
        selectedEdgeId,
        focusSet,
        selectEdge,
      }),
    [projection, positions, geometry, selectedNodeId, selectedEdgeId, focusSet, selectEdge],
  );
  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      for (const change of changes) {
        if (change.type !== "select") continue;
        if (change.selected) selectNode(change.id);
        else if (storeApi.getState().dagSelectedNodeId === change.id) selectNode(null);
      }
    },
    [selectNode, storeApi],
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<DagFlowEdge>[]) => {
      for (const change of changes) {
        if (change.type !== "select") continue;
        if (change.selected) selectEdge(change.id);
        else if (storeApi.getState().dagSelectedEdgeId === change.id)
          storeApi.getState().setDagSelectedEdgeId(null);
      }
    },
    [selectEdge, storeApi],
  );
  return (
    <div className="relative flex-1 min-h-0" data-dag-canvas>
      <ReactFlow<CanvasNode, DagFlowEdge>
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={initialViewport.current}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeClick={(_, node) => selectNode(node.id)}
        onNodeDoubleClick={(_, node) => {
          if (node.data.model.kind === "issue") openIssue(node.data.model.issue!.id);
        }}
        onPaneClick={() => selectNode(null)}
        translateExtent={translateExtent}
        onMoveEnd={settleViewport}
        panOnScroll
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        zoomOnPinch
        zoomActivationKeyCode={["Control", "Meta"]}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable
        elementsSelectable
        onlyRenderVisibleElements={projection.nodes.length > 100 || projection.edges.length > 500}
        minZoom={0.08}
        maxZoom={2}
        deleteKeyCode={null}
        colorMode={colorMode === "dark" ? "dark" : "light"}
        className="bg-background"
      >
        <Background gap={24} size={1} className="stroke-border/40" bgColor="transparent" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>
    </div>
  );
}

export default function DagCanvas(props: DagCanvasProps) {
  return (
    <ReactFlowProvider>
      <DagPortUpdateProvider><DagCanvasInner {...props} /></DagPortUpdateProvider>
    </ReactFlowProvider>
  );
}
