"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Crosshair, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import type { IssueGraph } from "@multica/core/api";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import { useT } from "../../i18n";
import {
  DagFlowEdgeLine,
  type DagFlowEdge,
  type DagFlowEdgeData,
} from "./dag-edge";
import { dagNodeSize } from "./dag-constants";
import {
  DagFlowNodeCard,
  type DagFlowNode,
  type DagFlowNodeData,
} from "./dag-node";
import {
  dagFocusNeighborhood,
  type DagProjection,
  type DagVisibleEdge,
} from "./dag-projection";

const nodeTypes = { dagNode: DagFlowNodeCard };
const edgeTypes = { dagEdge: DagFlowEdgeLine };

/** An edge is an aggregate when it merges several source edges or connects
 *  representatives (issue ids are UUIDs; representative ids are prefixed). */
function isAggregateDagEdge(edge: DagVisibleEdge): boolean {
  return (
    edge.sourceEdgeIds.length > 1 ||
    edge.source.includes(":") ||
    edge.target.includes(":")
  );
}

/** React Flow chrome (controls, minimap, attribution) themes off its own
 *  `colorMode`; track the app's `.dark` class the way the mermaid viewer does
 *  instead of taking a next-themes dependency into the shared package. */
function useDagColorMode(): "light" | "dark" {
  const read = () =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
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

export interface DagCanvasCallbacks {
  onOpenIssue: (issueId: string) => void;
  /** OL-44 shared relation-form entry; DagView defaults it to onOpenIssue. */
  onEditDependencies: (issueId: string) => void;
  /** OL-44 shared assign entry; DagView defaults it to onOpenIssue. */
  onAssignIssue: (issueId: string) => void;
  /** Toggle one representative's folded state in the view store. */
  onToggleCollapsed: (representativeId: string) => void;
  /** Reveal folded issue ids (unfold their representatives), then focus. */
  onRevealIssues: (issueIds: string[]) => void;
}

export interface DagCanvasProps extends DagCanvasCallbacks {
  graph: IssueGraph;
  projection: DagProjection;
  positions: ReadonlyMap<string, { x: number; y: number }>;
  direction: DagDirection;
  statusColorOf: (statusKey: string) => string | null;
  /** A reveal/focus request from outside (edge locate, summary jump). The
   *  nonce re-fires identical id sets. */
  focusRequest: { issueIds: string[]; nonce: number } | null;
}

type FocusState = { nodeId: string; way: "upstream" | "downstream" } | null;

function DagCanvasInner({
  graph,
  projection,
  positions,
  direction,
  statusColorOf,
  focusRequest,
  onOpenIssue,
  onEditDependencies,
  onAssignIssue,
  onToggleCollapsed,
  onRevealIssues,
}: DagCanvasProps) {
  const { t } = useT("issues");
  const { fitView } = useReactFlow();
  const colorMode = useDagColorMode();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusState>(null);
  const handledFocusNonce = useRef(0);

  const nodeLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of projection.nodes) {
      map.set(node.id, node.identifier ?? node.title);
    }
    return map;
  }, [projection]);
  const issueLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graph.nodes) map.set(node.id, node.identifier);
    return map;
  }, [graph]);
  const projectTitleById = useMemo(
    () => new Map(graph.projects.map((project) => [project.id, project.title])),
    [graph],
  );

  const focusSet = useMemo(() => {
    if (!focus) return null;
    const node = projection.nodes.find((candidate) => candidate.id === focus.nodeId);
    if (!node) return null;
    return dagFocusNeighborhood(projection, graph, focus.nodeId, focus.way);
  }, [focus, graph, projection]);

  // Reveal-then-focus: an outside request names ISSUE ids that may currently
  // be folded. The view store has already unfolded their representatives by
  // the time this fires again (nonce), so the ids are laid out and can be
  // centered.
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === handledFocusNonce.current) return;
    handledFocusNonce.current = focusRequest.nonce;
    const ids = focusRequest.issueIds;
    const visible = ids.filter((id) => positions.has(id));
    if (visible.length === 0) return;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setFocus(null);
    void fitView({
      nodes: visible.map((id) => ({ id })),
      padding: 0.3,
      duration: 300,
      maxZoom: 1.2,
    });
  }, [focusRequest, fitView, positions]);

  // Base node objects stay referentially stable across selection/focus
  // changes; the second pass re-allocates only nodes whose flags flipped, so
  // the memoized card component skips every untouched node on large graphs.
  const baseNodes = useMemo<DagFlowNode[]>(
    () =>
      projection.nodes.flatMap((model) => {
        const position = positions.get(model.id);
        if (!position) return [];
        const data: DagFlowNodeData = {
          model,
          direction,
          projectTitle:
            model.kind === "issue" && model.issue?.projectId
              ? (projectTitleById.get(model.issue.projectId) ?? null)
              : null,
          statusColor: model.issue ? statusColorOf(model.issue.status) : null,
          focused: false,
          dimmed: false,
        };
        return [
          {
            id: model.id,
            type: "dagNode" as const,
            position,
            data,
            width: dagNodeSize(model.kind).width,
            height: dagNodeSize(model.kind).height,
            selected: false,
            draggable: false,
            connectable: false,
          },
        ];
      }),
    [direction, positions, projectTitleById, projection, statusColorOf],
  );
  const rfNodes = useMemo<DagFlowNode[]>(
    () =>
      baseNodes.map((node) => {
        const focused = focusSet?.has(node.id) === true;
        const selected = selectedNodeId === node.id;
        const dimmed = focusSet !== null && !focused;
        if (
          node.data.focused === focused &&
          node.data.dimmed === dimmed &&
          node.selected === selected
        ) {
          return node;
        }
        return { ...node, selected, data: { ...node.data, focused, dimmed } };
      }),
    [baseNodes, focusSet, selectedNodeId],
  );

  const rfEdges = useMemo<DagFlowEdge[]>(
    () =>
      projection.edges.map((model) => {
        const focused =
          focusSet !== null &&
          focusSet.has(model.source) &&
          focusSet.has(model.target);
        const data: DagFlowEdgeData = {
          model,
          aggregate: isAggregateDagEdge(model),
          dimmed: focusSet !== null && !focused,
          focused,
        };
        return {
          id: model.id,
          source: model.source,
          target: model.target,
          type: "dagEdge" as const,
          data,
          selected: selectedEdgeId === model.id,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        };
      }),
    [focusSet, projection, selectedEdgeId],
  );

  const selectedNode = useMemo(
    () => projection.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [projection, selectedNodeId],
  );
  const selectedEdge = useMemo(
    () => projection.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [projection, selectedEdgeId],
  );

  const applyFocus = useCallback(
    (nodeId: string, way: "upstream" | "downstream") => {
      setFocus({ nodeId, way });
      const neighborhood = dagFocusNeighborhood(projection, graph, nodeId, way);
      const visible = [...neighborhood].filter((id) => positions.has(id));
      if (visible.length > 0) {
        void fitView({
          nodes: visible.map((id) => ({ id })),
          padding: 0.25,
          duration: 300,
          maxZoom: 1.2,
        });
      }
    },
    [fitView, graph, positions, projection],
  );

  const handleNodesChange = useCallback((changes: NodeChange<DagFlowNode>[]) => {
    for (const change of changes) {
      if (change.type === "select") {
        if (change.selected) {
          setSelectedNodeId(change.id);
          setSelectedEdgeId(null);
        } else {
          setSelectedNodeId((current) => (current === change.id ? null : current));
        }
      }
    }
  }, []);
  const handleEdgesChange = useCallback((changes: EdgeChange<DagFlowEdge>[]) => {
    for (const change of changes) {
      if (change.type === "select") {
        if (change.selected) {
          setSelectedEdgeId(change.id);
          setSelectedNodeId(null);
        } else {
          setSelectedEdgeId((current) => (current === change.id ? null : current));
        }
      }
    }
  }, []);

  // Fit once when a fresh layout lands (projection or direction changed the
  // position set). Selection/focus fits are separate, user-initiated.
  const layoutKeyRef = useRef("");
  useEffect(() => {
    const key = `${positions.size}:${direction}`;
    if (key === layoutKeyRef.current || positions.size === 0) return;
    layoutKeyRef.current = key;
    void fitView({ padding: 0.15, duration: 200 });
  }, [direction, fitView, positions]);

  return (
    <div className="relative flex-1 min-h-0">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeDoubleClick={(_, node) => {
          const model = node.data.model;
          if (model.kind === "issue") onOpenIssue(model.id);
          else onToggleCollapsed(model.id);
        }}
        onPaneClick={() => {
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
          setFocus(null);
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable
        elementsSelectable
        onlyRenderVisibleElements
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

      {/* Selected-node action bar: every node action as a plain control, so
          keyboard and pointer users get the same paths without relying on
          canvas gestures. */}
      {selectedNode && (
        <div
          className="absolute left-1/2 top-3 z-10 flex max-w-[min(720px,90%)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-lg border bg-card px-2 py-1.5 shadow-md"
          role="toolbar"
          aria-label={t(($) => $.dag.node_actions_label)}
        >
          <span className="max-w-56 truncate px-1 text-caption font-medium">
            {nodeLabelById.get(selectedNode.id)}
          </span>
          {/* Feature representatives are issues too — their detail, relation
              and assign actions act on the representative's own issue. */}
          {selectedNode.issue && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenIssue(selectedNode.issue!.id)}
              >
                {t(($) => $.dag.open_detail)}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onEditDependencies(selectedNode.issue!.id)}
              >
                {t(($) => $.dag.edit_dependencies)}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onAssignIssue(selectedNode.issue!.id)}
              >
                {t(($) => $.dag.assign_issue)}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => applyFocus(selectedNode.id, "upstream")}
          >
            {t(($) => $.dag.focus_upstream)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => applyFocus(selectedNode.id, "downstream")}
          >
            {t(($) => $.dag.focus_downstream)}
          </Button>
          <CollapseToggleButton
            node={selectedNode}
            onToggleCollapsed={onToggleCollapsed}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t(($) => $.dag.clear_selection)}
            onClick={() => {
              setSelectedNodeId(null);
              setFocus(null);
            }}
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
          hasReverse={projection.edges.some(
            (candidate) =>
              candidate.source === selectedEdge.target &&
              candidate.target === selectedEdge.source,
          )}
          aggregate={isAggregateDagEdge(selectedEdge)}
          nodeLabelById={nodeLabelById}
          issueLabelById={issueLabelById}
          onLocate={(issueIds) => onRevealIssues(issueIds)}
          onOpenIssue={onOpenIssue}
          onClose={() => setSelectedEdgeId(null)}
        />
      )}
    </div>
  );
}

