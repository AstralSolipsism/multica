"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2 } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { paths } from "@multica/core/paths";
import type { Issue, TimelineEntry } from "@multica/core/types";
import { issueStatusCategory } from "@multica/core/issues";
import { issueKeys } from "@multica/core/issues/queries";
import { useCreateComment } from "@multica/core/issues/mutations";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { engineeringProjectKeys } from "@multica/core/projects/queries";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { RichContent } from "../../rich-content";
import { HtmlBlockHostActionsProvider, type HtmlBlockHostActions } from "../../editor/html-block-host-actions";
import { StatusIcon } from "../../issues/components/status-icon";
import { useIssuePeekActions } from "../../issues/surface/peek-context";

export interface EngineeringDecisionTimeline {
  comment: TimelineEntry | null;
  loading: boolean;
  error: boolean;
}

interface EngineeringDecisionsProps {
  workspaceSlug: string;
  projectId: string;
  issues: readonly Issue[];
  timelines: Readonly<Record<string, EngineeringDecisionTimeline>>;
  reviewStage: number | null;
  onReview: () => void;
}

function EngineeringDecisionDetail({ workspaceSlug, projectId, issue, timeline, onSubmitted }: {
  workspaceSlug: string;
  projectId: string;
  issue: Issue;
  timeline: EngineeringDecisionTimeline;
  onSubmitted: (issueId: string) => void;
}) {
  const { t } = useT("engineering");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const peek = useIssuePeekActions();
  const { colorOf: statusColorOf, iconOf: statusIconOf } = useIssueStatuses(wsId);
  const { mutateAsync: createComment } = useCreateComment(issue.id);
  const parentId = timeline.comment?.id;
  const actions = useMemo<HtmlBlockHostActions>(() => ({
    submitComment: async (content) => {
      if (!parentId) return false;
      try {
        await createComment({ content, parentId });
      } catch {
        return false;
      }
      void qc.invalidateQueries({ queryKey: issueKeys.tasks(issue.id) });
      void qc.invalidateQueries({ queryKey: issueKeys.timeline(issue.id) });
      void qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringDecisionIssuesAll(wsId, projectId) });
      // Let the shared HTML bridge post its successful action-result before the
      // selected card leaves the board.
      window.setTimeout(() => onSubmitted(issue.id), 0);
      return true;
    },
    fillComment: (content) => {
      if (!peek) return false;
      useCommentDraftStore.getState().setDraft(`new:${issue.id}`, content);
      peek.open(issue.id, { commentDraft: content });
      return true;
    },
  }), [createComment, issue.id, onSubmitted, parentId, peek, projectId, qc, wsId]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-decision-content={issue.identifier}>
      <header className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
        <StatusIcon status={issue.status} category={issueStatusCategory(issue) ?? undefined} color={statusColorOf(issue.status)} icon={statusIconOf(issue.status)} className="size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{issue.title}</div>
          <div className="font-mono text-caption text-muted-foreground">{issue.identifier}</div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {timeline.loading ? <p className="text-caption text-muted-foreground">{t(($) => $.decisions.loading)}</p> : null}
        {timeline.error ? <p className="text-caption text-destructive">{t(($) => $.errors.timeline)}</p> : null}
        {!timeline.loading && !timeline.error ? (
          timeline.comment ? (
            <HtmlBlockHostActionsProvider value={actions}>
              <RichContent content={timeline.comment.content ?? ""} attachments={timeline.comment.attachments} phase="settled" />
            </HtmlBlockHostActionsProvider>
          ) : <p className="text-caption text-muted-foreground">{t(($) => $.decisions.noComment)}</p>
        ) : null}
      </div>
      <footer className="flex shrink-0 justify-end border-t px-5 py-2">
        <AppLink href={paths.workspace(workspaceSlug).issueDetail(issue.id)} className="inline-flex h-8 items-center gap-1 rounded-md px-3 text-caption hover:bg-muted">
          {t(($) => $.decisions.openIssue, { identifier: issue.identifier })}<ArrowRight aria-hidden="true" />
        </AppLink>
      </footer>
    </section>
  );
}

