import { useEffect, useMemo } from "react";
import { AlertTriangle, ArrowLeft, ChevronRight } from "@multica/ui/icons";
import { Alert, AlertDescription, AlertTitle } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@multica/ui/components/ui/card";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import type { BaselineRevision, ChapterState } from "@multica/core/api";
import { useT } from "../../i18n";
import { useEngineeringChapterLabel, useFormatRelativeDate } from "./labels";
import { BaselineSourceDiff, baselineSourceDisplaySections } from "./engineering-baseline-source-diff";

export type BaselineProcessedDecision = "adopted" | "rejected" | "changes";

export interface BaselineProcessedRecord {
  key: string;
  revision: BaselineRevision;
  decision: BaselineProcessedDecision;
  decidedAt: string;
  summary?: string;
  sourceLabel?: string;
}

export interface BaselineProcessedRecordsProps {
  chapters: readonly ChapterState[];
  records: readonly BaselineProcessedRecord[];
  selectedRecord: BaselineProcessedRecord | null;
  detailRevision: BaselineRevision | null;
  baseRevision: BaselineRevision | null;
  loading: boolean;
  error: boolean;
  detailLoading: boolean;
  detailError: boolean;
  onSelect: (record: BaselineProcessedRecord) => void;
  onBack: () => void;
  onRetry: () => void;
}

const ignorePendingChange = () => undefined;
const disallowAnnotation = () => false;
const ignoreResolve = async () => false;

