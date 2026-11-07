import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, LoaderCircle } from "@multica/ui/icons";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import type { BaselineAnnotationBatch, BaselineDecision, BaselineRevision, OpenIssue } from "@multica/core/api";
import { paths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { useStatusLabel } from "../../issues/utils/status-label";
import { useEngineeringChapterLabel, useFormatRelativeDate } from "./labels";
import type { BaselineChapter, ChapterState } from "@multica/core/api";
import type { BaselineReviewOutcome } from "./engineering-baseline-annotation-model";

export type BaselineReviewMode = "base" | "compare";
export type BaselineCompareView = "source" | "render";

interface ReviewBarProps {
  workspaceSlug: string;
  workspaceId: string;
  chapters: readonly ChapterState[];
  chapter: BaselineChapter;
  revision: BaselineRevision | null;
  adopted: BaselineRevision | null;
  currentCandidate: boolean;
  canDecide: boolean;
  decisionPending: boolean;
  decisionResult: BaselineDecision | null;
  mode: BaselineReviewMode;
  compareView: BaselineCompareView;
  changeCount: number;
  changedCount: number;
  changeCursor: number;
  pendingCount: number;
  activeBatch: BaselineAnnotationBatch | null;
  sourceIssueIdentifier?: string;
  annotationCount: number;
  annotationsVisible: boolean;
  onAnnotationsVisibleChange: (visible: boolean) => void;
  onModeChange: (mode: BaselineReviewMode) => void;
  onCompareViewChange: (view: BaselineCompareView) => void;
  onJumpChange: (index: number) => void;
  onOpenReview: (outcome: BaselineReviewOutcome | null, candidateMode: boolean) => void;
  onOpenBatch: () => void;
}

export function BaselineReviewBar(props: ReviewBarProps) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const chapterLabel = useEngineeringChapterLabel(props.chapters);
  const { revision, activeBatch } = props;
  const show = revision || props.pendingCount > 0 || activeBatch || !props.canDecide || (props.mode === "base" && props.adopted);
  if (!show) return null;
  return (
    <section className="sticky top-0 z-20 mt-5 border-y bg-background py-3" aria-label={t(($) => $.baseline.reviewLabel)} data-baseline-revision-status={revision?.status}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="min-w-60 flex-1">
          {revision ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="font-medium">{t(($) => $.baseline.revisionWaiting, { number: revision.revisionNumber })}</h2>
                <span className="text-caption text-muted-foreground">{getActorName(revision.createdByType, revision.createdById)} · <time dateTime={revision.createdAt}>{formatRelativeDate(revision.createdAt)}</time> · {t(($) => $.baseline.changeCount, { count: props.changeCount })}</span>
                <Badge variant={revision.status === "candidate" ? "default" : "secondary"}>{t(($) => $.status[revision.status] ?? $.status.unknown)}</Badge>
              </div>
              <p className="mt-1 text-body text-muted-foreground">{revision.changeSummary || t(($) => $.recent.noSummary)}</p>
              {revision.sourceIssueId ? <AppLink className="mt-1 inline-block text-caption underline underline-offset-2" href={paths.workspace(props.workspaceSlug).issueDetail(revision.sourceIssueId)}>{props.sourceIssueIdentifier ?? t(($) => $.baseline.sourceIssue)}</AppLink> : null}
            </>
          ) : (
            <div>
              <h2 className="font-medium">{t(($) => $.baseline.baseMode, { number: props.adopted?.revisionNumber ?? 0 })}</h2>
              <p className="mt-1 text-caption text-muted-foreground">{chapterLabel(props.chapter)}</p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {props.mode === "base" && props.adopted ? (
            <Button type="button" role="switch" aria-checked={props.annotationsVisible} variant="ghost" size="sm" onClick={() => props.onAnnotationsVisibleChange(!props.annotationsVisible)}>
              {t(($) => $.annotations.showAnnotations, { count: props.annotationCount })}
            </Button>
          ) : null}
          {revision ? (
            <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.baseline.reviewModeLabel)}>
              <button type="button" role="tab" aria-selected={props.mode === "base"} className={cn("rounded-sm px-3 py-1 text-caption", props.mode === "base" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => props.onModeChange("base")}>{t(($) => $.baseline.baseMode, { number: props.adopted?.revisionNumber ?? 0 })}</button>
              <button type="button" role="tab" aria-selected={props.mode === "compare"} className={cn("rounded-sm px-3 py-1 text-caption", props.mode === "compare" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => props.onModeChange("compare")}>{t(($) => $.baseline.compareMode, { number: revision.revisionNumber })}</button>
            </div>
          ) : null}
          {revision && props.mode === "compare" ? (
            <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.annotations.compareViewLabel)}>
              <button type="button" role="tab" aria-selected={props.compareView === "source"} className={cn("rounded-sm px-3 py-1 text-caption", props.compareView === "source" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => props.onCompareViewChange("source")}>{t(($) => $.annotations.sourceDiff)}</button>
              <button type="button" role="tab" aria-selected={props.compareView === "render"} className={cn("rounded-sm px-3 py-1 text-caption", props.compareView === "render" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => props.onCompareViewChange("render")}>{t(($) => $.annotations.renderedView)}</button>
            </div>
          ) : null}
          {revision && props.mode === "compare" && props.compareView === "render" && props.changedCount ? (
            <div className="flex items-center gap-1 text-caption">
              <Button variant="outline" size="icon-sm" aria-label={t(($) => $.baseline.previousChange)} onClick={() => props.onJumpChange(props.changeCursor - 1)}><ChevronUp aria-hidden="true" /></Button>
              <span className="min-w-10 text-center tabular-nums" data-change-cursor>{props.changeCursor + 1}/{props.changedCount}</span>
              <Button variant="outline" size="icon-sm" aria-label={t(($) => $.baseline.nextChange)} onClick={() => props.onJumpChange(props.changeCursor + 1)}><ChevronDown aria-hidden="true" /></Button>
            </div>
          ) : null}
          {props.canDecide && props.pendingCount > 0 ? <Badge variant="secondary">{t(($) => $.annotations.reviewingPending, { count: props.pendingCount })}</Badge> : null}
          {props.canDecide && ((props.pendingCount > 0 && (props.mode === "base" || props.currentCandidate)) || (revision && props.currentCandidate && props.mode === "compare")) ? <Button type="button" size="sm" variant={props.pendingCount ? "default" : "outline"} onClick={() => props.onOpenReview(props.pendingCount ? "changes" : null, !!revision && props.mode === "compare")}>{t(($) => $.annotations.finishReview)}</Button> : null}
          {revision && props.currentCandidate && props.canDecide ? (
            <>
              <Button variant="outline" size="sm" disabled={props.decisionPending} onClick={() => props.onOpenReview("reject", true)}>{t(($) => $.actions.reject)}</Button>
              <Button size="sm" disabled={props.decisionPending} onClick={() => props.onOpenReview("adopt", true)}>{t(($) => $.actions.adopt)}</Button>
            </>
          ) : null}
        </div>
      </div>
      {activeBatch ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
          <Button type="button" size="xs" variant="ghost" className="px-0" onClick={props.onOpenBatch}>{t(($) => $.annotations.activeBatch, { identifier: activeBatch.carrier.identifier || activeBatch.id })}</Button>
          <span>{t(($) => $.annotations.batchCounts, { open: activeBatch.counts.open, resolved: activeBatch.counts.resolved })}</span>
        </div>
      ) : null}
      {!props.canDecide ? <div className="mt-2 text-caption text-muted-foreground">{t(($) => $.annotations.readOnlyMember)}</div> : null}
      {revision && !props.currentCandidate ? <div className="mt-2 text-caption text-muted-foreground">{t(($) => $.baseline.readOnlyRevision)}</div> : null}
      {revision && props.mode === "compare" && !props.changedCount ? <div className="mt-2 text-caption text-muted-foreground">{t(($) => $.baseline.noChanges)}</div> : null}
      {props.decisionResult ? <DecisionOpenIssues result={props.decisionResult} workspaceId={props.workspaceId} /> : null}
    </section>
  );
}

