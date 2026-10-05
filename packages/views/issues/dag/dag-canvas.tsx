"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { Crosshair, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import type { IssueGraph } from "@multica/core/api";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import { useViewStore, useViewStoreApi } from "@multica/core/issues/stores/view-store-context";
import { useT } from "../../i18n";
import { DagFlowEdgeLine, type DagFlowEdge } from "./dag-edge";
import { toFlowNodes, selectFlowNodes, toFlowEdges, type CanvasNode } from "./dag-flow";
import {
  anchorShift,
  constrainDagViewport,
  dagViewportTargets,
  dagViewportExtent,
  sameDagViewport,
} from "./dag-viewport";
import { DagIssueActions } from "./dag-issue-actions";
import { DagFlowNodeCard } from "./dag-node";
import { DagFlowGroupCard } from "./dag-group";
import { dagFocusNeighborhood, type DagProjection, type DagVisibleEdge } from "./dag-projection";
import type { DagLayoutResult, DagPoint } from "./dag-layout";

import { DagPortUpdateProvider } from "./dag-ports";

const nodeTypes = { dagNode: DagFlowNodeCard, dagGroup: DagFlowGroupCard };
const edgeTypes = { dagEdge: DagFlowEdgeLine };
export interface DagCanvasCallbacks {
  onOpenIssue: (issueId: string) => void;
  onToggleCollapsed: (id: string) => void;
  onRevealIssues: (issueIds: string[]) => void;
  onFocusGroup: (id: string) => void;
}
export interface DagCanvasProps extends DagCanvasCallbacks {
  graph: IssueGraph;
  projection: DagProjection;
  positions: ReadonlyMap<string, DagPoint>;
  geometry: DagLayoutResult;
  direction: DagDirection;
  statusColorOf: (statusKey: string) => string | null;
  focusRequest: { issueIds: string[]; groupId?: string; nonce: number } | null;
}
type FocusState = { nodeId: string; way: "upstream" | "downstream" } | null;

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
  onRevealIssues,
  onFocusGroup,
}: DagCanvasProps) {
  const { t } = useT("issues"),
    storeApi = useViewStoreApi();
  const selectedNodeId = useViewStore((s) => s.dagSelectedNodeId);
  const { getViewport, setViewport, getInternalNode, viewportInitialized } = useReactFlow<
    CanvasNode,
    DagFlowEdge
  >();
  const colorMode = useDagColorMode();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusState>(null);
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
  const issueLabelById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, `${n.identifier} · ${n.title}`])),
    [graph.nodes],
  );
  const nodeLabelById = useMemo(
    () =>
      new Map(
        projection.nodes.map((n) => [
          n.id,
          n.kind === "independent"
            ? t(($) => $.dag.independent_group)
            : `${n.identifier ?? ""} ${n.title}`.trim(),
        ]),
      ),
    [projection, t],
  );
  const focusSet = useMemo(
    () =>
      focus && models.has(focus.nodeId)
        ? dagFocusNeighborhood(projection, graph, focus.nodeId, focus.way)
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
      setSelectedEdgeId(null);
      setFocus(null);
    },
    [storeApi],
  );
  const selectEdge = useCallback(
    (id: string) => {
      setSelectedEdgeId(id);
      storeApi.getState().setDagSelectedNodeId(null);
      setFocus(null);
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
  const selectedNode = selectedNodeId ? models.get(selectedNodeId) : undefined;
  const selectedGroup = selectedNodeId ? groupModels.get(selectedNodeId) : undefined;
  const selectedEdge = projection.edges.find((e) => e.id === selectedEdgeId);
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
        else setSelectedEdgeId((current) => (current === change.id ? null : current));
      }
    },
    [selectEdge],
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
        onPaneClick={() => {
          selectNode(null);
          setSelectedEdgeId(null);
        }}
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
        colorMode={colorMode}
        className="bg-background"
      >
        <Background gap={24} size={1} className="stroke-border/40" bgColor="transparent" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>
      {selectedNode && (
        <div
          className="absolute left-1/2 top-3 z-10 flex max-w-[min(720px,90%)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-lg border bg-card px-2 py-1.5 shadow-md"
          role="toolbar"
          aria-label={t(($) => $.dag.node_actions_label)}
        >
          <span
            className="max-w-48 truncate px-1 text-caption font-medium"
            title={nodeLabelById.get(selectedNode.id)}
          >
            {selectedNode.identifier ?? nodeLabelById.get(selectedNode.id)}
          </span>
          {selectedNode.issue && (
            <DagIssueActions
              key={selectedNode.issue.id}
              issueId={selectedNode.issue.id}
              onOpenIssue={openIssue}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFocus({ nodeId: selectedNode.id, way: "upstream" })}
          >
            {t(($) => $.dag.focus_upstream)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFocus({ nodeId: selectedNode.id, way: "downstream" })}
          >
            {t(($) => $.dag.focus_downstream)}
          </Button>
          {(selectedGroup || selectedNode.groupId) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onFocusGroup(selectedGroup?.id ?? selectedNode.groupId!)}
            >
              {t(($) => $.dag.focus_line)}
            </Button>
          )}
          {selectedGroup && (
            <Button size="sm" variant="ghost" onClick={() => toggle(selectedGroup.id)}>
              {selectedGroup.collapsed ? t(($) => $.dag.expand) : t(($) => $.dag.collapse)}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t(($) => $.dag.clear_selection)}
            onClick={() => selectNode(null)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}
      {focus && (
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-3 py-1 text-caption shadow-md">
          <Crosshair className="size-3.5 text-muted-foreground" />
          <span>
            {focus.way === "upstream"
              ? t(($) => $.dag.focus_upstream_active)
              : t(($) => $.dag.focus_downstream_active)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setFocus(null)}>
            {t(($) => $.dag.focus_clear)}
          </Button>
        </div>
      )}
      {selectedEdge && (
        <EdgeInspector
          edge={selectedEdge}
          aggregate={
            selectedEdge.sourceEdgeIds.length > 1 ||
            groupModels.get(selectedEdge.source)?.collapsed === true ||
            groupModels.get(selectedEdge.target)?.collapsed === true
          }
          hasReverse={projection.edges.some(
            (e) => e.source === selectedEdge.target && e.target === selectedEdge.source,
          )}
          nodeLabelById={nodeLabelById}
          issueLabelById={issueLabelById}
          onLocate={onRevealIssues}
          onOpenIssue={openIssue}
          onClose={() => setSelectedEdgeId(null)}
        />
      )}
    </div>
  );
}
function useDagColorMode(): "light" | "dark" {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? ("dark" as const)
      : ("light" as const);
  const [mode, setMode] = useState<"light" | "dark">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return mode;
}

