"use client";

import { memo, type ReactNode } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { DagPort } from "./dag-layout";
import { DagHandles } from "./dag-ports";
import { AlertTriangle, CircleHelp, Loader2 } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { issueGraphReadiness } from "@multica/core/api";
import type { IssueStatusCategory } from "@multica/core/types";
import { PriorityIcon } from "../components/priority-icon";
import { StatusIcon } from "../components/status-icon";
import { ActorAvatar } from "../../common/actor-avatar";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useT } from "../../i18n";
import type { DagVisibleNode } from "./dag-projection";
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH } from "./dag-constants";

/** Display data for one canvas node. Kept flat and value-typed so React
 *  Flow's node diffing and the memo comparator below stay cheap; interaction
 *  callbacks arrive via context, not node data. */
export type DagFlowNodeData = {
  model: DagVisibleNode;
  ports: readonly DagPort[];
  showStage: boolean;
  projectTitle: string | null;
  statusColor: string | null;
  /** In the highlighted upstream/downstream neighborhood of the selection. */
  focused: boolean;
};

export type DagFlowNode = Node<DagFlowNodeData, "dagNode">;

export function DagRunBadge({ model }: { model: DagVisibleNode }) {
  const { t } = useT("dag");
  if (model.runState === "none") return null;
  const running = model.runState === "running";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-micro font-medium",
        running ? "bg-brand/10 text-brand" : "bg-muted/70 text-muted-foreground",
      )}
      title={running ? t(($) => $.run_active) : t(($) => $.run_queued)}
    >
      <Loader2 className={cn("size-3", running && "animate-spin")} />
      {running ? t(($) => $.run_active) : t(($) => $.run_queued)}
    </span>
  );
}

function DependencyBadge({ model }: { model: DagVisibleNode }) {
  const { t } = useT("dag");
  if (model.kind !== "issue" || !model.issue) return null;
  const readiness = issueGraphReadiness(model.issue.dependencySummary ?? undefined);
  if (readiness === "ready") return null;
  if (readiness === "unknown") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-micro text-muted-foreground"
        title={t(($) => $.readiness_unknown)}
      >
        <CircleHelp className="size-3" />
        {t(($) => $.readiness_unknown)}
      </span>
    );
  }
  const summary = model.issue.dependencySummary;
  const restricted = summary?.hasRestrictedBlockers === true;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-micro font-medium text-warning"
      title={restricted ? t(($) => $.blocked_badge_restricted) : undefined}
    >
      <AlertTriangle className="size-3" />
      {t(($) => $.blocked_badge, {
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
  return (
    <div
      className={cn(
        "nopan flex flex-col gap-1 rounded-lg border bg-card px-2.5 py-2 text-left shadow-xs transition-opacity",
        selected ? "border-brand ring-2 ring-brand/30" : "border-border hover:border-foreground/30",
        data.model.issue?.statusCategory === "done" && "bg-muted/10",
        data.focused && "border-brand/60",
        data.model.role === "context" && "border-dashed",
        className,
      )}
      style={{ width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }}
      data-dag-issue={data.model.identifier}
    >
      <DagHandles
        nodeId={data.model.id}
        ports={data.ports}
        width={DAG_NODE_WIDTH}
        height={DAG_NODE_HEIGHT}
      />
      {children}
    </div>
  );
}

/**
 * An issue card keeps the existing status, priority and assignment signals.
 * Folding state lives in the view store; the node itself is display-only.
 */
export const DagFlowNodeCard = memo(
  function DagFlowNodeCard({ data, selected }: NodeProps<DagFlowNode>) {
    const { t } = useT("dag");
    const { model } = data;

    const issue = model.issue!;
    const statusCategory = (issue.statusCategory as IssueStatusCategory) || "unstarted";
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
          <DagRunBadge model={model} />
          {model.role === "context" && (
            <span className="ml-auto shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-micro text-muted-foreground">
              {t(($) => $.context_badge)}
            </span>
          )}
        </div>
        <div className="line-clamp-2 text-body leading-snug">{model.title}</div>
        <div className="mt-auto flex items-center gap-1.5">
          {issue.assignee ? (
            <ActorAvatar actorType={issue.assignee.type} actorId={issue.assignee.id} size="xs" />
          ) : null}
          {data.showStage && issue.stage != null && (
            <span className="shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-micro text-muted-foreground tabular-nums">
              {t(($) => $.stage_badge, { number: issue.stage })}
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
