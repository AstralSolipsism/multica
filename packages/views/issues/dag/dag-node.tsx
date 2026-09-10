"use client";

import { memo, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  ChevronDown,
  CircleHelp,
  Layers,
  Loader2,
} from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { issueGraphReadiness } from "@multica/core/api";
import type { IssueStatusCategory } from "@multica/core/types";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import { PriorityIcon } from "../components/priority-icon";
import { StatusIcon } from "../components/status-icon";
import { ActorAvatar } from "../../common/actor-avatar";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useT } from "../../i18n";
import type { DagVisibleNode } from "./dag-projection";
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH } from "./dag-layout";

/** Display data for one canvas node. Kept flat and value-typed so React
 *  Flow's node diffing and the memo comparator below stay cheap; interaction
 *  callbacks arrive via context, not node data. */
export type DagFlowNodeData = {
  model: DagVisibleNode;
  direction: DagDirection;
  projectTitle: string | null;
  statusColor: string | null;
  /** In the highlighted upstream/downstream neighborhood of the selection. */
  focused: boolean;
  /** A focus neighborhood is active and this node is outside it. */
  dimmed: boolean;
};

export type DagFlowNode = Node<DagFlowNodeData, "dagNode">;

export function dagNodeSize(kind: DagVisibleNode["kind"]): {
  width: number;
  height: number;
} {
  return {
    width: DAG_NODE_WIDTH,
    height: kind === "issue" ? DAG_NODE_HEIGHT : DAG_NODE_HEIGHT + 10,
  };
}

function RunBadge({ model }: { model: DagVisibleNode }) {
  const { t } = useT("issues");
  if (!model.hasActiveRun) return null;
  const running = model.issue?.runSummary && model.issue.runSummary.running > 0;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-micro font-medium",
        running ? "bg-brand/10 text-brand" : "bg-muted/70 text-muted-foreground",
      )}
      title={running ? t(($) => $.dag.run_active) : t(($) => $.dag.run_queued)}
    >
      <Loader2 className={cn("size-3", running && "animate-spin")} />
      {running ? t(($) => $.dag.run_active) : t(($) => $.dag.run_queued)}
    </span>
  );
}

function DependencyBadge({ model }: { model: DagVisibleNode }) {
  const { t } = useT("issues");
  if (model.kind !== "issue" || !model.issue) return null;
  const readiness = issueGraphReadiness(model.issue.dependencySummary ?? undefined);
  if (readiness === "ready") return null;
  if (readiness === "unknown") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-micro text-muted-foreground"
        title={t(($) => $.dag.readiness_unknown)}
      >
        <CircleHelp className="size-3" />
        {t(($) => $.dag.readiness_unknown)}
      </span>
    );
  }
  const summary = model.issue.dependencySummary;
  const restricted = summary?.hasRestrictedBlockers === true;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-micro font-medium text-warning"
      title={restricted ? t(($) => $.dag.blocked_badge_restricted) : undefined}
    >
      <AlertTriangle className="size-3" />
      {t(($) => $.dag.blocked_badge, {
        count: summary?.visibleUnsatisfiedCount ?? 0,
      })}
    </span>
  );
}

function NodeShell({
  children,
  data,
  selected,
  className,
}: {
  children: ReactNode;
  data: DagFlowNodeData;
  selected?: boolean;
  className?: string;
}) {
  const targetPosition = data.direction === "LR" ? Position.Left : Position.Top;
  const sourcePosition = data.direction === "LR" ? Position.Right : Position.Bottom;
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border bg-card px-2.5 py-2 text-left shadow-xs transition-opacity",
        selected
          ? "border-brand ring-2 ring-brand/30"
          : "border-border hover:border-foreground/30",
        data.dimmed && "opacity-30",
        !data.dimmed && data.focused && "border-brand/60",
        data.model.role === "context" && "border-dashed",
        className,
      )}
      style={{ width: DAG_NODE_WIDTH, minHeight: DAG_NODE_HEIGHT }}
    >
      <Handle type="target" position={targetPosition} className="!opacity-0" />
      {children}
      <Handle type="source" position={sourcePosition} className="!opacity-0" />
    </div>
  );
}

/**
 * The single custom node renders all three kinds — the React Flow registry
 * stays at one entry, and the projection model already carries the kind.
 * Folding state lives in the view store; the node itself is display-only.
 */
export const DagFlowNodeCard = memo(
  function DagFlowNodeCard({ data, selected }: NodeProps<DagFlowNode>) {
    const { t } = useT("issues");
    const { model } = data;

    if (model.kind === "project") {
      return (
        <NodeShell data={data} selected={selected} className="border-2">
          <div className="flex items-center gap-1.5">
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-body font-medium">
              {model.title || t(($) => $.dag.no_project_group)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-muted-foreground">
            <span className="tabular-nums">
              {t(($) => $.dag.members_badge, { count: model.matchCount })}
            </span>
            {model.contextCount > 0 && (
              <span className="tabular-nums">
                {t(($) => $.dag.context_count, { count: model.contextCount })}
              </span>
            )}
            {model.blockedMemberCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-warning">
                <AlertTriangle className="size-3" />
                <span className="tabular-nums">
                  {t(($) => $.dag.blocked_members, {
                    count: model.blockedMemberCount,
                  })}
                </span>
              </span>
            )}
            {model.internalEdgeCount > 0 && (
              <span className="tabular-nums">
                {t(($) => $.dag.internal_edges, { count: model.internalEdgeCount })}
              </span>
            )}
            <RunBadge model={model} />
          </div>
        </NodeShell>
      );
    }

    const issue = model.issue!;
    const statusCategory =
      (issue.statusCategory as IssueStatusCategory) || "todo";
    return (
      <NodeShell data={data} selected={selected}>
        <div className="flex items-center gap-1.5">
          <PriorityIcon priority={issue.priority} className="size-3.5" />
          <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
            {model.identifier}
          </span>
          <StatusIcon
            status={issue.status}
            category={statusCategory}
            color={data.statusColor}
            className="size-3.5"
          />
          {model.kind === "feature" && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted/70 px-1.5 py-0.5 text-micro text-muted-foreground">
              <ChevronDown className="size-3" />
              {t(($) => $.dag.folded_children, {
                count: Math.max(0, model.memberIds.length - 1),
              })}
            </span>
          )}
          <RunBadge model={model} />
          {model.role === "context" && (
            <span className="ml-auto shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-micro text-muted-foreground">
              {t(($) => $.dag.context_badge)}
            </span>
          )}
        </div>
        <div className="line-clamp-2 text-body leading-snug">{model.title}</div>
        <div className="mt-auto flex items-center gap-1.5">
          {issue.assignee ? (
            <ActorAvatar
              actorType={issue.assignee.type}
              actorId={issue.assignee.id}
              size="xs"
            />
          ) : null}
          {issue.stage != null && (
            <span className="shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-micro text-muted-foreground tabular-nums">
              {t(($) => $.dag.stage_badge, { number: issue.stage })}
            </span>
          )}
          {data.projectTitle && (
            <span className="inline-flex min-w-0 shrink items-center gap-1 text-micro text-muted-foreground">
              <ProjectIcon project={null} size="sm" />
              <span className="truncate">{data.projectTitle}</span>
            </span>
          )}
          <DependencyBadge model={model} />
        </div>
      </NodeShell>
    );
  },
  (prev, next) => prev.data === next.data && prev.selected === next.selected,
);
