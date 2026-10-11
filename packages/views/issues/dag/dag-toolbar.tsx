"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  Expand,
  Info,
  ListTree,
  Loader2,
  Shrink,
} from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import type { IssueGraph } from "@multica/core/api";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { useT } from "../../i18n";
import { DagNodeSelection } from "./dag-selection-node";
import { DagEdgeSelection } from "./dag-selection-edge";
import { isAggregateEdge, type DagProjection } from "./dag-projection";

export interface DagToolbarProps {
  graph: IssueGraph;
  projection: DagProjection;
  pending: boolean;
  layoutPendingLong: boolean;
  cancelPendingLayout: () => void;
  expandAll: () => void;
  collapseAll: () => void;
  expandAllDisabled: boolean;
  collapseAllDisabled: boolean;
  onOpenIssue: (issueId: string) => void;
  onRevealIssues: (issueIds: string[]) => void;
  onFocusGroup: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
}

export function DagToolbar({
  graph,
  projection,
  pending,
  layoutPendingLong,
  cancelPendingLayout,
  expandAll,
  collapseAll,
  expandAllDisabled,
  collapseAllDisabled,
  onOpenIssue,
  onRevealIssues,
  onFocusGroup,
  onToggleCollapsed,
}: DagToolbarProps) {
  const { t: tDag } = useT("dag");
  const { t: tIssues } = useT("issues");
  const storeApi = useViewStoreApi();
  const selectedNodeId = useViewStore((s) => s.dagSelectedNodeId);
  const selectedEdgeId = useViewStore((s) => s.dagSelectedEdgeId);
  const showCompleted = useViewStore((s) => s.dagShowCompleted);
  const models = useMemo(
    () => new Map(projection.nodes.map((n) => [n.id, n])),
    [projection],
  );
  const groupModels = useMemo(
    () => new Map(projection.groups.map((g) => [g.id, g])),
    [projection],
  );
  const selectedNode = selectedNodeId ? models.get(selectedNodeId) : undefined;
  const selectedEdge = useMemo(
    () => projection.edges.find((e) => e.id === selectedEdgeId),
    [projection, selectedEdgeId],
  );
  const nodeLabelById = useMemo(
    () =>
      new Map(
        projection.nodes.map((n) => [
          n.id,
          n.kind === "independent"
            ? tDag(($) => $.independent_group)
            : `${n.identifier ?? ""} ${n.title}`.trim(),
        ]),
      ),
    [projection, tDag],
  );
  const issueLabelById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, `${n.identifier} · ${n.title}`])),
    [graph.nodes],
  );
  // The idle-zone statistics count what the canvas actually shows: tasks and
  // dependency endpoints hidden by the completed filter are excluded.
  const visibleStats = useMemo(() => {
    const visibleIds = new Set<string>();
    for (const node of projection.nodes)
      for (const memberId of node.memberIds) visibleIds.add(memberId);
    let matched = 0,
      context = 0;
    for (const node of graph.nodes) {
      if (!visibleIds.has(node.id)) continue;
      if (node.role === "match") matched += 1;
      else context += 1;
    }
    const edges = graph.edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    ).length;
    return { matched, context, edges };
  }, [projection, graph]);
  const hidden = projection.hiddenCompleted;
  const hiddenTotal = hidden.lineTasks + hidden.singles;
  const toggleShowCompleted = () => storeApi.getState().toggleDagShowCompleted();
  const showCompletedButton = (withBadge: boolean) => (
    <Button
      size="sm"
      variant={showCompleted ? "secondary" : "outline"}
      className={cn("h-7 text-caption", !showCompleted && "text-muted-foreground")}
      onClick={toggleShowCompleted}
      aria-pressed={showCompleted}
      aria-label={
        withBadge
          ? `${tIssues(($) => $.gantt.show_completed)} (${hiddenTotal})`
          : undefined
      }
    >
      {tIssues(($) => $.gantt.show_completed)}
      {withBadge && (
        <span
          aria-hidden
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-micro tabular-nums text-muted-foreground"
        >
          {hiddenTotal}
        </span>
      )}
    </Button>
  );

  const selection = selectedNode ? (
    <DagNodeSelection
      node={selectedNode}
      group={groupModels.get(selectedNode.id)}
      groupModels={groupModels}
      label={nodeLabelById.get(selectedNode.id) ?? selectedNode.id}
      projection={projection}
      graph={graph}
      onOpenIssue={onOpenIssue}
      onFocusGroup={onFocusGroup}
      onToggleCollapsed={onToggleCollapsed}
    />
  ) : selectedEdge ? (
    <DagEdgeSelection
      edge={selectedEdge}
      aggregate={isAggregateEdge(selectedEdge, groupModels)}
      hasReverse={projection.edges.some(
        (e) => e.source === selectedEdge.target && e.target === selectedEdge.source,
      )}
      nodeLabelById={nodeLabelById}
      issueLabelById={issueLabelById}
      onLocate={onRevealIssues}
      onOpenIssue={onOpenIssue}
    />
  ) : (
    <>
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <ListTree className="size-3.5" />
        <span className="tabular-nums">
          {tDag(($) => $.summary_matches, { count: visibleStats.matched })}
        </span>
        {visibleStats.context > 0 && (
          <span className="tabular-nums">
            {tDag(($) => $.summary_context, { count: visibleStats.context })}
          </span>
        )}
        <span className="tabular-nums">
          {tDag(($) => $.summary_edges, { count: visibleStats.edges })}
        </span>
      </span>
      <span className="truncate text-faint-foreground">
        {tDag(($) => $.selection_hint)}
      </span>
    </>
  );

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-2 text-caption text-muted-foreground"
      data-dag-toolbar
    >
      <div
        role="region"
        aria-label={tDag(($) => $.selection_region_label)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors",
          (selectedNode || selectedEdge) && "bg-accent/60 text-foreground",
        )}
      >
        {selection}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        {pending && (
          <span className="inline-flex items-center gap-1.5" role="status">
            <Loader2 className="size-3 animate-spin" />
            {tDag(($) => $.layout_pending)}
            {layoutPendingLong && (
              <Button size="sm" variant="ghost" onClick={cancelPendingLayout}>
                {tDag(($) => $.layout_cancel)}
              </Button>
            )}
          </span>
        )}
        {graph.hasRestrictedContext && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={tDag(($) => $.restricted_context_hint)}
                  className="inline-flex items-center rounded-sm p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <AlertTriangle className="size-3.5 text-warning" />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tDag(($) => $.restricted_context_hint)}
            </TooltipContent>
          </Tooltip>
        )}
        {graph.matchedCount === 0 && graph.contextCount > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={tDag(($) => $.context_only_hint)}
                  className="inline-flex items-center rounded-sm p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <AlertTriangle className="size-3.5 text-warning" />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tDag(($) => $.context_only_hint)}
            </TooltipContent>
          </Tooltip>
        )}
        {hiddenTotal > 0 ? (
          <Tooltip>
            <TooltipTrigger render={showCompletedButton(true)} />
            <TooltipContent side="bottom">
              {tDag(($) => $.hidden_completed_tooltip, {
                count: hidden.lines,
                tasks: hidden.lineTasks,
                singles: hidden.singles,
              })}
            </TooltipContent>
          </Tooltip>
        ) : (
          showCompletedButton(false)
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={expandAll}
          disabled={expandAllDisabled}
        >
          <Expand className="size-3.5" />
          {tDag(($) => $.expand_all)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={collapseAll}
          disabled={collapseAllDisabled}
        >
          <Shrink className="size-3.5" />
          {tDag(($) => $.collapse_all)}
        </Button>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={tDag(($) => $.legend_label)}
                title={tDag(($) => $.legend_label)}
              />
            }
          >
            <Info className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto max-w-72 p-3">
            <ul className="flex flex-col gap-1.5 text-caption text-muted-foreground">
              <li>{tDag(($) => $.stage_legend)}</li>
              <li>{tDag(($) => $.dependency_legend)}</li>
            </ul>
          </PopoverContent>
        </Popover>
      </span>
    </div>
  );
}
