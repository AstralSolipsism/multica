"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Play } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import type { BaselineRevision, ChapterState } from "@multica/core/api";
import { paths } from "@multica/core/paths";
import type { Issue, TimelineEntry } from "@multica/core/types";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { RichContent } from "../../rich-content";
import { useEngineeringChapterLabel, useFormatRelativeDate } from "./labels";

export interface EngineeringDecisionTimeline {
  comment: TimelineEntry | null;
  loading: boolean;
  error: boolean;
}

interface EngineeringDecisionsProps {
  workspaceSlug: string;
  issues: readonly Issue[];
  timelines: Readonly<Record<string, EngineeringDecisionTimeline>>;
  chapters: readonly ChapterState[];
  candidates: readonly BaselineRevision[];
  processedCount: number;
  sourceLabels: Readonly<Record<string, string>>;
  reviewStage: number | null;
  onOpenCandidate: (candidateId: string) => void;
  onOpenProcessed: () => void;
  onOpenWiki: () => void;
  onReview: () => void;
}

export function EngineeringDecisions({ workspaceSlug, issues, timelines, chapters, candidates, processedCount, sourceLabels, reviewStage, onOpenCandidate, onOpenProcessed, onOpenWiki, onReview }: EngineeringDecisionsProps) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const chapterLabel = useEngineeringChapterLabel(chapters);
  const formatRelativeDate = useFormatRelativeDate();
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);
  const count = issues.length + candidates.length + (reviewStage === null ? 0 : 1);
  return (
    <section className="border-t border-foreground pt-2" aria-label={t(($) => $.decisions.title)} data-engineering-region="decisions">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.decisions.title)}{count ? ` · ${count}` : ""}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onOpenProcessed}>{t(($) => $.decisions.processed, { count: processedCount })}</Button>
          <Button type="button" size="sm" disabled={!candidates.length} onClick={() => candidates[0] && onOpenCandidate(candidates[0].id)}>
            <Play aria-hidden="true" />{t(($) => $.decisions.startContinuous, { count: candidates.length })}
          </Button>
        </div>
      </div>
      <div>
        {issues.map((issue) => {
          const timeline = timelines[issue.id];
          const expanded = expandedIssueId === issue.id;
          const contentId = `engineering-decision-${issue.id}`;
          return (
            <div key={issue.id} className="border-b" data-decision-issue={issue.identifier}>
              <div className="flex items-center gap-2">
                <button type="button" className="group grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 text-left" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpandedIssueId(expanded ? null : issue.id)}>
                  <CircleDot className="size-3 text-destructive" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{issue.title}</span>
                    <span className="block text-caption text-muted-foreground">
                      {issue.identifier} · {timeline?.loading ? t(($) => $.decisions.loading) : timeline?.error ? t(($) => $.errors.timeline) : t(($) => $.decisions.blockedHint)}
                    </span>
                  </span>
                  {expanded ? <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />}
                </button>
                <AppLink href={paths.workspace(workspaceSlug).issueDetail(issue.id)} aria-label={t(($) => $.decisions.openIssue, { identifier: issue.identifier })} className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground">
                  <ArrowRight className="size-4" aria-hidden="true" />
                </AppLink>
              </div>
              {expanded ? (
                <div id={contentId} className="mb-4 ml-6 space-y-3 border-l pl-4" data-decision-content={issue.identifier}>
                  {timeline?.loading ? <p className="text-caption text-muted-foreground">{t(($) => $.decisions.loading)}</p> : null}
                  {timeline?.error ? <p className="text-caption text-destructive">{t(($) => $.errors.timeline)}</p> : null}
                  {timeline && !timeline.loading && !timeline.error ? (
                    timeline.comment ? <RichContent content={timeline.comment.content ?? ""} attachments={timeline.comment.attachments} /> : <p className="text-caption text-muted-foreground">{t(($) => $.decisions.noComment)}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {candidates.length ? candidates.map((candidate) => {
          const added = candidate.anchorsDiff.added.length + candidate.anchorsDiff.modified.length;
          const removed = candidate.anchorsDiff.removed.length + candidate.anchorsDiff.modified.length;
          const changes = candidate.anchorsDiff.added.length + candidate.anchorsDiff.modified.length + candidate.anchorsDiff.removed.length;
          return (
            <button key={candidate.id} type="button" className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b py-3 text-left" onClick={() => onOpenCandidate(candidate.id)} data-candidate-todo={candidate.id}>
              <CircleDot className="size-3 text-destructive" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{chapterLabel(candidate.chapter)}</span>
                <span className="block truncate text-caption text-muted-foreground">{candidate.changeSummary || t(($) => $.recent.noSummary)}</span>
                <span className="mt-1 block truncate text-micro text-muted-foreground">
                  {(candidate.sourceIssueId ? sourceLabels[candidate.sourceIssueId] ?? candidate.sourceIssueId : t(($) => $.baseline.sourceIssue))} · {getActorName(candidate.createdByType, candidate.createdById)} · <time dateTime={candidate.createdAt}>{formatRelativeDate(candidate.createdAt)}</time> · {t(($) => $.decisions.changeMeta, { added, removed, count: changes })}
                </span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
            </button>
          );
        }) : (
          <div className="border-b py-8 text-center" data-no-pending-candidates>
            <p className="text-body text-muted-foreground">{t(($) => $.decisions.noPendingCandidates)}</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onOpenProcessed}>{t(($) => $.decisions.processed, { count: processedCount })}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={onOpenWiki}>{t(($) => $.decisions.openWiki)}</Button>
            </div>
          </div>
        )}
        {reviewStage !== null ? (
          <button type="button" className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b py-3 text-left" onClick={onReview} data-review-todo>
            <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block font-medium">{t(($) => $.decisions.reviewPending, { stage: reviewStage })}</span>
              <span className="block text-caption text-muted-foreground">{t(($) => $.decisions.reviewHint)}</span>
            </span>
            <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  );
}
