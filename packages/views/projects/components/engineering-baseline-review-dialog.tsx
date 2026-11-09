import { useMemo, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle } from "@multica/ui/icons";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { errorCode, type BaselineAnnotationBatch, type BaselineAnnotationDetail, type BaselineChapter, type BaselineRevision } from "@multica/core/api";
import { paths } from "@multica/core/paths";
import { createSafeId } from "@multica/core/utils";
import type { BaselineAnnotationDraftItem } from "@multica/core/projects/baseline-annotation-draft-store";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import {
  activeBaselineBatch,
  baselineReviewRoute,
  isBaselineAnnotationReply,
  isBatchRelatedToCandidate,
  synthesizeBaselineReviewAnnotation,
  toBaselineReviewAnnotation,
  type BaselineAnnotationActions,
  type BaselineReviewOutcome,
} from "./engineering-baseline-annotation-model";

interface BaselineReviewDialogProps {
  workspaceSlug: string;
  chapter: BaselineChapter;
  remainingCount: number;
  candidateMode: boolean;
  candidate: BaselineRevision | null;
  sourceIssueIdentifier?: string;
  chapterCandidate: BaselineRevision | null;
  adopted: BaselineRevision | null;
  batches: readonly BaselineAnnotationBatch[];
  details: readonly BaselineAnnotationDetail[];
  pendingItems: readonly BaselineAnnotationDraftItem[];
  initialOutcome: BaselineReviewOutcome | null;
  actions: BaselineAnnotationActions;
  onDecision: (action: "adopt" | "reject", revision: BaselineRevision, annotationBatchAction?: "close" | "keep") => Promise<boolean>;
  onClearPending: (ids: ReadonlySet<string>) => void;
  onReviewCandidate: () => void;
  onClose: () => void;
}