export function EngineeringDecisions({ workspaceSlug, projectId, issues, timelines, reviewStage, onReview }: EngineeringDecisionsProps) {
  const { t } = useT("engineering");
  const wsId = useWorkspaceId();
  const { colorOf: statusColorOf, iconOf: statusIconOf } = useIssueStatuses(wsId);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [submittedIssueIds, setSubmittedIssueIds] = useState<ReadonlySet<string>>(() => new Set());
  const onSubmitted = useCallback((issueId: string) => {
    setSubmittedIssueIds((current) => new Set(current).add(issueId));
  }, []);
  const visibleIssues = issues.filter((issue) => !submittedIssueIds.has(issue.id));
  const reviewSelected = selectedIssueId === "review" && reviewStage !== null;
  const selectedIssue = reviewSelected ? undefined : visibleIssues.find((issue) => issue.id === selectedIssueId) ?? visibleIssues[0];
  const showReview = reviewStage !== null && (reviewSelected || !selectedIssue);
  const count = visibleIssues.length + (reviewStage === null ? 0 : 1);
  if (!count) return null;

  return (
    <section className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,2fr)] @[1024px]:grid-cols-[300px_minmax(0,1fr)] @[1024px]:grid-rows-1 @[1280px]:grid-cols-[348px_minmax(0,1fr)]" aria-label={t(($) => $.decisions.title)} data-engineering-region="decisions">
      <div className="flex min-h-0 flex-col border-b @[1024px]:border-b-0 @[1024px]:border-r">
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-caption font-medium text-muted-foreground">
          <span>{t(($) => $.decisions.title)}</span><span className="tabular-nums">{count}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visibleIssues.map((issue) => {
            const selected = selectedIssue?.id === issue.id;
            const timeline = timelines[issue.id];
            return (
              <button
                key={issue.id}
                type="button"
                className={cn("relative block w-full border-b px-3 py-3 text-left hover:bg-muted/50", selected && "bg-muted/60 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-foreground")}
                aria-pressed={selected}
                data-decision-issue={issue.identifier}
                onClick={() => setSelectedIssueId(issue.id)}
              >
                <span className="flex items-center gap-2 text-caption text-muted-foreground">
                  <StatusIcon status={issue.status} category={issueStatusCategory(issue) ?? undefined} color={statusColorOf(issue.status)} icon={statusIconOf(issue.status)} className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="font-mono">{issue.identifier}</span>
                </span>
                <span className="mt-1 line-clamp-2 block text-label font-medium">{issue.title}</span>
                <span className="mt-1 block truncate text-caption text-muted-foreground">
                  {timeline?.loading ? t(($) => $.decisions.loading) : timeline?.error ? t(($) => $.errors.timeline) : t(($) => $.decisions.blockedHint)}
                </span>
              </button>
            );
          })}
          {reviewStage !== null ? (
            <button type="button" className={cn("block w-full border-b px-3 py-3 text-left hover:bg-muted/50", showReview && "bg-muted/60")} onClick={() => setSelectedIssueId("review")} data-review-todo>
              <span className="flex items-center gap-2 text-caption text-muted-foreground"><CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />{t(($) => $.stage.label, { number: reviewStage })}</span>
              <span className="mt-1 block text-label font-medium">{t(($) => $.decisions.reviewPending, { stage: reviewStage })}</span>
              <span className="mt-1 block text-caption text-muted-foreground">{t(($) => $.decisions.reviewHint)}</span>
            </button>
          ) : null}
        </div>
      </div>
      {selectedIssue ? (
        <EngineeringDecisionDetail
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          issue={selectedIssue}
          timeline={timelines[selectedIssue.id] ?? { comment: null, loading: true, error: false }}
          onSubmitted={onSubmitted}
        />
      ) : showReview ? (
        <div className="flex min-h-0 flex-col items-center justify-center gap-4 p-6 text-center">
          <CheckCircle2 className="size-8 text-success" aria-hidden="true" />
          <div><h2 className="font-medium">{t(($) => $.decisions.reviewPending, { stage: reviewStage })}</h2><p className="mt-1 text-body text-muted-foreground">{t(($) => $.decisions.reviewHint)}</p></div>
          <Button onClick={onReview}>{t(($) => $.stage.reviewAction, { stage: reviewStage })}</Button>
        </div>
      ) : null}
    </section>
  );
}