function CollapseToggleButton({
  node,
  onToggleCollapsed,
}: {
  node: DagProjection["nodes"][number];
  onToggleCollapsed: (representativeId: string) => void;
}) {
  const { t } = useT("issues");
  // Representatives fold through their own id; an expanded feature folds
  // through its `issue:` rep id. Plain issues without children never fold.
  const target =
    node.kind === "issue"
      ? node.collapsible
        ? `issue:${node.id}`
        : null
      : node.id;
  if (!target) return null;
  const collapsed = node.kind !== "issue";
  return (
    <Button size="sm" variant="ghost" onClick={() => onToggleCollapsed(target)}>
      {collapsed ? t(($) => $.dag.expand) : t(($) => $.dag.collapse)}
    </Button>
  );
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
            {aggregate
              ? t(($) => $.dag.edge_aggregate_title)
              : t(($) => $.dag.edge_direct_title)}
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
            onClick={() =>
              onLocate([edge.sources[0]!.source, edge.sources[0]!.target])
            }
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
              <span aria-hidden className="shrink-0 text-faint-foreground">→</span>
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

/** Lazy boundary: this module owns the `@xyflow/react` import, so the canvas
 *  bundle only loads when a surface actually renders DAG mode. */
export default function DagCanvas(props: DagCanvasProps) {
  return (
    <ReactFlowProvider>
      <DagCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
