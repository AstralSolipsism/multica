"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useReactFlow,
  useStore as useFlowStore,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import {
  dagLevelViewportKey,
  type DagLevel,
} from "./dag-level";
import {
  constrainDagViewport,
  dagViewportExtent,
  dagViewportTargets,
  sameDagViewport,
} from "./dag-viewport";
import { dagSceneFlowNodes, dagSceneFocusSet, type DagCanvasFlowNode, type DagCanvasModel, type DagFocusSet } from "./dag-scene-flow";
import type { DagSceneGeometry, DagScenePlan } from "./dag-scene";
import type { DagExternalGroup } from "@multica/core/issues/dag";
import { DagOverviewCardView } from "./dag-overview-card";
import { DagTaskCard } from "./dag-task-card";
import { DagFrameNode } from "./dag-frame-node";
import { DagExternalCard } from "./dag-external-card";
import { DagEdgeLayer } from "./dag-edge-layer";
import { DagCanvasActionsContext, type DagCanvasActions } from "./dag-canvas-actions";
import type { DagFocusRequest } from "./dag-view";
import {
  dagCullBounds,
  dagCullBoundsKey,
  dagDependencyEdgeIds,
  dagOverviewHoverOverlay,
  dagSceneSelectionSet,
  dagWithAncestorFrames,
  type DagGhostBlock,
} from "./dag-highlight";
import { dagExternalNodeId } from "./dag-scene";
import { dagProjectColor } from "./dag-project-colors";
import { DAG_CLICK_CYCLE_MS, DAG_GROUP_HEADER_HEIGHT, DAG_MINIMAP_NODE_LIMIT, DAG_MOTION_MIN_ZOOM, DAG_SIMPLIFIED_ZOOM } from "./dag-constants";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

const nodeTypes = {
  dagOverviewCard: DagOverviewCardView,
  dagTask: DagTaskCard,
  dagFrame: DagFrameNode,
  dagExternal: DagExternalCard,
};

export interface DagSceneCanvasApi {
  getViewport: () => Viewport;
}

/** A pending canvas recenter on one original dependency (bus dropdown's
 *  定位): the canvas owns the geometry, so it resolves the painted endpoints. */
export interface DagLocateRequest {
  dependencyId: string;
  nonce: number;
}

export interface DagSceneCanvasProps {
  /** The painted level, derived from the painted plan — during a level switch
   *  the previous level stays interactive until the new layout lands. */
  level: DagLevel;
  model: DagCanvasModel;
  geometry: DagSceneGeometry;
  plan: DagScenePlan;
  statusColorOf: (statusKey: string) => string | null;
  projectNames: ReadonlyMap<string, string>;
  showSatisfied: boolean;
  focusRequest: DagFocusRequest | null;
  locateRequest: DagLocateRequest | null;
  onEnterLine: (lineId: string) => void;
  onOpenIssue: (issueId: string) => void;
  onExternalJump: (group: DagExternalGroup, side: "upstream" | "downstream") => void;
  registerCanvasApi?: (api: DagSceneCanvasApi | null) => void;
}

/** Zoom degradation swaps cards to their plain block only where the flag
 *  actually differs; at simplified zoom a selection change must not clone
 *  (and re-render) every node. */
function applySimplified(
  nodes: DagCanvasFlowNode[],
  simplified: boolean,
): DagCanvasFlowNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if ((node.data.simplified === true) === simplified) return node;
    changed = true;
    switch (node.type) {
      case "dagOverviewCard":
        return { ...node, data: { ...node.data, simplified } };
      case "dagTask":
        return { ...node, data: { ...node.data, simplified } };
      case "dagFrame":
        return { ...node, data: { ...node.data, simplified } };
      case "dagExternal":
        return { ...node, data: { ...node.data, simplified } };
    }
  });
  return changed ? next : nodes;
}

