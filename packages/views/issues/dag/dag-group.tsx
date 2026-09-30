"use client";
import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import {
  ArrowDown,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Crosshair,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import type { DagVisibleGroup } from "./dag-projection";
import type { DagGroupBounds } from "./dag-layout";
import { DagRunBadge, type DagFlowNodeData } from "./dag-node";
import type { IssueStatusCategory } from "@multica/core/types";
import { StatusIcon } from "../components/status-icon";
import { DagHandles } from "./dag-ports";
import { DAG_GROUP_HEADER_HEIGHT } from "./dag-constants";

export type DagFlowGroupData = DagFlowNodeData & {
  group: DagVisibleGroup;
  bounds: DagGroupBounds;
  direction: DagDirection;
  activeStage: number | null;
  onToggle: (id: string) => void;
  onFocus: (id: string) => void;
  onOpen: (id: string) => void;
};
export type DagFlowGroup = Node<DagFlowGroupData, "dagGroup">;

export const DagFlowGroupCard = memo(function DagFlowGroupCard({
  id,
  data,
}: NodeProps<DagFlowGroup>) {
  const { t } = useT("issues");
  const { model, group, bounds, direction } = data;
  const title = group.independent ? t(($) => $.dag.independent_group) : model.title;
  return (
    <div
      className={cn(
        "relative h-full w-full rounded-lg border bg-card",
        model.role === "context" && "border-dashed",
        data.focused ? "border-brand/70 ring-1 ring-brand/20" : "border-muted-foreground/25",
      )}
      data-dag-group={id}
      data-collapsed={group.collapsed}
    >
      <DagHandles nodeId={id} ports={data.ports} width={bounds.width} height={bounds.height} />
      <div
        className={cn(
          "absolute left-0 top-0 z-10 flex w-full items-center gap-2 bg-card px-3 py-2",
          group.collapsed ? "rounded-lg" : "rounded-t-lg",
        )}
        style={{ height: DAG_GROUP_HEADER_HEIGHT - 2, maxWidth: 680 }}
      >
        <button
          type="button"
          className="nodrag nopan flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand"
          aria-expanded={!group.collapsed}
          aria-label={model.identifier ? `${model.identifier} ${title}` : title}
          onClick={() => data.onToggle(id)}
        >
          {group.collapsed ? (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )}
          {model.issue && (
            <span data-dag-parent-status={model.issue.status} title={model.issue.status}>
              <StatusIcon
                status={model.issue.status}
                category={model.issue.statusCategory as IssueStatusCategory}
                color={data.statusColor}
                className="size-4 shrink-0"
              />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium" title={title}>
              {model.identifier && (
                <span className="mr-2 text-caption font-normal text-muted-foreground">
                  {model.identifier}
                </span>
              )}
              {title}
            </span>
            <span className="mt-1 flex items-center gap-2 text-micro text-muted-foreground">
              {data.showStage && model.issue?.stage != null && (
                <span className="shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 tabular-nums">
                  {t(($) => $.dag.stage_badge, { number: model.issue.stage })}
                </span>
              )}
              {data.projectTitle && <span className="max-w-32 truncate">{data.projectTitle}</span>}
              <span className="shrink-0">
                {t(($) => $.dag.group_progress, {
                  done: group.completedCount,
                  count: group.taskCount,
                })}
              </span>
              <span aria-hidden className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full bg-brand/60"
                  style={{
                    width: `${group.taskCount ? (group.completedCount / group.taskCount) * 100 : 0}%`,
                  }}
                />
              </span>
            </span>
          </span>
          <DagRunBadge model={model} />
        </button>
        {bounds.stageConflict && (
          <span title={t(($) => $.dag.stage_conflict)}>
            <AlertTriangle className="size-3.5 text-warning" />
          </span>
        )}
        <Button
          className="nodrag nopan shrink-0"
          variant="ghost"
          size="icon-sm"
          aria-label={t(($) => $.dag.focus_line)}
          title={t(($) => $.dag.focus_line)}
          onClick={() => data.onFocus(id)}
        >
          <Crosshair className="size-3.5" />
        </Button>
        {model.issue && (
          <Button
            className="nodrag nopan shrink-0"
            variant="ghost"
            size="icon-sm"
            aria-label={t(($) => $.dag.parent_details)}
            title={t(($) => $.dag.parent_details)}
            onClick={() => data.onOpen(model.issue!.id)}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        )}
      </div>
      {!group.collapsed && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden rounded-b-lg border-t"
          style={{ top: DAG_GROUP_HEADER_HEIGHT }}
        >
          {bounds.bands.map((band, i) => {
            const vertical = direction === "TB",
              active = band.stage === data.activeStage;
            const style = vertical
              ? {
                  left: 0,
                  top: band.start - DAG_GROUP_HEADER_HEIGHT,
                  width: "100%",
                  height: band.end - band.start,
                }
              : { left: band.start, top: 0, width: band.end - band.start, height: "100%" };
            return (
              <div
                key={band.stage}
                data-dag-stage={band.stage}
                data-active={active}
                className={cn(
                  "absolute",
                  vertical
                    ? "border-t border-muted-foreground/25 first:border-t-0"
                    : "border-l border-muted-foreground/25 first:border-l-0",
                  active ? "bg-brand/5" : i % 2 ? "bg-muted/25" : "bg-card",
                )}
                style={style}
              >
                <div
                  className={cn(
                    "relative flex h-9 items-center border-b bg-muted/45 px-4 text-body font-semibold",
                    active ? "text-brand" : "text-foreground/85",
                  )}
                >
                  {t(($) => $.dag.stage_badge, { number: band.stage })}
                  {i < bounds.bands.length - 1 &&
                    (vertical ? (
                      <ArrowDown className="ml-2 size-3 text-faint-foreground" aria-hidden />
                    ) : (
                      <ArrowRight
                        className="absolute -right-1.5 size-3 text-faint-foreground"
                        aria-hidden
                      />
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
