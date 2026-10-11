"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import type { IssueGraph } from "@multica/core/api";
import type { DagFocusWay } from "@multica/core/issues/stores/view-store";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { useT } from "../../i18n";
import { DagAssignAction, useDagIssueSelection } from "./dag-issue-actions";
import { dagFocusNeighborhood, type DagProjection, type DagVisibleGroup, type DagVisibleNode } from "./dag-projection";
import { useActionCapacity } from "./use-action-capacity";

type ActionKey = "open" | "upstream" | "downstream" | "edit" | "assign";

/** The selection zone's node state: label, standing actions (collapsing
 *  right-to-left into More on narrow widths), the hidden-chain hint and the
 *  trailing clear button. */
export function DagNodeSelection({
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

  const actionKeys: ActionKey[] = [
    ...(node.issue ? (["open"] as const) : []),
    "upstream",
    "downstream",
    ...(node.issue ? (["edit", "assign"] as const) : []),
  ];
  const { zoneRef, visibleCount } = useActionCapacity(actionKeys, node.id);
  const visibleKeys = actionKeys.slice(0, visibleCount);
  const menuKeys = actionKeys.slice(visibleCount);

  const focusLineId = group?.id ?? node.groupId;
  const foldTarget = group ?? (node.groupId ? groupModels.get(node.groupId) : undefined);
  const actionNodes: Record<ActionKey, React.ReactNode> = {
    open: (
      <Button size="sm" variant="ghost" onClick={() => onOpenIssue(node.issue!.id)}>
        {tDag(($) => $.open_detail)}
      </Button>
    ),
    upstream: (
      <Button
        size="sm"
        variant={focusActive("upstream") ? "secondary" : "ghost"}
        aria-pressed={focusActive("upstream")}
        onClick={() => toggleFocus("upstream")}
      >
        {tDag(($) => $.focus_upstream)}
      </Button>
    ),
    downstream: (
      <Button
        size="sm"
        variant={focusActive("downstream") ? "secondary" : "ghost"}
        aria-pressed={focusActive("downstream")}
        onClick={() => toggleFocus("downstream")}
      >
        {tDag(($) => $.focus_downstream)}
      </Button>
    ),
    edit: (
      <Button
        size="sm"
        variant="ghost"
        disabled={!issue}
        onClick={actions.openEditDependencies}
      >
        {tDag(($) => $.edit_dependencies)}
      </Button>
    ),
    assign: <DagAssignAction issue={issue} onUpdate={actions.updateField} />,
  };
  const menuItems: Record<ActionKey, React.ReactNode> = {
    open: (
      <DropdownMenuItem key="open" onClick={() => onOpenIssue(node.issue!.id)}>
        {tDag(($) => $.open_detail)}
      </DropdownMenuItem>
    ),
    upstream: (
      <DropdownMenuCheckboxItem
        key="upstream"
        checked={focusActive("upstream")}
        onCheckedChange={() => toggleFocus("upstream")}
      >
        {tDag(($) => $.focus_upstream)}
      </DropdownMenuCheckboxItem>
    ),
    downstream: (
      <DropdownMenuCheckboxItem
        key="downstream"
        checked={focusActive("downstream")}
        onCheckedChange={() => toggleFocus("downstream")}
      >
        {tDag(($) => $.focus_downstream)}
      </DropdownMenuCheckboxItem>
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
    <div ref={zoneRef} data-dag-zone className="flex min-w-0 flex-1 items-center gap-1">
      <span
        data-dag-label
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
      {visibleKeys.map((key) => (
        <span key={key} data-dag-action={key} className="inline-flex shrink-0">
          {actionNodes[key]}
        </span>
      ))}
      {detailFailed && (
        <Button size="sm" variant="ghost" onClick={retryDetail}>
          {tDag(($) => $.error_retry)}
        </Button>
      )}
      {hasMenu && (
        <span data-dag-fixed className="relative inline-flex shrink-0">
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
          {menuKeys.includes("assign") && issue && (
            <DagAssignAction
              issue={issue}
              onUpdate={actions.updateField}
              open={assignFromMenu}
              onOpenChange={setAssignFromMenu}
              anchor={<span className="absolute inset-x-0 top-full h-px" aria-hidden />}
            />
          )}
        </span>
      )}
      {focusHiddenCount > 0 && !showCompleted && (
        <span data-dag-fixed className="inline-flex shrink-0 items-center gap-1 text-warning">
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
      <span data-dag-fixed className="inline-flex shrink-0">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={tDag(($) => $.clear_selection)}
          onClick={() => storeApi.getState().setDagSelectedNodeId(null)}
        >
          <X className="size-3.5" />
        </Button>
      </span>
    </div>
  );
}
