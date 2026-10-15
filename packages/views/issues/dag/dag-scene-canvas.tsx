"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
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
import { dagSceneFlowNodes, dagSceneFocusSet, type DagCanvasFlowNode, type DagCanvasModel } from "./dag-scene-flow";
import type { DagSceneGeometry, DagScenePlan } from "./dag-scene";
import type { DagExternalGroup } from "@multica/core/issues/dag";
import { DagOverviewCardView } from "./dag-overview-card";
import { DagTaskCard } from "./dag-task-card";
import { DagFrameNode } from "./dag-frame-node";
import { DagExternalCard } from "./dag-external-card";
import { DagEdgeLayer } from "./dag-edge-layer";
import { DagCanvasActionsContext, type DagCanvasActions } from "./dag-canvas-actions";

const nodeTypes = {
  dagOverviewCard: DagOverviewCardView,
  dagTask: DagTaskCard,
  dagFrame: DagFrameNode,
  dagExternal: DagExternalCard,
};

export interface DagSceneCanvasApi {
  getViewport: () => Viewport;
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
  focusRequest: { id: string; level: "overview" | "line" | "focus"; nonce: number } | null;
  onEnterLine: (lineId: string) => void;
  onOpenIssue: (issueId: string) => void;
  onExternalJump: (group: DagExternalGroup, side: "upstream" | "downstream") => void;
  registerCanvasApi?: (api: DagSceneCanvasApi | null) => void;
}

/** Reapply store-driven selection without rebuilding unchanged nodes. */
function applySelection(
  nodes: DagCanvasFlowNode[],
  selectedNodeId: string | null,
): DagCanvasFlowNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    const selected = node.id === selectedNodeId;
    if (node.type === "dagFrame" || node.type === "dagExternal") {
      if (node.type === "dagFrame" && node.data.selected !== selected) {
        changed = true;
        return { ...node, data: { ...node.data, selected } };
      }
      return node;
    }
    if ((node.selected ?? false) === selected) return node;
    changed = true;
    return { ...node, selected };
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
  onEnterLine,
  onOpenIssue,
  onExternalJump,
  registerCanvasApi,
}: DagSceneCanvasProps) {
  const storeApi = useViewStoreApi();
  const selectedNodeId = useViewStore((s) => s.dagSelectedNodeId);
  const focusState = useViewStore((s) => s.dagFocus);
  const { getViewport, setViewport, fitView, viewportInitialized } =
    useReactFlow();
  const { resolvedTheme: colorMode } = useTheme();
  const canvasWidth = useFlowStore((state) => state.width);
  const canvasHeight = useFlowStore((state) => state.height);
  const canvasElement = useRef<HTMLDivElement>(null);
  const viewportKey = dagLevelViewportKey(level);
  const handledFocus = useRef(0);
  const viewportTargets = useMemo(
    () => dagViewportTargets(geometry),
    [geometry],
  );
  const zoom = useFlowStore((state) => state.transform[2]);
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
    // An explicit entry target owns this transition. fitView waits for Flow's
    // new nodes and would otherwise overwrite the target viewport afterwards.
    if (focusRequest?.level === level.kind && handledFocus.current !== focusRequest.nonce) return;
    const stored = storeApi.getState().dagViewports[viewportKey];
    if (stored) void setViewport(stored);
    else void fitView({ padding: 0.15, maxZoom: 1 });
  }, [viewportKey, viewportInitialized, geometry, focusRequest, level.kind, setViewport, fitView, storeApi]);

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
    if (!viewportInitialized || !canvasWidth || !canvasHeight || !focusRequest || handledFocus.current === focusRequest.nonce)
      return;
    // The request targets a level: wait until that scene is painted (a jump
    // from a line to an overview card arrives before the overview geometry).
    const paintedKind = level.kind;
    if (paintedKind !== focusRequest.level) return;
    // Same level but no such node: drop it — waiting longer would fire a
    // surprise jump when the target appears for an unrelated reason.
    handledFocus.current = focusRequest.nonce;
    const targetId = plan.input.kind === "focus"
      ? plan.input.frames.find((frame) => frame.modelId === focusRequest.id && frame.side === "current")?.id ?? focusRequest.id
      : focusRequest.id;
    const box = geometry.nodes[targetId] ?? geometry.frames[targetId];
    if (!box) {
      if (level.kind === "focus") void fitView({ padding: 0.15, maxZoom: 1 });
      return;
    }
    storeApi.getState().setDagSelectedNodeId(targetId);
    const zoom = Math.max(0.85, getViewport().zoom);
    // The Q11 row can appear in this same commit; Flow's ResizeObserver has
    // not necessarily published the resulting canvas height yet.
    const size = canvasElement.current?.getBoundingClientRect();
    void setViewport(level.kind === "focus"
      ? { x: (size?.width ?? canvasWidth) / 2 - (box.x + box.width / 2) * zoom, y: (size?.height ?? canvasHeight) / 2 - (box.y + box.height / 2) * zoom, zoom }
      : { x: 24 - box.x * zoom, y: 24 - box.y * zoom, zoom });
  }, [focusRequest, geometry, level, plan, canvasWidth, canvasHeight, getViewport, setViewport, fitView, storeApi, viewportInitialized]);

  const focusSet = useMemo(
    () => (focusState ? dagSceneFocusSet(plan, focusState.nodeId, focusState.way) : null),
    [focusState, plan],
  );
  const baseNodes = useMemo(
    () =>
      dagSceneFlowNodes(model, {
        geometry,
        statusColorOf,
        projectNames,
        focus: focusSet,
      }),
    [model, geometry, statusColorOf, projectNames, focusSet],
  );
  const nodes = useMemo(
    () => applySelection(baseNodes, selectedNodeId),
    [baseNodes, selectedNodeId],
  );
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
  return (
    <div ref={canvasElement} className="relative flex-1 min-h-0" data-dag-canvas data-dag-level={level.kind} data-dag-scene={plan.input.id}>
      <DagCanvasActionsContext.Provider value={actions}>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 20, y: 20, zoom: 1 }}
          onNodesChange={handleNodesChange}
          onNodeClick={(_, node) => {
            if (node.type === "dagExternal") return;
            storeApi.getState().setDagSelectedNodeId(node.id);
          }}
          onNodeDoubleClick={(_, node) => {
            if (node.type === "dagOverviewCard") {
              const { card } = node.data;
              if (card.kind === "issue") onOpenIssue(card.issue!.id);
              else onEnterLine(card.kind === "independent" ? card.id : card.issue!.id);
            } else if (node.type === "dagTask") {
              onOpenIssue(node.data.task.issue.id);
            }
          }}
          onPaneClick={() => storeApi.getState().setDagSelectedNodeId(null)}
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
              focus={focusSet}
            />
          </ViewportPortal>
          <Background gap={24} size={1} className="stroke-border/40" bgColor="transparent" />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable className="!bg-card" />
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
