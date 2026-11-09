import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle } from "@multica/ui/icons";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { cn } from "@multica/ui/lib/utils";
import type { BaselineAnnotationBatch, BaselineChapter, BaselineRevision, ChapterState } from "@multica/core/api";
import { paths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { useEngineeringChapterLabel } from "./labels";

export type BaselineReviewMode = "base" | "compare";
export type BaselineCompareView = "source" | "render";
export type BaselineDecisionAction = "adopt" | "reject" | "changes";

export interface BaselineReviewBarProps {
  workspaceSlug: string;
  workspaceId: string;
  chapters: readonly ChapterState[];
  chapter: BaselineChapter;
  revision: BaselineRevision | null;
  adopted: BaselineRevision | null;
  currentCandidate: boolean;
  canDecide: boolean;
  decisionPending: boolean;
  mode: BaselineReviewMode;
  changeCount: number;
  activeBatch: BaselineAnnotationBatch | null;
  sourceIssueIdentifier?: string;
  onModeChange: (mode: BaselineReviewMode) => void;
  onOpenBatch: () => void;
  queue: readonly BaselineRevision[];
  batchIds: readonly string[];
  processedIds: ReadonlySet<string>;
  processedCount: number;
  returnLabel: string;
  decisionAction: BaselineDecisionAction | null;
  onReturn: () => void;
  onSelectCandidate: (id: string) => void;
  onOpenProcessed: () => void;
  onDecide: (action: BaselineDecisionAction) => void;
}

export function BaselineReviewBar(props: BaselineReviewBarProps) {
  const { t } = useT("engineering");
  const chapterLabel = useEngineeringChapterLabel(props.chapters);
  const [queueOpen, setQueueOpen] = useState(false);
  const { revision, queue, activeBatch } = props;
  const currentIndex = revision ? queue.findIndex((candidate) => candidate.id === revision.id) : -1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        props.onReturn();
        return;
      }
      if (!revision || !queue.length || (event.key !== "j" && event.key !== "J" && event.key !== "k" && event.key !== "K")) return;
      const index = queue.findIndex((candidate) => candidate.id === revision.id);
      const next = event.key === "j" || event.key === "J";
      const nextIndex = index < 0 ? (next ? 0 : queue.length - 1) : (index + (next ? 1 : -1) + queue.length) % queue.length;
      event.preventDefault();
      props.onSelectCandidate(queue[nextIndex]!.id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props, queue, revision]);

  if (!revision) return null;

  const progress = (
    <>
      {props.batchIds.map((id) => (
        <span
          key={id}
          className={cn(
            "h-full min-w-0 flex-1",
            props.processedIds.has(id) ? "bg-success" : id === revision.id ? "bg-brand" : "bg-muted",
          )}
        />
      ))}
    </>
  );

  return (
    <section className="@container z-20 mt-4 shrink-0 border-y bg-background" aria-label={t(($) => $.baseline.reviewLabel)} data-baseline-revision-status={revision.status}>
      {props.batchIds.length ? (
        activeBatch ? (
          <button
            type="button"
            className="flex h-[3px] w-full gap-0.5"
            aria-label={t(($) => $.annotations.activeBatch, { identifier: activeBatch.carrier.identifier || activeBatch.id })}
            onClick={props.onOpenBatch}
          >
            {progress}
          </button>
        ) : <div className="flex h-[3px] w-full gap-0.5">{progress}</div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={props.onReturn}>
          <ArrowLeft aria-hidden="true" />
          {props.returnLabel}
        </Button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t(($) => $.reviewQueue.previous)}
            disabled={queue.length < 2}
            onClick={() => {
              if (!queue.length) return;
              const index = currentIndex < 0 ? 0 : currentIndex;
              props.onSelectCandidate(queue[(index - 1 + queue.length) % queue.length]!.id);
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Popover open={queueOpen} onOpenChange={setQueueOpen}>
            <PopoverTrigger
              render={<Button type="button" variant="outline" size="sm" />}
              aria-label={t(($) => $.reviewQueue.label)}
            >
              <span className="tabular-nums">{currentIndex < 0 ? 0 : currentIndex + 1}/{queue.length}</span>
              <ChevronDown aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="start" className="min-w-[300px] gap-0 p-0">
              <ul className="max-h-80 overflow-y-auto p-1">
                {queue.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      aria-current={candidate.id === revision.id ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-left text-caption hover:bg-accent",
                        candidate.id === revision.id && "bg-muted",
                      )}
                      onClick={() => {
                        props.onSelectCandidate(candidate.id);
                        setQueueOpen(false);
                      }}
                    >
                      <span>{t(($) => $.baseline.compareMode, { number: candidate.revisionNumber })}</span>
                      <span className="shrink-0 text-muted-foreground">{t(($) => $.baseline.changeCount, { count: candidate.anchorsDiff.added.length + candidate.anchorsDiff.modified.length + candidate.anchorsDiff.removed.length })}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="border-t p-1">
                <button type="button" className="w-full rounded-sm px-2 py-1.5 text-left text-caption hover:bg-accent" onClick={() => {
                  props.onOpenProcessed();
                  setQueueOpen(false);
                }}>
                  {t(($) => $.reviewQueue.processedRecords, { count: props.processedCount })}
                </button>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t(($) => $.reviewQueue.next)}
            disabled={queue.length < 2}
            onClick={() => {
              if (!queue.length) return;
              const index = currentIndex < 0 ? -1 : currentIndex;
              props.onSelectCandidate(queue[(index + 1) % queue.length]!.id);
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <div className="@max-[720px]:hidden min-w-0 flex-1 items-baseline gap-2 px-2 flex">
          <h2 className="truncate font-medium">{chapterLabel(props.chapter)}</h2>
          <span className="shrink-0 text-caption text-muted-foreground">{t(($) => $.baseline.changeCount, { count: props.changeCount })}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.baseline.reviewModeLabel)}>
            <button type="button" role="tab" aria-selected={props.mode === "base"} className={cn("rounded-sm px-3 py-1 text-caption", props.mode === "base" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => props.onModeChange("base")}>
              {t(($) => $.baseline.baseMode, { number: props.adopted?.revisionNumber ?? 0 })}
            </button>
            <button type="button" role="tab" aria-selected={props.mode === "compare"} className={cn("rounded-sm px-3 py-1 text-caption", props.mode === "compare" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => props.onModeChange("compare")}>
              {t(($) => $.baseline.compareMode, { number: revision.revisionNumber })}
            </button>
          </div>
          {props.currentCandidate && props.canDecide ? (
            <>
              {(["reject", "changes", "adopt"] as const).map((action) => (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant={action === "adopt" ? "default" : "outline"}
                  disabled={props.decisionPending}
                  aria-busy={props.decisionAction === action}
                  onClick={() => props.onDecide(action)}
                >
                  {props.decisionAction === action ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
                  {action === "adopt" ? t(($) => $.actions.adopt) : action === "reject" ? t(($) => $.actions.reject) : t(($) => $.annotations.requestChanges)}
                </Button>
              ))}
            </>
          ) : null}
        </div>
      </div>
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
