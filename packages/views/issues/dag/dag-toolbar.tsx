"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Crosshair,
  Expand,
  Info,
  ListTree,
  Loader2,
  Shrink,
  X,
} from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
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
import type { DagFocusWay } from "@multica/core/issues/stores/view-store";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { useT } from "../../i18n";
import { DagAssignAction, useDagIssueSelection } from "./dag-issue-actions";
import {
  dagFocusNeighborhood,
  isAggregateEdge,
  type DagProjection,
  type DagVisibleEdge,
  type DagVisibleGroup,
  type DagVisibleNode,
} from "./dag-projection";

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

/** Extra slack required before a collapsed action returns to the bar. Larger
 *  than any one action so a boundary width cannot oscillate. */
const OVERFLOW_HYSTERESIS_PX = 140;

/** Collapse the rightmost actions when the zone runs out of room, restore
 *  them when width comes back. jsdom reports zero widths, which reads as
 *  "fits" — no collapsing under test. */
function useOverflowCollapse(actionCount: number, resetKey: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const lastWidth = useRef(0);
  const [collapsed, setCollapsed] = useState(0);
  useLayoutEffect(() => {
    setCollapsed(0);
  }, [resetKey, actionCount]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    lastWidth.current = lastWidth.current || el.clientWidth;
    const check = () => {
      const width = el.clientWidth;
      const overflowing = el.scrollWidth > width + 1;
      setCollapsed((current) => {
        if (overflowing) return current < actionCount ? current + 1 : current;
        if (
          width > lastWidth.current &&
          current > 0 &&
          el.scrollWidth < width - OVERFLOW_HYSTERESIS_PX
        )
          return current - 1;
        return current;
      });
      lastWidth.current = width;
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [actionCount, collapsed]);
  return { ref, collapsed };
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

  const selection = selectedNode ? (
    <NodeSelection
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
    <EdgeSelection
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
    <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-2 text-caption text-muted-foreground" data-dag-toolbar>
      <div
        role="region"
        aria-label={tDag(($) => $.selection_region_label)}
        className={cn(
          "relative flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors",
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
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant={showCompleted ? "secondary" : "outline"}
                  className={cn(
                    "h-7 text-caption",
                    !showCompleted && "text-muted-foreground",
                  )}
                  onClick={() => storeApi.getState().toggleDagShowCompleted()}
                  aria-pressed={showCompleted}
                  aria-label={`${tIssues(($) => $.gantt.show_completed)} (${hiddenTotal})`}
                />
              }
            >
              {tIssues(($) => $.gantt.show_completed)}
              <span
                aria-hidden
                className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-micro tabular-nums text-muted-foreground"
              >
                {hiddenTotal}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tDag(($) => $.hidden_completed_tooltip, {
                count: hidden.lines,
                tasks: hidden.lineTasks,
                singles: hidden.singles,
              })}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            size="sm"
            variant={showCompleted ? "secondary" : "outline"}
            className={cn(
              "h-7 text-caption",
              !showCompleted && "text-muted-foreground",
            )}
            onClick={() => storeApi.getState().toggleDagShowCompleted()}
            aria-pressed={showCompleted}
          >
            {tIssues(($) => $.gantt.show_completed)}
          </Button>
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

function NodeSelection({
  node,
  group,
  groupModels,
  label,
  projection,
  graph,
  onOpenIssue,
  onFocusGroup,
  onToggleCollapsed,
}: {
  node: DagVisibleNode;
  group: DagVisibleGroup | undefined;
  groupModels: ReadonlyMap<string, DagVisibleGroup>;
  label: string;
  projection: DagProjection;
  graph: IssueGraph;
  onOpenIssue: (issueId: string) => void;
  onFocusGroup: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
}) {
  const { t: tDag } = useT("dag");
  const storeApi = useViewStoreApi();
  const focus = useViewStore((s) => s.dagFocus);
  const showCompleted = useViewStore((s) => s.dagShowCompleted);
  const { issue, actions, detailFailed, retryDetail } = useDagIssueSelection(
    node.issue?.id ?? null,
  );
  const [assignFromMenu, setAssignFromMenu] = useState(false);
  const toggleFocus = (way: DagFocusWay) => {
    const state = storeApi.getState();
    const current = state.dagFocus;
    state.setDagFocus(
      current?.nodeId === node.id && current.way === way
        ? null
        : { nodeId: node.id, way },
    );
  };
  const focusActive = (way: DagFocusWay) =>
    focus?.nodeId === node.id && focus.way === way;
  const focusHiddenCount = useMemo(
    () =>
      focus && focus.nodeId === node.id
        ? dagFocusNeighborhood(projection, graph, focus.nodeId, focus.way)
            .hiddenIssueCount
        : 0,
    [focus, node.id, projection, graph],
  );

  type ActionKey = "open" | "upstream" | "downstream" | "edit" | "assign";
  const actionKeys: ActionKey[] = [
    ...(node.issue ? (["open"] as const) : []),
    "upstream",
    "downstream",
    ...(node.issue ? (["edit", "assign"] as const) : []),
  ];
  const { ref, collapsed } = useOverflowCollapse(actionKeys.length, node.id);
  const visibleKeys = actionKeys.slice(0, actionKeys.length - collapsed);
  const menuKeys = actionKeys.slice(actionKeys.length - collapsed);

  const focusLineId = group?.id ?? node.groupId;
  const foldTarget = group ?? (node.groupId ? groupModels.get(node.groupId) : undefined);
  const focusButton = (way: DagFocusWay, key: ActionKey) => (
    <Button
      key={key}
      size="sm"
      variant={focusActive(way) ? "secondary" : "ghost"}
      aria-pressed={focusActive(way)}
      onClick={() => toggleFocus(way)}
    >
      {way === "upstream"
        ? tDag(($) => $.focus_upstream)
        : tDag(($) => $.focus_downstream)}
    </Button>
  );
  const actionNodes: Record<ActionKey, React.ReactNode> = {
    open: (
      <Button key="open" size="sm" variant="ghost" onClick={() => onOpenIssue(node.issue!.id)}>
        {tDag(($) => $.open_detail)}
      </Button>
    ),
    upstream: focusButton("upstream", "upstream"),
    downstream: focusButton("downstream", "downstream"),
    edit: (
      <Button
        key="edit"
        size="sm"
        variant="ghost"
        disabled={!issue}
        onClick={actions.openEditDependencies}
      >
        {tDag(($) => $.edit_dependencies)}
      </Button>
    ),
    assign: (
      <DagAssignAction key="assign" issue={issue} onUpdate={actions.updateField} />
    ),
  };
  const menuItems: Record<ActionKey, React.ReactNode> = {
    open: (
      <DropdownMenuItem key="open" onClick={() => onOpenIssue(node.issue!.id)}>
        {tDag(($) => $.open_detail)}
      </DropdownMenuItem>
    ),
    upstream: (
      <DropdownMenuItem
        key="upstream"
        aria-pressed={focusActive("upstream")}
        onClick={() => toggleFocus("upstream")}
      >
        {tDag(($) => $.focus_upstream)}
        {focusActive("upstream") && <Crosshair className="ml-auto size-3.5 text-brand" />}
      </DropdownMenuItem>
    ),
    downstream: (
      <DropdownMenuItem
        key="downstream"
        aria-pressed={focusActive("downstream")}
        onClick={() => toggleFocus("downstream")}
      >
        {tDag(($) => $.focus_downstream)}
        {focusActive("downstream") && <Crosshair className="ml-auto size-3.5 text-brand" />}
      </DropdownMenuItem>
    ),
    edit: (
      <DropdownMenuItem
        key="edit"
        disabled={!issue}
        onClick={actions.openEditDependencies}
      >
        {tDag(($) => $.edit_dependencies)}
      </DropdownMenuItem>
    ),
    assign: (
      <DropdownMenuItem key="assign" onClick={() => setAssignFromMenu(true)}>
        {tDag(($) => $.assign_issue)}
      </DropdownMenuItem>
    ),
  };
  const hasMenu = menuKeys.length > 0 || focusLineId != null || foldTarget != null;

  return (
    <>
      <span
        className="max-w-56 shrink truncate px-1 text-caption font-medium text-foreground"
        title={label}
      >
        {node.identifier && (
          <span className="mr-1.5 tabular-nums text-muted-foreground">
            {node.identifier}
          </span>
        )}
        {node.kind === "independent" ? label : node.title}
      </span>
      <div ref={ref} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {visibleKeys.map((key) => actionNodes[key])}
      </div>
      {detailFailed && (
        <Button size="sm" variant="ghost" onClick={retryDetail}>
          {tDag(($) => $.error_retry)}
        </Button>
      )}
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="ghost" aria-label={tDag(($) => $.more_actions)} />
            }
          >
            {tDag(($) => $.more_actions)}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {menuKeys.map((key) => menuItems[key])}
            {menuKeys.length > 0 && (focusLineId != null || foldTarget != null) && (
              <DropdownMenuSeparator />
            )}
            {focusLineId != null && (
              <DropdownMenuItem onClick={() => onFocusGroup(focusLineId)}>
                {tDag(($) => $.focus_line)}
              </DropdownMenuItem>
            )}
            {foldTarget && (
              <DropdownMenuItem onClick={() => onToggleCollapsed(foldTarget.id)}>
                {foldTarget.collapsed
                  ? tDag(($) => $.expand_line)
                  : tDag(($) => $.collapse_line)}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {menuKeys.includes("assign") && issue && (
        <DagAssignAction
          issue={issue}
          onUpdate={actions.updateField}
          open={assignFromMenu}
          onOpenChange={setAssignFromMenu}
          anchor={<span className="absolute right-24 top-full h-px w-px" aria-hidden />}
        />
      )}
      {focusHiddenCount > 0 && !showCompleted && (
        <span className="inline-flex shrink-0 items-center gap-1 text-warning">
          <AlertTriangle className="size-3" />
          <span className="tabular-nums">
            {tDag(($) => $.focus_hidden_tasks, { count: focusHiddenCount })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="text-brand"
            onClick={() => storeApi.getState().toggleDagShowCompleted()}
          >
            {tDag(($) => $.show_completed_enable)}
          </Button>
        </span>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className="shrink-0"
        aria-label={tDag(($) => $.clear_selection)}
        onClick={() => storeApi.getState().setDagSelectedNodeId(null)}
      >
        <X className="size-3.5" />
      </Button>
    </>
  );
}

function EdgeSelection({
  edge,
  aggregate,
  hasReverse,
  nodeLabelById,
  issueLabelById,
  onLocate,
  onOpenIssue,
}: {
  edge: DagVisibleEdge;
  aggregate: boolean;
  hasReverse: boolean;
  nodeLabelById: ReadonlyMap<string, string>;
  issueLabelById: ReadonlyMap<string, string>;
  onLocate: (issueIds: string[]) => void;
  onOpenIssue: (issueId: string) => void;
}) {
  const { t } = useT("dag");
  const storeApi = useViewStoreApi();
  const label = (
    <span
      className="max-w-64 shrink truncate px-1 text-caption font-medium text-foreground"
      title={t(($) => $.edge_label, {
        source: nodeLabelById.get(edge.source) ?? "",
        target: nodeLabelById.get(edge.target) ?? "",
      })}
    >
      {t(($) => $.edge_label, {
        source: nodeLabelById.get(edge.source) ?? "",
        target: nodeLabelById.get(edge.target) ?? "",
      })}
    </span>
  );
  return (
    <>
      {label}
      {aggregate ? (
        <Popover>
          <PopoverTrigger
            render={<Button size="sm" variant="ghost" className="gap-1" />}
          >
            {t(($) => $.edge_aggregate_summary, { count: edge.sourceEdgeIds.length })}
            <ChevronDown className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[26rem] max-w-[80vw] p-2">
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
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
                    {t(($) => $.edge_locate)}
                  </Button>
                </li>
              ))}
            </ul>
            {hasReverse && (
              <p className="mt-1 border-t px-1 pt-1.5 text-micro text-muted-foreground">
                {t(($) => $.edge_aggregate_bidirectional)}
              </p>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        edge.sources[0] && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onLocate([edge.sources[0]!.source, edge.sources[0]!.target])
            }
          >
            {t(($) => $.edge_locate)}
          </Button>
        )
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className="shrink-0"
        aria-label={t(($) => $.clear_selection)}
        onClick={() => storeApi.getState().setDagSelectedEdgeId(null)}
      >
        <X className="size-3.5" />
      </Button>
    </>
  );
}
