"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
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
import { dagNodeSize } from "./dag-constants";
import { DagIssueActions } from "./dag-issue-actions";
import { DagFlowNodeCard, type DagFlowNode, type DagFlowNodeData } from "./dag-node";
import { DagFlowGroupCard, type DagFlowGroup } from "./dag-group";
import { dagFocusNeighborhood, type DagProjection, type DagVisibleEdge } from "./dag-projection";
import type { DagLayoutResult, DagPoint, DagPort } from "./dag-layout";

const nodeTypes = { dagNode: DagFlowNodeCard, dagGroup: DagFlowGroupCard };
const edgeTypes = { dagEdge: DagFlowEdgeLine };
const NO_PORTS: DagPort[] = [];
type CanvasNode = DagFlowNode | DagFlowGroup;
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

function DagCanvasInner({
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
  const anchor = useRef<{ id: string; position: DagPoint; viewport: Viewport } | null>(null);
  const handledFocus = useRef(0);
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
      if (position) anchor.current = { id, position, viewport: getViewport() };
      onToggleCollapsed(id);
    },
    [getViewport, onToggleCollapsed, positions],
  );
  // Expanding a line preserves its header's screen position and zoom.
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved || !viewportInitialized) return;
    const next = positions.get(saved.id);
    if (!next || next === saved.position) return;
    anchor.current = null;
    void setViewport({
      ...saved.viewport,
      x: saved.viewport.x + (saved.position.x - next.x) * saved.viewport.zoom,
      y: saved.viewport.y + (saved.position.y - next.y) * saved.viewport.zoom,
    });
  }, [positions, setViewport, viewportInitialized]);
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
    void setViewport(
      { x: 24 - position.x * zoom, y: 24 - position.y * zoom, zoom },
      { duration: 200 },
    );
  }, [
    focusRequest,
    getViewport,
    positions,
    projection.representatives,
    selectNode,
    setViewport,
    viewportInitialized,
  ]);
  const baseNodes = useMemo<CanvasNode[]>(
    () =>
      projection.nodes.flatMap((model): CanvasNode[] => {
        const absolute = positions.get(model.id);
        if (!absolute) return [];
        const group = groupModels.get(model.id),
          bounds = geometry.groups[model.id];
        if (group && !bounds) return [];
        const parent = model.groupId ? positions.get(model.groupId) : undefined;
        const parentIssue = model.groupId ? models.get(model.groupId)?.issue : null;
        const projectTitle =
          model.issue?.projectId && (group || model.issue.projectId !== parentIssue?.projectId)
            ? (projectNames.get(model.issue.projectId) ?? null)
            : null;
        const data: DagFlowNodeData = {
          model,
          projectTitle,
          statusColor: model.issue ? statusColorOf(model.issue.status) : null,
          ports: geometry.ports[model.id] ?? NO_PORTS,
          showStage: !model.groupId || !geometry.groups[model.groupId]?.bands.length,
          focused: false,
          dimmed: false,
        };
        const size = bounds ?? dagNodeSize(model.kind);
        const shared = {
          id: model.id,
          position: parent ? { x: absolute.x - parent.x, y: absolute.y - parent.y } : absolute,
          parentId: model.groupId ?? undefined,
          width: size.width,
          height: size.height,
          style: { width: size.width, height: size.height },
          measured: getInternalNode(model.id)?.measured,
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
      }),
    [
      direction,
      geometry,
      getInternalNode,
      groupModels,
      models,
      onFocusGroup,
      openIssue,
      positions,
      projectNames,
      projection,
      statusColorOf,
      toggle,
    ],
  );
  const rfNodes = useMemo<CanvasNode[]>(
    () =>
      baseNodes.map((node) => {
        const selected = selectedNodeId === node.id;
        if (node.type === "dagGroup") {
          const focused =
            selectionContext.activeGroups.has(node.id) || focusSet?.has(node.id) === true;
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
        return selected || focused ? { ...node, selected, data: { ...node.data, focused } } : node;
      }),
    [baseNodes, focusSet, selectedNodeId, selectionContext],
  );
  const rfEdges = useMemo<DagFlowEdge[]>(
    () =>
      projection.edges.flatMap((model): DagFlowEdge[] => {
        const route = geometry.routes[model.id];
        if (!route || !positions.has(model.source) || !positions.has(model.target)) return [];
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
                focused || selectedEdgeId === model.id ? "var(--brand)" : "var(--muted-foreground)",
            },
          },
        ];
      }),
    [
      focusSet,
      geometry.routes,
      groupModels,
      positions,
      projection.edges,
      selectEdge,
      selectedEdgeId,
      selectedNodeId,
    ],
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
        onMoveEnd={(_, viewport) => storeApi.getState().setDagViewport(viewport)}
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
      <DagCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
