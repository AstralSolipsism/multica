"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import type { IssueGraphNode } from "@multica/core/api";
import { issueRouteRef, paths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { useStatusLabel } from "../../issues/utils/status-label";
import { StatusIcon } from "../../issues/components/status-icon";
import { ActorAvatar } from "../../common/actor-avatar";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { statusCategoryOfKey } from "@multica/core/issues";
import { isClosedEngineeringNode, type EngineeringStageSummary } from "./engineering-utils";

export type EngineeringTaskGroup = "blocked" | "in_review" | "in_progress" | "todo" | "completed";

interface EngineeringProgressProps {
  workspaceSlug: string;
  workspaceId: string;
  summary: EngineeringStageSummary | null;
  outside: readonly IssueGraphNode[];
  highlightGroup?: EngineeringTaskGroup;
}

export function EngineeringTaskRow({ node, workspaceSlug, workspaceId, compact = false }: {
  node: IssueGraphNode;
  workspaceSlug: string;
  workspaceId: string;
  compact?: boolean;
}) {
  const statusLabel = useStatusLabel(workspaceId);
  const { colorOf: statusColorOf, iconOf: statusIconOf } = useIssueStatuses(workspaceId);
  const { getActorName } = useActorName();
  return (
    <li className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/70 last:border-b-0", compact ? "h-10 items-center py-0" : "items-start py-2.5")} data-engineering-task={node.identifier}>
      <AppLink href={paths.workspace(workspaceSlug).issueDetail(issueRouteRef(node))} className="min-w-0 text-body hover:underline">
        <span className="mr-2 font-mono text-caption text-muted-foreground">{node.identifier}</span>
        <span className={isClosedEngineeringNode(node) ? "text-muted-foreground" : undefined}>{node.title}</span>
      </AppLink>
      <span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
        {node.assignee ? (
          <span className="hidden items-center gap-1 sm:inline-flex">
            <ActorAvatar actorType={node.assignee.type} actorId={node.assignee.id} size="xs" profileLink={false} />
            {getActorName(node.assignee.type, node.assignee.id)}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <StatusIcon status={node.status} category={statusCategoryOfKey(node.statusCategory)} color={statusColorOf(node.status)} icon={statusIconOf(node.status)} className="size-3.5 shrink-0" />
          {statusLabel(node.status)}
        </span>
      </span>
    </li>
  );
}

export function EngineeringProgress({ workspaceSlug, workspaceId, summary, outside, highlightGroup }: EngineeringProgressProps) {
  const { t } = useT("engineering");
  const [showCompleted, setShowCompleted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!highlightGroup) return;
    if (highlightGroup === "completed") setShowCompleted(true);
    const frame = requestAnimationFrame(() => rootRef.current?.querySelector(`[data-task-group="${highlightGroup}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [highlightGroup]);

  if (!summary) {
    return (
      <div ref={rootRef} data-engineering-region="outside">
        <h2 className="text-title-sm font-semibold">{t(($) => $.progress.unstaged)} <span className="text-muted-foreground tabular-nums">({outside.length})</span></h2>
        <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.progress.outsideHint)}</p>
        {outside.length ? <ul className="mt-4 border-t" data-outside-tasks>{outside.map((node) => <EngineeringTaskRow key={node.id} node={node} workspaceSlug={workspaceSlug} workspaceId={workspaceId} />)}</ul> : <p className="mt-4 rounded-md border border-dashed p-6 text-center text-body text-muted-foreground">{t(($) => $.progress.outsideEmpty)}</p>}
      </div>
    );
  }

  const open = summary.tasks.filter((node) => !isClosedEngineeringNode(node));
  const completed = summary.tasks.filter(isClosedEngineeringNode);
  const groups: { key: EngineeringTaskGroup; label: string; tasks: IssueGraphNode[] }[] = [
    { key: "blocked", label: t(($) => $.progress.blockedGroup), tasks: open.filter((node) => node.status === "blocked") },
    { key: "in_review", label: t(($) => $.progress.reviewGroup), tasks: open.filter((node) => node.status === "in_review") },
    { key: "in_progress", label: t(($) => $.progress.progressGroup), tasks: open.filter((node) => node.statusCategory === "started" && node.status !== "blocked" && node.status !== "in_review") },
    { key: "todo", label: t(($) => $.progress.todoGroup), tasks: open.filter((node) => node.statusCategory !== "started" && node.status !== "blocked" && node.status !== "in_review") },
  ];
  return (
    <div ref={rootRef} data-engineering-region="progress" data-stage={summary.stage}>
      {groups.map((group) => group.tasks.length ? (
        <section key={group.key} className={cn("mt-5 rounded-sm px-2 -mx-2", highlightGroup === group.key && "bg-brand/5")} data-task-group={group.key}>
          <h4 className={group.key === "blocked" ? "text-caption font-medium text-destructive" : "text-caption font-medium text-muted-foreground"}>
            {group.label} <span className="ml-1 tabular-nums">{group.tasks.length}</span>
          </h4>
          <ul className="mt-1 border-t">
            {group.tasks.map((node) => <EngineeringTaskRow key={node.id} node={node} workspaceSlug={workspaceSlug} workspaceId={workspaceId} />)}
          </ul>
        </section>
      ) : null)}
      {summary.total === 0 ? <p className="rounded-md border border-dashed p-6 text-center text-body text-muted-foreground">{t(($) => $.progress.emptyStage)}</p> : null}
      {completed.length ? (
        <div className={cn("mt-5 rounded-sm px-2 -mx-2", highlightGroup === "completed" && "bg-brand/5")} data-task-group="completed">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" aria-expanded={showCompleted} onClick={() => setShowCompleted((value) => !value)}>
            {showCompleted ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {showCompleted ? t(($) => $.progress.hideCompleted, { count: completed.length }) : t(($) => $.progress.showCompleted, { count: completed.length })}
          </Button>
          {showCompleted ? <ul data-completed-tasks>{completed.map((node) => <EngineeringTaskRow key={node.id} node={node} workspaceSlug={workspaceSlug} workspaceId={workspaceId} />)}</ul> : null}
        </div>
      ) : null}
    </div>
  );
}
