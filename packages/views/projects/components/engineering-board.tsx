"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, FileText } from "@multica/ui/icons";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import type { WikiActivityItem } from "@multica/core/api";
import type { Issue } from "@multica/core/types";
import { useT } from "../../i18n";
import { EngineeringDecisions, type EngineeringDecisionTimeline } from "./engineering-decisions";
import { EngineeringTaskRow } from "./engineering-progress";
import { isClosedEngineeringNode, type EngineeringRoadmap } from "./engineering-utils";

interface EngineeringBoardProps {
  workspaceSlug: string;
  workspaceId: string;
  projectId: string;
  roadmap: EngineeringRoadmap;
  currentStage: number;
  modeSummary: string;
  issues: readonly Issue[];
  timelines: Readonly<Record<string, EngineeringDecisionTimeline>>;
  reviewStage: number | null;
  decisionError: boolean;
  onRetryDecisions: () => void;
  wikiPageCount: number;
  latestActivity: WikiActivityItem | null;
  activityLoading: boolean;
  onReview: () => void;
  onOpenStages: (stage: number, group?: "in_review" | "in_progress" | "todo" | "completed") => void;
  onOpenWiki: () => void;
  onOpenActivity: () => void;
}

export function EngineeringBoard({ workspaceSlug, workspaceId, projectId, roadmap, currentStage, modeSummary, issues, timelines, reviewStage, decisionError, onRetryDecisions, wikiPageCount, latestActivity, activityLoading, onReview, onOpenStages, onOpenWiki, onOpenActivity }: EngineeringBoardProps) {
  const { t } = useT("engineering");
  const [strategyOpen, setStrategyOpen] = useState(false);
  const current = roadmap.stages.find((stage) => stage.stage === currentStage) ?? roadmap.stages[0];
  const stageNumber = current?.stage ?? currentStage;
  const closed = current?.closed ?? 0;
  const total = current?.total ?? 0;
  const percent = total ? Math.round(closed / total * 100) : 0;
  const hasWaiting = issues.length > 0 || reviewStage !== null;
  const activeTasks = [...(current?.tasks ?? [])]
    .filter((task) => !isClosedEngineeringNode(task))
    .sort((a, b) => (b.runSummary?.running ?? 0) - (a.runSummary?.running ?? 0) || (b.runSummary?.dispatched ?? 0) - (a.runSummary?.dispatched ?? 0))
    .slice(0, 3);
  const buckets = [
    { key: "in_review" as const, label: t(($) => $.progress.reviewGroup), count: current?.inReview ?? 0 },
    { key: "in_progress" as const, label: t(($) => $.progress.progressGroup), count: current?.inProgress ?? 0 },
    { key: "todo" as const, label: t(($) => $.progress.todoGroup), count: current?.todo ?? 0 },
    { key: "completed" as const, label: t(($) => $.progress.completedGroup), count: closed },
  ];

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden" data-engineering-board>
      <div className="relative h-[46px] shrink-0 border-b">
        <div className="flex h-full items-center justify-between gap-4 px-4 md:px-5">
          <div className="flex min-w-0 items-center gap-3 text-caption">
            <span className="shrink-0 font-medium">{t(($) => $.stage.label, { number: stageNumber })}</span>
            <span className="min-w-0 truncate text-muted-foreground">{current?.title || t(($) => $.stage.default, { number: stageNumber })}</span>
            <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={closed}>
              <div className="h-full bg-foreground" style={{ width: `${percent}%` }} />
            </div>
            <span className="shrink-0 text-muted-foreground tabular-nums">{t(($) => $.stage.completedCount, { closed, total })}</span>
            <Badge variant="secondary" className={cn("hidden @[560px]:inline-flex", !hasWaiting && "text-success")}>{t(($) => hasWaiting ? $.stage.status[current?.status ?? "current"] : $.board.healthy)}</Badge>
          </div>
          <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-expanded={strategyOpen} onClick={() => setStrategyOpen((value) => !value)}>
            {t(($) => $.stage.summaryLabel)}{strategyOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </Button>
        </div>
        {strategyOpen ? <div className="absolute right-4 top-full z-30 max-w-[560px] whitespace-pre-wrap rounded-b-md border border-t-0 bg-surface-raised px-4 py-3 text-body text-muted-foreground shadow-[var(--menu-shadow)]">{modeSummary || t(($) => $.stage.summaryEmpty)}</div> : null}
      </div>

      {decisionError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-3 text-body text-destructive">
          <span>{t(($) => $.errors.decisionIssues)}</span><Button type="button" variant="outline" size="sm" onClick={onRetryDecisions}>{t(($) => $.actions.retry)}</Button>
        </div>
      ) : hasWaiting ? (
        <EngineeringDecisions workspaceSlug={workspaceSlug} projectId={projectId} issues={issues} timelines={timelines} reviewStage={reviewStage} onReview={onReview} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:px-5">
          <div className="grid shrink-0 grid-cols-2 overflow-hidden rounded-md border @[720px]:grid-cols-4" data-board-buckets>
            {buckets.map((bucket) => (
              <button key={bucket.key} type="button" className="border-b border-r px-4 py-3 text-left last:border-r-0 hover:bg-muted/40 @[720px]:border-b-0" onClick={() => onOpenStages(stageNumber, bucket.key)} data-board-bucket={bucket.key}>
                <span className="block text-h2 font-semibold tabular-nums">{bucket.count}</span>
                <span className="mt-1 block text-caption text-muted-foreground">{bucket.label}</span>
              </button>
            ))}
          </div>
          <section className="mt-5 min-h-0">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-caption font-medium text-muted-foreground">{t(($) => $.board.activeTasks)}</h2>
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onOpenStages(stageNumber)}>{t(($) => $.board.viewStages)}</Button>
            </div>
            {activeTasks.length ? <ul className="border-t">{activeTasks.map((task) => <EngineeringTaskRow key={task.id} node={task} workspaceSlug={workspaceSlug} workspaceId={workspaceId} compact />)}</ul> : <p className="border-t py-6 text-center text-caption text-muted-foreground">{t(($) => $.board.noActiveTasks)}</p>}
          </section>
        </div>
      )}

      <div className="grid min-h-[68px] shrink-0 grid-cols-1 border-t @[1024px]:h-[68px] @[1024px]:grid-cols-[1.25fr_1fr]" data-board-routing>
        <div className="flex h-10 min-w-0 items-center gap-2 overflow-x-auto border-b px-4 @[1024px]:h-auto @[1024px]:border-b-0 @[1024px]:border-r">
          {roadmap.stages.map((stage) => <Button key={stage.stage} type="button" variant={stage.stage === stageNumber ? "secondary" : "outline"} size="sm" className="h-8 shrink-0 text-caption" onClick={() => onOpenStages(stage.stage)}>{t(($) => $.stage.label, { number: stage.stage })}<span className="text-muted-foreground tabular-nums">{stage.closed}/{stage.total}</span></Button>)}
        </div>
        <div className="flex min-w-0 items-center gap-3 px-4">
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Button type="button" variant="link" size="sm" className="h-auto shrink-0 p-0" onClick={onOpenWiki} data-testid="wiki-enter">{t(($) => $.wiki.summaryPageCount, { count: wikiPageCount })}</Button>
          <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground" data-board-latest-activity>
            {activityLoading ? "…" : latestActivity ? latestActivity.changeSummary || latestActivity.title || latestActivity.slug : t(($) => $.wiki.activityEmpty)}
          </span>
          <Button type="button" variant="ghost" size="sm" className="shrink-0 px-2" onClick={onOpenWiki} aria-label={t(($) => $.wiki.enter)}><span className="hidden @[1280px]:inline">{t(($) => $.wiki.enter)}</span><ArrowRight aria-hidden="true" /></Button>
          <Button type="button" variant="link" size="sm" className="hidden h-auto shrink-0 p-0 @[1280px]:inline-flex" onClick={onOpenActivity}>{t(($) => $.board.allActivity)}</Button>
        </div>
      </div>
    </main>
  );
}