export function DagSceneCanvasInner({
  level,
  model,
  geometry,
  plan,
  statusColorOf,
  projectNames,
  showSatisfied,
  focusRequest,
  locateRequest,
  onEnterLine,
  onOpenIssue,
  onExternalJump,
  registerCanvasApi,
}: DagSceneCanvasProps) {
  const storeApi = useViewStoreApi();
  const selectedNodeId = useViewStore((s) => s.dagSelectedNodeId);
  const focusState = useViewStore((s) => s.dagFocus);
  const selectedDependencyIds = useViewStore((s) => s.dagSelectedDependencyIds);
  const { getViewport, setViewport, fitView, viewportInitialized } =
    useReactFlow();
  const { resolvedTheme: colorMode } = useTheme();
  const canvasWidth = useFlowStore((state) => state.width);
  const canvasHeight = useFlowStore((state) => state.height);
  const viewportKey = dagLevelViewportKey(level);
  const handledFocus = useRef(0);
  const handledLocate = useRef(0);
  const viewportTargets = useMemo(
    () => dagViewportTargets(geometry),
    [geometry],
  );
  // Re-render on 0.1-quantized zoom steps only: wheel gestures would
  // otherwise re-render the whole canvas on every frame.
  const zoom = useFlowStore((state) => Math.round(state.transform[2] * 10) / 10);
  const reducedMotion = usePrefersReducedMotion();
  // Culling re-renders the edge layer only when the visible window crosses a
  // quantization boundary, not on every pan frame.
  const cullKey = useFlowStore((state) =>
    dagCullBoundsKey(state.transform, { width: state.width, height: state.height }),
  );
  const cullBounds = useMemo(() => dagCullBounds(cullKey), [cullKey]);
  const simplified = zoom < DAG_SIMPLIFIED_ZOOM;
  const motionZoom = zoom >= DAG_MOTION_MIN_ZOOM ? 1 : 0;
  const translateExtent = useMemo(
    () => dagViewportExtent(viewportTargets, { width: canvasWidth, height: canvasHeight }, zoom),
    [viewportTargets, canvasWidth, canvasHeight, zoom],
  );
  const viewportBounds = useRef({
    targets: viewportTargets,
    width: canvasWidth,
    height: canvasHeight,
  });
  viewportBounds.current = { targets: viewportTargets, width: canvasWidth, height: canvasHeight };
  const boundedViewport = useCallback(
    (viewport: Viewport, preferredId?: string) =>
      constrainDagViewport(viewport, viewportBounds.current, viewportBounds.current.targets, preferredId),
    [],
  );
  const persistViewport = useCallback(() => {
    const current = getViewport();
    const bounded = boundedViewport(current);
    if (!sameDagViewport(current, bounded)) void setViewport(bounded);
    storeApi.getState().setDagViewportFor(viewportKey, bounded);
  }, [boundedViewport, getViewport, setViewport, storeApi, viewportKey]);

  // Level switches restore that level's remembered viewport; a level opened
  // for the first time fits its content.
  const appliedViewportKey = useRef<string | null>(null);
  useEffect(() => {
    if (!viewportInitialized || appliedViewportKey.current === viewportKey) return;
    appliedViewportKey.current = viewportKey;
    const stored = storeApi.getState().dagViewports[viewportKey];
    if (stored) void setViewport(stored);
    else void fitView({ padding: 0.15, maxZoom: 1 });
  }, [viewportKey, viewportInitialized, geometry, setViewport, fitView, storeApi]);

  // Data refreshes keep the viewport but pull it back inside the content.
  useEffect(() => {
    if (!viewportInitialized || !canvasWidth || !canvasHeight) return;
    const current = getViewport();
    const bounded = boundedViewport(current);
    if (!sameDagViewport(current, bounded)) void setViewport(bounded);
  }, [geometry, viewportTargets, canvasWidth, canvasHeight, boundedViewport, getViewport, setViewport, viewportInitialized]);

  useEffect(() => {
    registerCanvasApi?.({ getViewport });
    return () => registerCanvasApi?.(null);
  }, [getViewport, registerCanvasApi]);

  useEffect(() => {
    if (!viewportInitialized || !focusRequest || handledFocus.current === focusRequest.nonce)
      return;
    // The request targets a level: wait until that scene is painted (a jump
    // from a line to an overview card arrives before the overview geometry).
    const paintedKind = level.kind === "overview" ? "overview" : "line";
    if (paintedKind !== focusRequest.level) return;
    // Same level but no such node: drop it — waiting longer would fire a
    // surprise jump when the target appears for an unrelated reason.
    handledFocus.current = focusRequest.nonce;
    const box = geometry.nodes[focusRequest.id] ?? geometry.frames[focusRequest.id];
    if (!box) return;
    storeApi.getState().setDagSelectedNodeId(focusRequest.id);
    const zoom = Math.max(0.85, getViewport().zoom);
    void setViewport({ x: 24 - box.x * zoom, y: 24 - box.y * zoom, zoom });
  }, [focusRequest, geometry, level, getViewport, setViewport, storeApi, viewportInitialized]);

  // The bus dropdown's 定位: center the dependency's painted endpoints.
  useEffect(() => {
    if (!viewportInitialized || !locateRequest || handledLocate.current === locateRequest.nonce)
      return;
    handledLocate.current = locateRequest.nonce;
    const edgeIds = dagDependencyEdgeIds(plan, new Set([locateRequest.dependencyId]));
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const edge of [...plan.input.edges, ...plan.overlays]) {
      if (!edgeIds.has(edge.id)) continue;
      for (const id of [edge.source, edge.target]) {
        const box = geometry.nodes[id] ?? geometry.frames[id];
        if (!box) continue;
        x0 = Math.min(x0, box.x);
        y0 = Math.min(y0, box.y);
        x1 = Math.max(x1, box.x + box.width);
        y1 = Math.max(y1, box.y + box.height);
      }
    }
    if (x0 > x1 || !canvasWidth || !canvasHeight) return;
    const zoom = Math.max(0.85, getViewport().zoom);
    void setViewport({
      x: canvasWidth / 2 - ((x0 + x1) / 2) * zoom,
      y: canvasHeight / 2 - ((y0 + y1) / 2) * zoom,
      zoom,
    });
  }, [locateRequest, plan, geometry, canvasWidth, canvasHeight, getViewport, setViewport, viewportInitialized]);

  // Hover highlight: applied only once the pointer (and the content under it)
  // has been still for a beat — during a pan the cursor sweeps dozens of
  // cards and enter/leave storms would re-render the highlight every frame.
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const paneDragging = useFlowStore((state) => state.paneDragging);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyHover = useCallback((id: string | null) => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (id === null) {
      setHoverNodeId(null);
      return;
    }
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setHoverNodeId(id);
    }, 100);
  }, []);
  useEffect(() => {
    if (paneDragging) applyHover(null);
  }, [paneDragging, applyHover]);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  // Highlight sets ------------------------------------------------------------
  // Hover wins while the pointer rests on a card; the toolbar's transitive
  // focus outranks the one-click neighborhood; a bus selection lights its
  // dependencies on top of either. Hover is debounced (see above).
  const hoverOverlay = useMemo(
    () => (hoverNodeId ? dagOverviewHoverOverlay(model, geometry, hoverNodeId) : null),
    [hoverNodeId, model, geometry],
  );
  const hoverSet = useMemo<DagFocusSet | null>(() => {
    if (!hoverNodeId) return null;
    const base = dagSceneSelectionSet(plan, hoverNodeId);
    if (!base && !hoverOverlay) return null;
    return {
      nodeIds: new Set([...(base?.nodeIds ?? []), ...(hoverOverlay?.nodeIds ?? [])]),
      edgeIds: new Set([...(base?.edgeIds ?? []), ...(hoverOverlay?.edgeIds ?? [])]),
    };
  }, [hoverNodeId, plan, hoverOverlay]);
  const focusSet = useMemo(() => {
    const set = focusState ? dagSceneFocusSet(plan, focusState.nodeId, focusState.way) : null;
    return set ? { ...set, nodeIds: dagWithAncestorFrames(plan, set.nodeIds) } : null;
  }, [focusState, plan]);
  const selectionSet = useMemo(
    () => (selectedNodeId ? dagSceneSelectionSet(plan, selectedNodeId) : null),
    [selectedNodeId, plan],
  );
  const activeNodeSet = hoverSet ?? focusSet ?? selectionSet;
  const busEdgeIds = useMemo(
    () =>
      selectedDependencyIds?.length
        ? dagDependencyEdgeIds(plan, new Set(selectedDependencyIds))
        : null,
    [selectedDependencyIds, plan],
  );
  const highlightedEdgeIds = useMemo(() => {
    const nodeEdges = activeNodeSet?.edgeIds;
    if (!nodeEdges?.size && !busEdgeIds?.size) return null;
    return new Set([...(nodeEdges ?? []), ...(busEdgeIds ?? [])]);
  }, [activeNodeSet, busEdgeIds]);
  // Node dimming is a masked overlay, not a per-card rebuild: the lit cards
  // (and lit frames' headers) stay visible through holes in the dim rect.
  const litBoxes = useMemo(() => {
    if (!activeNodeSet) return null;
    const boxes: { id: string; x: number; y: number; width: number; height: number }[] = [];
    for (const id of activeNodeSet.nodeIds) {
      const node = geometry.nodes[id];
      if (node) {
        boxes.push({ id, ...node });
        continue;
      }
      const frame = geometry.frames[id];
      if (frame) boxes.push({ id, x: frame.x, y: frame.y, width: frame.width, height: DAG_GROUP_HEADER_HEIGHT });
    }
    return boxes;
  }, [activeNodeSet, geometry]);

  const baseNodes = useMemo(
    () =>
      dagSceneFlowNodes(model, {
        geometry,
        statusColorOf,
        projectNames,
      }),
    [model, geometry, statusColorOf, projectNames],
  );
  const nodes = useMemo(
    () => applySimplified(baseNodes, simplified),
    [baseNodes, simplified],
  );
  // Below the readability zoom the cards paint as SVG rects inside the edge
  // layer; the DOM nodes above stay as transparent interaction shells. The
  // block list stays stable across selection changes — the selected block
  // resolves separately so a click never rebuilds a thousand blocks.
  const ghostBlocks = useMemo<DagGhostBlock[] | null>(() => {
    if (!simplified) return null;
    const blocks: DagGhostBlock[] = [];
    if (model.kind === "overview") {
      for (const card of model.overview.cards) {
        const box = geometry.nodes[card.id];
        if (!box) continue;
        blocks.push({
          id: card.id,
          ...box,
          kind: "overview",
          color: dagProjectColor(card.project?.id, colorMode === "dark"),
          dashed: card.cancelledBlocking,
        });
      }
      return blocks;
    }
    if (model.kind === "line") {
      for (const frame of model.line.frames) {
        const box = geometry.frames[frame.id];
        if (!box) continue;
        blocks.push({
          id: frame.id,
          ...box,
          kind: "frame",
          color: null,
          dashed: false,
        });
      }
      for (const side of ["upstream", "downstream"] as const) {
        for (const group of model.line[side]) {
          const id = dagExternalNodeId(side, group.id);
          const box = geometry.nodes[id];
          if (!box) continue;
          blocks.push({ id, ...box, kind: "external", color: null, dashed: true });
        }
      }
    }
    const tasks = model.kind === "line" ? model.line.tasks : model.tasks;
    for (const task of tasks) {
      const box = geometry.nodes[task.issue.id];
      if (!box) continue;
      blocks.push({
        id: task.issue.id,
        ...box,
        kind: "task",
        color: null,
        dashed: task.role === "context" || task.cancelledBlocking,
      });
    }
    return blocks;
  }, [simplified, model, geometry, colorMode]);

  const actions = useMemo<DagCanvasActions>(() => ({ onExternalJump }), [onExternalJump]);
  const handleNodesChange = useCallback(
    (changes: NodeChange<DagCanvasFlowNode>[]) => {
      for (const change of changes) {
        if (change.type !== "select") continue;
        const state = storeApi.getState();
        if (change.selected) state.setDagSelectedNodeId(change.id);
        else if (state.dagSelectedNodeId === change.id) state.setDagSelectedNodeId(null);
      }
    },
    [storeApi],
  );
  const handleBusClick = useCallback(
    (dependencyIds: string[]) => storeApi.getState().setDagSelectedDependencyIds(dependencyIds),
    [storeApi],
  );
  // The click cycle: one click selects with the one-layer neighborhood; a
  // second single click on the same node switches to all upstream +
  // downstream; a third returns. The second click only lands once the
  // double-click window has passed, and any click with detail > 1 belongs to
  // a double-click — the double-click handler owns that gesture.
  const cycleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCycle = useCallback(() => {
    if (cycleTimer.current) {
      clearTimeout(cycleTimer.current);
      cycleTimer.current = null;
    }
  }, []);
  useEffect(() => cancelCycle, [cancelCycle]);
  const handleNodeClick = useCallback(
    (node: DagCanvasFlowNode, detail: number) => {
      if (node.type === "dagExternal") return;
      if (detail > 1) return;
      cancelCycle();
      // Compare against the last committed selection, never getState():
      // React Flow's own select change lands in the store during this same
      // click, so the store always reports the node as already selected and
      // every first click would wrongly arm the cycle.
      if (selectedNodeId !== node.id) {
        storeApi.getState().setDagSelectedNodeId(node.id);
        return;
      }
      cycleTimer.current = setTimeout(() => {
        cycleTimer.current = null;
        const current = storeApi.getState();
        if (current.dagSelectedNodeId !== node.id) return;
        const focus = current.dagFocus;
        current.setDagFocus(
          focus?.nodeId === node.id && focus.way === "both"
            ? null
            : { nodeId: node.id, way: "both" },
        );
      }, DAG_CLICK_CYCLE_MS);
    },
    [cancelCycle, selectedNodeId, storeApi],
  );
  return (
    <div
      className="relative flex-1 min-h-0"
      data-dag-canvas
      onKeyDown={(event) => {
        // Nodes never carry a selected flag (the ring paints in the edge
        // layer), so React Flow's own Escape-to-unselect cannot fire; the
        // canvas clears the selection itself.
        if (event.key === "Escape") storeApi.getState().setDagSelectedNodeId(null);
      }}
    >
      <DagCanvasActionsContext.Provider value={actions}>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 20, y: 20, zoom: 1 }}
          onNodesChange={handleNodesChange}
          onNodeClick={(event, node) => handleNodeClick(node, event.detail)}
          onNodeMouseEnter={(_, node) => {
            if (!paneDragging) applyHover(node.id);
          }}
          onNodeMouseLeave={() => applyHover(null)}
          onNodeDoubleClick={(_, node) => {
            // A double-click keeps its original action and never advances the
            // click cycle — cancel the pending switch from its first click.
            cancelCycle();
            if (node.type === "dagOverviewCard") {
              const { card } = node.data;
              if (card.kind === "issue") onOpenIssue(card.issue!.id);
              else onEnterLine(card.kind === "independent" ? card.id : card.issue!.id);
            } else if (node.type === "dagTask") {
              onOpenIssue(node.data.task.issue.id);
            }
          }}
          onPaneClick={() => {
            cancelCycle();
            storeApi.getState().setDagSelectedNodeId(null);
          }}
          translateExtent={translateExtent}
          onMoveEnd={persistViewport}
          panOnScroll
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          zoomOnPinch
          zoomActivationKeyCode={["Control", "Meta"]}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable
          edgesFocusable={false}
          elementsSelectable
          onlyRenderVisibleElements={nodes.length > 100}
          minZoom={0.08}
          maxZoom={2}
          deleteKeyCode={null}
          colorMode={colorMode === "dark" ? "dark" : "light"}
          className="bg-background"
        >
          <ViewportPortal>
            <DagEdgeLayer
              geometry={geometry}
              plan={plan}
              model={model}
              showSatisfied={showSatisfied}
              highlightedEdgeIds={highlightedEdgeIds}
              hoverOverlay={hoverOverlay}
              litBoxes={litBoxes}
              ghostBlocks={ghostBlocks}
              selectedNodeId={selectedNodeId}
              bounds={cullBounds}
              degraded={simplified}
              motion={{ zoom: motionZoom, reducedMotion }}
              onBusClick={handleBusClick}
            />
          </ViewportPortal>
          <Background gap={24} size={1} className="stroke-border/40" bgColor="transparent" />
          <Controls showInteractive={false} position="bottom-left" />
          {nodes.length <= DAG_MINIMAP_NODE_LIMIT && (
            <MiniMap pannable zoomable className="!bg-card" />
          )}
        </ReactFlow>
      </DagCanvasActionsContext.Provider>
    </div>
  );
}

export default function DagSceneCanvas(props: DagSceneCanvasProps) {
  return (
    <ReactFlowProvider>
      <DagSceneCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