export function BaselineProcessedRecords(props: BaselineProcessedRecordsProps) {
  const { t } = useT("engineering");
  const chapterLabel = useEngineeringChapterLabel(props.chapters);
  const formatRelativeDate = useFormatRelativeDate();
  const selectedRecord = props.selectedRecord;
  const onBack = props.onBack;
  const revision = selectedRecord ? props.detailRevision ?? selectedRecord.revision : null;
  const beforeContent = props.baseRevision?.contentMarkdown ?? "";
  const afterContent = revision?.contentMarkdown ?? "";
  const sections = useMemo(
    () => revision ? baselineSourceDisplaySections(revision.chapter, beforeContent, afterContent) : [],
    [revision, beforeContent, afterContent],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      onBack();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const decisionBadge = (decision: BaselineProcessedDecision) => {
    if (decision === "adopted") {
      return <Badge variant="secondary" className="bg-success/10 text-success">{t(($) => $.processed.adopted)}</Badge>;
    }
    if (decision === "rejected") {
      return <Badge variant="destructive">{t(($) => $.processed.rejected)}</Badge>;
    }
    return <Badge variant="secondary" className="bg-warning/10 text-warning">{t(($) => $.processed.changes)}</Badge>;
  };

  if (!selectedRecord) {
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label={t(($) => $.processed.title)} data-engineering-region="processed-records">
        <header className="shrink-0 border-b px-4 py-4 md:px-6">
          <Button type="button" size="sm" variant="ghost" className="-ml-2" onClick={props.onBack}>
            <ArrowLeft aria-hidden="true" />{t(($) => $.processed.backToSource)}
          </Button>
          <h1 className="mt-2 text-title-lg font-semibold">{t(($) => $.processed.title)}</h1>
          <p className="mt-1 text-body text-muted-foreground">{t(($) => $.processed.description)}</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {props.loading ? (
            <div className="space-y-3" role="status">
              <span className="sr-only">{t(($) => $.processed.loading)}</span>
              {[0, 1, 2].map((item) => (
                <div key={item} className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-4">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-5 w-20" />
                  </div>
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </div>
          ) : props.error ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>{t(($) => $.processed.errorTitle)}</AlertTitle>
              <AlertDescription>
                <p>{t(($) => $.processed.errorDescription)}</p>
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={props.onRetry}>
                  {t(($) => $.processed.retry)}
                </Button>
              </AlertDescription>
            </Alert>
          ) : props.records.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
              <h2 className="font-medium">{t(($) => $.processed.emptyTitle)}</h2>
              <p className="mt-1 max-w-md text-body text-muted-foreground">{t(($) => $.processed.emptyDescription)}</p>
            </div>
          ) : (
            <ul className="divide-y rounded-lg border">
              {props.records.map((record) => {
                const source = record.sourceLabel || record.revision.sourceIssueId;
                return (
                  <li key={record.key}>
                    <button
                      type="button"
                      className="group flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                      onClick={() => props.onSelect(record)}
                      data-processed-record={record.key}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <span className="font-medium">
                            {chapterLabel(record.revision.chapter)} · {t(($) => $.processed.revision, { number: record.revision.revisionNumber })}
                          </span>
                          {decisionBadge(record.decision)}
                          <time className="text-caption text-muted-foreground" dateTime={record.decidedAt} title={record.decidedAt}>
                            {formatRelativeDate(record.decidedAt)}
                          </time>
                        </span>
                        {source ? <span className="mt-1 block text-caption text-muted-foreground">{source}</span> : null}
                        <span className="mt-2 block text-body">{record.revision.changeSummary || t(($) => $.processed.noSummary)}</span>
                        {record.decision === "changes" && record.summary ? (
                          <span className="mt-2 block rounded-md bg-warning/10 px-3 py-2 text-body text-warning">
                            <span className="mr-2 font-medium">{t(($) => $.processed.requestChanges)}</span>
                            {record.summary}
                          </span>
                        ) : null}
                      </span>
                      <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label={t(($) => $.processed.title)} data-engineering-region="processed-record-detail">
      <header className="shrink-0 border-b px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" className="-ml-2" onClick={props.onBack}>
            <ArrowLeft aria-hidden="true" />
            {t(($) => $.processed.back)}
          </Button>
          <Badge variant="outline">{t(($) => $.processed.readOnly)}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-title-lg font-semibold">
            {chapterLabel(selectedRecord.revision.chapter)} · {t(($) => $.processed.revision, { number: selectedRecord.revision.revisionNumber })}
          </h1>
          {decisionBadge(selectedRecord.decision)}
          <time className="text-caption text-muted-foreground" dateTime={selectedRecord.decidedAt} title={selectedRecord.decidedAt}>
            {formatRelativeDate(selectedRecord.decidedAt)}
          </time>
        </div>
        <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.processed.cannotDecideAgain)}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {selectedRecord.decision === "changes" ? (
          <Card size="sm" className="mb-5 border-warning/40 bg-warning/5">
            <CardHeader>
              <CardTitle>{t(($) => $.processed.requestChanges)}</CardTitle>
            </CardHeader>
            <CardContent className="whitespace-pre-wrap text-body">
              {selectedRecord.summary || t(($) => $.processed.noReviewComment)}
            </CardContent>
          </Card>
        ) : null}
        {props.detailLoading ? (
          <div className="space-y-4" role="status">
            <span className="sr-only">{t(($) => $.processed.detailLoading)}</span>
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : props.detailError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t(($) => $.processed.detailErrorTitle)}</AlertTitle>
            <AlertDescription>
              <p>{t(($) => $.processed.detailErrorDescription)}</p>
              <Button type="button" size="sm" variant="outline" className="mt-2" onClick={props.onRetry}>
                {t(($) => $.processed.retry)}
              </Button>
            </AlertDescription>
          </Alert>
        ) : revision ? (
          <BaselineSourceDiff
            chapter={revision.chapter}
            sections={sections}
            beforeContent={beforeContent}
            afterContent={afterContent}
            candidate={revision}
            adopted={props.baseRevision}
            threads={[]}
            pendingItems={[]}
            canDecide={false}
            limitReached
            onUpdatePending={ignorePendingChange}
            onDeletePending={ignorePendingChange}
            onResolve={ignoreResolve}
            onAddReply={disallowAnnotation}
            onAddAnnotation={disallowAnnotation}
          />
        ) : null}
      </div>
    </section>
  );
}