export function BaselineBatchDialog({ batch, workspaceSlug, canDecide, onCloseBatch, onClose }: {
  batch: BaselineAnnotationBatch;
  workspaceSlug: string;
  canDecide: boolean;
  onCloseBatch: (batchId: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const close = async () => {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      const result = await onCloseBatch(batch.id);
      if (!result) throw new Error("Invalid close response");
      onClose();
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirming ? t(($) => $.annotations.closeBatchTitle) : t(($) => $.annotations.batchDetails)}</DialogTitle>
          <DialogDescription>{confirming ? t(($) => $.annotations.closeBatchDescription) : batch.carrier.identifier || batch.id}</DialogDescription>
        </DialogHeader>
        {confirming ? <p className="text-body text-muted-foreground">{t(($) => $.annotations.closeBatchWarning)}</p> : (
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 text-body">
            <dt className="text-muted-foreground">{t(($) => $.annotations.carrierIssue)}</dt>
            <dd>{batch.issueId ? <AppLink className="font-mono underline" href={paths.workspace(workspaceSlug).issueDetail(batch.issueId)}>{batch.carrier.identifier || batch.issueId}</AppLink> : "—"}</dd>
            <dt className="text-muted-foreground">{t(($) => $.annotations.responsibleAgent)}</dt>
            <dd>{getActorName("agent", batch.agentId)}</dd>
            <dt className="text-muted-foreground">{t(($) => $.annotations.annotationsLabel)}</dt>
            <dd>{t(($) => $.annotations.batchCounts, { open: batch.counts.open, resolved: batch.counts.resolved })}</dd>
          </dl>
        )}
        {error ? <Alert variant="destructive"><AlertTriangle /><AlertDescription>{t(($) => $.annotations.closeBatchError)}</AlertDescription></Alert> : null}
        <DialogFooter>
          {confirming ? <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>{t(($) => $.annotations.back)}</Button> : <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t(($) => $.actions.close)}</Button>}
          {canDecide ? <Button type="button" variant="destructive" disabled={pending} aria-busy={pending} onClick={() => confirming ? void close() : setConfirming(true)}>{pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.annotations.closeBatch)}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpenIssueGroup({ title, issues, workspaceId }: { title: string; issues: readonly OpenIssue[]; workspaceId: string }) {
  const statusLabel = useStatusLabel(workspaceId);
  return (
    <div>
      <h4 className="mb-1 text-caption font-medium">{title}</h4>
      {issues.length ? <ul className="space-y-1 text-caption">{issues.map((issue) => <li key={issue.id} className="flex gap-2"><span className="text-muted-foreground">{issue.identifier}</span><span className="min-w-0 flex-1">{issue.title}</span><span className="text-muted-foreground">{statusLabel(issue.status)}</span></li>)}</ul> : <span className="text-caption text-muted-foreground">—</span>}
    </div>
  );
}

function DecisionOpenIssues({ result, workspaceId }: { result: BaselineDecision; workspaceId: string }) {
  const { t } = useT("engineering");
  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-success/5 p-3" data-open-issues>
      <div className="flex items-center gap-2 text-caption font-medium text-success"><CheckCircle2 className="size-4" aria-hidden="true" />{t(($) => $.baseline.openIssuesTitle)}</div>
      <OpenIssueGroup title={t(($) => $.baseline.inFlight)} issues={result.openIssues.inFlight} workspaceId={workspaceId} />
      <OpenIssueGroup title={t(($) => $.baseline.queued)} issues={result.openIssues.queued} workspaceId={workspaceId} />
      {result.openIssues.truncated ? <div className="text-caption text-muted-foreground">{t(($) => $.baseline.openIssuesTruncated)}</div> : null}
    </div>
  );
}