function EdgeInspector({
  edge,
  aggregate,
  hasReverse,
  nodeLabelById,
  issueLabelById,
  onLocate,
  onOpenIssue,
  onClose,
}: {
  edge: DagVisibleEdge;
  aggregate: boolean;
  hasReverse: boolean;
  nodeLabelById: ReadonlyMap<string, string>;
  issueLabelById: ReadonlyMap<string, string>;
  onLocate: (issueIds: string[]) => void;
  onOpenIssue: (issueId: string) => void;
  onClose: () => void;
}) {
  const { t } = useT("issues");
  return (
    <div
      className="absolute right-3 top-3 z-10 flex w-80 flex-col gap-2 rounded-lg border bg-card p-3 shadow-md"
      role="dialog"
      aria-label={t(($) => $.dag.edge_inspector_label)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-caption font-medium">
            {aggregate ? t(($) => $.dag.edge_aggregate_title) : t(($) => $.dag.edge_direct_title)}
          </p>
          <p className="text-caption text-muted-foreground break-words">
            {aggregate
              ? t(($) => $.dag.edge_aggregate_description, {
                  source: nodeLabelById.get(edge.source) ?? "",
                  target: nodeLabelById.get(edge.target) ?? "",
                  count: edge.sourceEdgeIds.length,
                })
              : t(($) => $.dag.edge_direct_description, {
                  source: nodeLabelById.get(edge.source) ?? "",
                  target: nodeLabelById.get(edge.target) ?? "",
                })}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t(($) => $.dag.clear_selection)}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {aggregate && hasReverse && (
        <p className="rounded-md bg-muted/60 px-2 py-1 text-micro text-muted-foreground">
          {t(($) => $.dag.edge_aggregate_bidirectional)}
        </p>
      )}
      {!aggregate && edge.sources[0] && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-muted-foreground">
            {issueLabelById.get(edge.sources[0].source) ?? "?"} →{" "}
            {issueLabelById.get(edge.sources[0].target) ?? "?"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onLocate([edge.sources[0]!.source, edge.sources[0]!.target])}
          >
            {t(($) => $.dag.edge_locate)}
          </Button>
        </div>
      )}
      {aggregate && (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {edge.sources.map((source) => (
            <li
              key={source.edgeId}
              className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-caption hover:bg-muted/60"
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground"
                onClick={() => onOpenIssue(source.source)}
                title={issueLabelById.get(source.source)}
              >
                {issueLabelById.get(source.source) ?? "?"}
              </button>
              <span aria-hidden className="shrink-0 text-faint-foreground">
                →
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground"
                onClick={() => onOpenIssue(source.target)}
                title={issueLabelById.get(source.target)}
              >
                {issueLabelById.get(source.target) ?? "?"}
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                onClick={() => onLocate([source.source, source.target])}
              >
                {t(($) => $.dag.edge_locate)}
              </Button>
            </li>
          ))}
        </ul>
      )}
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