export function BaselineReviewDialog(props: BaselineReviewDialogProps) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const [outcome, setOutcome] = useState<BaselineReviewOutcome | null>(props.initialOutcome ?? (props.pendingItems.length ? "changes" : null));
  const [summary, setSummary] = useState("");
  const [agentId, setAgentId] = useState(props.actions.agents[0]?.id ?? "");
  const [batchAction, setBatchAction] = useState<"close" | "keep">("close");
  const [step, setStep] = useState<"form" | "discard" | "closeBatch">("form");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientKeyRef = useRef(createSafeId());
  const activeBatch = activeBaselineBatch(props.batches, props.chapter);
  const candidate = props.candidate;
  const relatedBatch = activeBatch && candidate && isBatchRelatedToCandidate(activeBatch, candidate, props.details) ? activeBatch : null;
  const route = baselineReviewRoute({
    candidateMode: props.candidateMode,
    candidate,
    chapterHasCandidate: !!props.chapterCandidate,
    activeBatch,
    details: props.details,
  });
  const pendingCount = props.pendingItems.length;
  // The server requires an annotation. A required overall note becomes a
  // chapter-level annotation when the reviewer did not add inline drafts.
  const canRequestChanges = route !== "conflict" && route !== "candidate_open";
  const needsAgent = route === "new";
  const selectedAgent = props.actions.agents.find((agent) => agent.id === agentId);
  const routeAgentName = route === "append" && activeBatch
    ? getActorName("agent", activeBatch.agentId)
    : route === "source" && candidate
      ? getActorName("agent", candidate.createdById)
      : selectedAgent?.name ?? "";
  const sourceIdentifier = props.sourceIssueIdentifier ?? candidate?.sourceIssueId ?? "";
  const submitLabel = outcome === "adopt"
    ? t(($) => $.actions.adopt)
    : outcome === "reject"
      ? t(($) => $.actions.reject)
      : t(($) => props.candidateMode
        ? props.remainingCount > 1 ? $.annotations.submitAndNext : $.annotations.submit
        : $.annotations.requestChanges);
  const targetTitle = props.candidateMode && candidate
    ? t(($) => $.baseline.compareMode, { number: candidate.revisionNumber })
    : t(($) => $.baseline.baseMode, { number: props.adopted?.revisionNumber ?? 0 });
  const routeText = useMemo(() => {
    if (route === "append" && activeBatch) return t(($) => $.annotations.routeAppend, { identifier: activeBatch.carrier.identifier || activeBatch.id, agent: routeAgentName });
    if (route === "source" && candidate) return t(($) => $.annotations.routeSource, { identifier: sourceIdentifier, agent: routeAgentName });
    if (route === "new") return t(($) => $.annotations.routeNew);
    return "";
  }, [route, activeBatch, candidate, sourceIdentifier, routeAgentName, t]);

  const clearSubmittedItems = (items: readonly BaselineAnnotationDraftItem[]) => {
    props.onClearPending(new Set(items.map((item) => item.id)));
  };

  const submit = async () => {
    if (submitting || !outcome) return;
    setError(null);
    if ((outcome === "adopt" || outcome === "reject") && pendingCount && step === "form") {
      setStep("discard");
      return;
    }
    const submittedItems = [...props.pendingItems];
    setSubmitting(true);
    try {
      if (outcome === "changes") {
        const reviewedRevision = props.candidateMode ? candidate : props.adopted;
        const reviewedRevisionId = reviewedRevision?.id;
        const note = summary.trim();
        if (!reviewedRevision || !reviewedRevisionId || !canRequestChanges || (props.candidateMode && !note) || (needsAgent && !agentId)) throw new Error("Incomplete review");
        const synthesized = submittedItems.length ? null : synthesizeBaselineReviewAnnotation(reviewedRevision, note);
        if (!submittedItems.length && (!note || !synthesized)) throw new Error("No valid annotation section");
        const annotations = submittedItems.length
          ? submittedItems.map(toBaselineReviewAnnotation)
          : [synthesized!];
        const result = await props.actions.onSubmitReview({
          clientKey: clientKeyRef.current,
          chapter: reviewedRevision.chapter,
          reviewedRevisionId,
          ...(needsAgent ? { assignee: { type: "agent" as const, id: agentId } } : {}),
          summary: note,
          annotations,
        });
        if (!result) throw new Error("Invalid review response");
      } else {
        if (!candidate) throw new Error("Missing candidate");
        const success = await (relatedBatch
          ? props.onDecision(outcome, candidate, batchAction)
          : props.onDecision(outcome, candidate));
        if (!success) throw new Error("Decision failed");
      }
      clearSubmittedItems(submittedItems);
      props.onClose();
    } catch (cause) {
      setError(errorCode(cause) ?? "review_failed");
    } finally {
      setSubmitting(false);
    }
  };

  const closeBatch = async () => {
    if (!activeBatch || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await props.actions.onCloseBatch(activeBatch.id);
      if (!result) throw new Error("Invalid close response");
      props.onClose();
    } catch {
      setError("close_failed");
    } finally {
      setSubmitting(false);
    }
  };

  const reviewCandidate = () => {
    props.onReviewCandidate();
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) props.onClose(); }}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{step === "discard" ? t(($) => $.annotations.discardTitle, { count: pendingCount }) : step === "closeBatch" ? t(($) => $.annotations.closeBatchTitle) : t(($) => $.annotations.finishReview)}</DialogTitle>
          <DialogDescription>{step === "discard" ? t(($) => $.annotations.discardDescription) : step === "closeBatch" ? t(($) => $.annotations.closeBatchDescription) : targetTitle}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-1">
          {step === "discard" ? (
            <PendingReviewList items={props.pendingItems} />
          ) : step === "closeBatch" ? (
            <p className="text-body text-muted-foreground">{t(($) => $.annotations.closeBatchWarning)}</p>
          ) : (
            <>
              {pendingCount ? <PendingReviewList items={props.pendingItems} /> : null}
              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label htmlFor="baseline-review-summary" className="text-caption font-medium">{t(($) => props.candidateMode && outcome === "changes" ? $.annotations.summaryRequired : $.annotations.summaryLabel)}</label>
                  <span className="text-micro text-muted-foreground">{Array.from(summary).length}/500</span>
                </div>
                <Textarea id="baseline-review-summary" value={summary} maxLength={500} rows={3} disabled={submitting} required={props.candidateMode && outcome === "changes"} onChange={(event) => setSummary(event.target.value)} />
              </div>
              {props.candidateMode ? (
                <fieldset className="space-y-2" disabled={submitting}>
                  <legend className="sr-only">{t(($) => $.annotations.reviewOutcome)}</legend>
                  <ReviewOption value="changes" selected={outcome} onChange={setOutcome} disabled={!canRequestChanges} title={t(($) => $.annotations.requestChanges)} description={routeText || t(($) => $.annotations.routeUnavailable)} />
                  <ReviewOption value="adopt" selected={outcome} onChange={setOutcome} title={t(($) => $.actions.adopt)} description={t(($) => $.annotations.adoptDescription)} />
                  <ReviewOption value="reject" selected={outcome} onChange={setOutcome} title={t(($) => $.actions.reject)} description={t(($) => $.annotations.rejectDescription)} />
                </fieldset>
              ) : <p className="rounded-md border bg-muted p-3 text-caption">{routeText}</p>}
              {outcome === "changes" && needsAgent ? (
                <label className="block text-caption font-medium">
                  {t(($) => $.annotations.assignAgent)}
                  <select className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-body" aria-label={t(($) => $.annotations.assignAgent)} value={agentId} disabled={submitting} onChange={(event) => setAgentId(event.target.value)}>
                    {props.actions.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                  {!props.actions.agents.length ? <span className="mt-1 block font-normal text-destructive">{t(($) => $.annotations.noAgents)}</span> : null}
                </label>
              ) : null}
              {(outcome === "adopt" || outcome === "reject") && relatedBatch ? (
                <label className="block text-caption font-medium">
                  {t(($) => $.annotations.batchAction, { identifier: relatedBatch.carrier.identifier || relatedBatch.id })}
                  <select className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-body" value={batchAction} disabled={submitting} onChange={(event) => setBatchAction(event.target.value as "close" | "keep")}>
                    <option value="close">{t(($) => $.annotations.closeRelatedBatch)}</option>
                    <option value="keep">{t(($) => $.annotations.keepBatch)}</option>
                  </select>
                </label>
              ) : null}
              {route === "conflict" && activeBatch ? (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>{t(($) => $.annotations.conflictTitle)}</AlertTitle>
                  <AlertDescription>
                    <p>{t(($) => $.annotations.conflictDescription)}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {activeBatch.issueId ? <AppLink className="underline" href={paths.workspace(props.workspaceSlug).issueDetail(activeBatch.issueId)}>{activeBatch.carrier.identifier || t(($) => $.annotations.carrierIssue)}</AppLink> : null}
                      {candidate?.sourceIssueId ? <AppLink className="underline" href={paths.workspace(props.workspaceSlug).issueDetail(candidate.sourceIssueId)}>{sourceIdentifier || t(($) => $.baseline.sourceIssue)}</AppLink> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" size="xs" variant="outline" onClick={() => setOutcome("reject")}>{t(($) => $.annotations.rejectCandidate)}</Button>
                      <Button type="button" size="xs" variant="outline" onClick={() => setStep("closeBatch")}>{t(($) => $.annotations.closeBatch)}</Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {route === "candidate_open" ? (
                <Alert>
                  <AlertTriangle />
                  <AlertTitle>{t(($) => $.annotations.candidateOpenTitle)}</AlertTitle>
                  <AlertDescription>
                    <p>{t(($) => $.annotations.candidateOpenDescription)}</p>
                    <Button type="button" size="xs" variant="outline" className="mt-2" onClick={reviewCandidate}>{t(($) => $.annotations.reviewCandidate)}</Button>
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          )}
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertTriangle />
              <AlertTitle>{t(($) => error === "close_failed" ? $.annotations.closeBatchError : $.annotations.submitError)}</AlertTitle>
              <AlertDescription>
                <p>{t(($) => error === "baseline_review_conflict" ? $.annotations.conflictDescription : error === "baseline_candidate_open" ? $.annotations.candidateOpenDescription : $.annotations.submitErrorDescription)}</p>
                {error === "baseline_candidate_open" ? <Button type="button" size="xs" variant="outline" className="mt-2" onClick={reviewCandidate}>{t(($) => $.annotations.reviewCandidate)}</Button> : null}
                {error === "baseline_review_conflict" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {candidate?.sourceIssueId ? <AppLink className="underline" href={paths.workspace(props.workspaceSlug).issueDetail(candidate.sourceIssueId)}>{sourceIdentifier}</AppLink> : null}
                    <Button type="button" size="xs" variant="outline" onClick={() => { setOutcome("reject"); setError(null); }}>{t(($) => $.annotations.rejectCandidate)}</Button>
                    {activeBatch ? <Button type="button" size="xs" variant="outline" onClick={() => setStep("closeBatch")}>{t(($) => $.annotations.closeBatch)}</Button> : null}
                  </div>
                ) : null}
                {error !== "baseline_review_conflict" && error !== "baseline_candidate_open" ? <Button type="button" size="xs" variant="outline" className="mt-2" disabled={submitting} onClick={() => void (error === "close_failed" ? closeBatch() : submit())}>{t(($) => $.actions.retry)}</Button> : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter className="shrink-0">
          {step === "form" ? (
            <>
              <Button type="button" variant="outline" disabled={submitting} onClick={props.onClose}>{t(($) => $.actions.cancel)}</Button>
              <Button type="button" disabled={submitting || !outcome || (outcome === "changes" && ((props.candidateMode && !summary.trim()) || !canRequestChanges || (needsAgent && !agentId)))} aria-busy={submitting} onClick={() => void submit()}>
                {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{submitLabel}
              </Button>
            </>
          ) : step === "discard" ? (
            <>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => setStep("form")}>{t(($) => $.annotations.back)}</Button>
              <Button type="button" variant="destructive" disabled={submitting} aria-busy={submitting} onClick={() => void submit()}>{t(($) => outcome === "adopt" ? $.annotations.discardAndAdopt : $.annotations.discardAndReject)}</Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => setStep("form")}>{t(($) => $.annotations.back)}</Button>
              <Button type="button" variant="destructive" disabled={submitting} aria-busy={submitting} onClick={() => void closeBatch()}>{t(($) => $.annotations.closeBatch)}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewOption({ value, selected, onChange, disabled, title, description }: {
  value: BaselineReviewOutcome;
  selected: BaselineReviewOutcome | null;
  onChange: (value: BaselineReviewOutcome) => void;
  disabled?: boolean;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-brand has-checked:bg-brand/5 has-disabled:cursor-not-allowed has-disabled:opacity-50">
      <input type="radio" className="mt-1" name="baseline-review-outcome" value={value} checked={selected === value} disabled={disabled} onChange={() => onChange(value)} />
      <span><span className="block text-body font-medium">{title}</span><span className="mt-0.5 block text-caption text-muted-foreground">{description}</span></span>
    </label>
  );
}

function PendingReviewList({ items }: { items: readonly BaselineAnnotationDraftItem[] }) {
  const { t } = useT("engineering");
  return (
    <details className="rounded-lg border" open={items.length <= 3}>
      <summary className="cursor-pointer px-3 py-2 text-caption font-medium">{t(($) => $.annotations.pendingItems, { count: items.length })}</summary>
      <ul className="max-h-48 space-y-2 overflow-y-auto border-t p-3">
        {items.map((item) => (
          <li key={item.id} className="text-caption">
            <div className="flex items-center gap-2"><Badge variant="outline">{isBaselineAnnotationReply(item) ? t(($) => $.annotations.reply) : item.sectionTitle}</Badge><span className="text-muted-foreground">{item.anchorKind === "lines" ? `${item.lineStart}${item.lineEnd !== item.lineStart ? `–${item.lineEnd}` : ""}` : ""}</span></div>
            <p className="mt-1 break-words">{item.note}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
