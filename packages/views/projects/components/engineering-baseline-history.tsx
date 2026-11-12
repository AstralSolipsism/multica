"use client";

// History timeline + rich diff compare pane for one wiki page (OL-1329 §7).
// The center column swaps to this view; the left tree stays. Timeline on the
// left (304px), compare pane on the right with 渲染对比 / 此版本预览 tabs, a
// compare-base selector, 仅看变更 fold, and a rollback action (full snapshot
// default, content-only option).

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, LoaderCircle, RotateCcw } from "@multica/ui/icons";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Switch } from "@multica/ui/components/ui/switch";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { api, type WikiTreePage } from "@multica/core/api";
import { projectWikiRevisionOptions, projectKeys } from "@multica/core/projects/queries";
import { diffWikiStructure } from "@multica/core/projects/baseline-wiki-diff";
import { resolveWikiLinks, type WikiLinkIndex } from "@multica/core/projects/wikilink-resolution";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { wikiActivityKindKey } from "./engineering-utils";
import { useFormatRelativeDate } from "./labels";
import { WikiDiffLegend, WikiDiffSummary, WikiDiffView, WikiSourceDiff, WikiStructureBar } from "./engineering-baseline-diff";
import { WikiMarkdown, type WikiLinkTarget } from "./engineering-baseline-markdown";

type CompareBase = "previous" | "current" | `since:${number}`;

export interface WikiHistoryViewProps {
  wsId: string;
  projectId: string;
  page: WikiTreePage;
  /** Tree-backed resolver covering both selected revisions, not just the current read. */
  linkIndex: WikiLinkIndex;
  onNavigate: (target: WikiLinkTarget) => void;
  saving: boolean;
  onRollback: (input: { revisionNumber: number; baseRevisionNumber: number; contentOnly: boolean }) => Promise<boolean>;
  onBack: () => void;
}

export function WikiHistoryView(props: WikiHistoryViewProps) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const [selected, setSelected] = useState<number>(props.page.currentRevisionNumber);
  const [tab, setTab] = useState<"rendered" | "preview">("rendered");
  const [compareBase, setCompareBase] = useState<CompareBase>("previous");
  const [changesOnly, setChangesOnly] = useState(true);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [contentOnly, setContentOnly] = useState(false);

  const historyQuery = useInfiniteQuery({
    queryKey: [...projectKeys.wikiHistoryAll(props.wsId, props.projectId, props.page.slug), "infinite"],
    queryFn: ({ pageParam }) => api.getProjectWikiPageHistory(props.wsId, props.projectId, props.page.slug, { limit: 50, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage?.hasMore ? lastPage.nextBefore : undefined,
  });
  const revisions = useMemo(
    () => (historyQuery.data?.pages ?? []).filter((page) => page !== null).flatMap((page) => page.revisions),
    [historyQuery.data],
  );

  useEffect(() => setSelected(props.page.currentRevisionNumber), [props.page.id, props.page.currentRevisionNumber]);

  const numbers = useMemo(() => revisions.map((revision) => revision.revisionNumber), [revisions]);
  const baseNumber = useMemo(() => {
    if (compareBase === "previous") return Math.max(1, selected - 1);
    if (compareBase === "current") return props.page.currentRevisionNumber;
    return Number(compareBase.slice("since:".length));
  }, [compareBase, selected, props.page.currentRevisionNumber]);

  const selectedQuery = useQuery({ ...projectWikiRevisionOptions(props.wsId, props.projectId, props.page.slug, selected), enabled: selected > 0 });
  const baseQuery = useQuery({ ...projectWikiRevisionOptions(props.wsId, props.projectId, props.page.slug, baseNumber), enabled: selected > 0 });

  const selectedRevision = selectedQuery.data?.revision;
  const baseRevision = baseQuery.data?.revision;
  const before = baseRevision?.contentMarkdown ?? "";
  const after = selectedRevision?.contentMarkdown ?? "";
  const diffLinks = useMemo(
    () => resolveWikiLinks(props.linkIndex, props.page.slug, [before, after]),
    [props.linkIndex, props.page.slug, before, after],
  );
  const previewLinks = useMemo(
    () => resolveWikiLinks(props.linkIndex, props.page.slug, after),
    [props.linkIndex, props.page.slug, after],
  );
  const structureChanges = useMemo(() => (selectedRevision && baseRevision && selectedRevision.id !== baseRevision.id ? diffWikiStructure(
    {
      title: baseRevision.title, slug: baseRevision.slug, parent: baseRevision.parentId,
      position: baseRevision.position, archived: baseRevision.archivedAt !== null,
    },
    {
      title: selectedRevision.title, slug: selectedRevision.slug, parent: selectedRevision.parentId,
      position: selectedRevision.position, archived: selectedRevision.archivedAt !== null,
    },
  ) : []), [selectedRevision, baseRevision]);

  const rollback = async () => {
    const ok = await props.onRollback({ revisionNumber: selected, baseRevisionNumber: props.page.currentRevisionNumber, contentOnly });
    setRollbackOpen(false);
    if (ok) toast.success(t(($) => $.wiki.rollbackDone, { number: selected }));
  };

  return (
    <div className="flex h-full min-h-0" data-wiki-history>
      <aside className="w-[304px] shrink-0 overflow-y-auto border-r p-2 max-[1024px]:max-h-[176px] max-[1024px]:w-full max-[1024px]:border-b max-[1024px]:border-r-0">
        {historyQuery.isLoading ? <Skeleton className="h-40 w-full" /> : revisions.length === 0 ? (
          <p className="px-2 py-6 text-center text-caption text-muted-foreground">{t(($) => $.wiki.historyEmpty)}</p>
        ) : revisions.map((revision) => {
          const isSelected = revision.revisionNumber === selected;
          const isCurrent = revision.revisionNumber === props.page.currentRevisionNumber;
          return (
            <button
              key={revision.id}
              type="button"
              className={cn(
                "mb-1 grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md border p-2 text-left",
                isSelected ? "border-border bg-canvas shadow-sm" : "border-transparent hover:bg-muted/50",
              )}
              onClick={() => setSelected(revision.revisionNumber)}
              data-wiki-history-item={revision.revisionNumber}
            >
              <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-xs text-micro", revision.createdByType === "agent" ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground")}>
                {revision.createdByType === "agent" ? "AI" : getActorName(revision.createdByType, revision.createdById).slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-body">{revision.changeSummary || t(($) => $.wiki.activityKind[wikiActivityKindKey(revision.revisionKind)])}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1 text-micro text-muted-foreground">
                  <Badge variant="secondary" className="h-4 px-1 text-micro">{t(($) => $.wiki.versionPill, { number: revision.revisionNumber })}</Badge>
                  {isCurrent ? <Badge className="h-4 px-1 text-micro">{t(($) => $.wiki.historyCurrent)}</Badge> : null}
                  {revision.revisionKind === "rollback" ? <Badge variant="outline" className="h-4 px-1 text-micro">{t(($) => $.wiki.historyRollbackPill)}</Badge> : null}
                  <span>{t(($) => $.wiki.activityKind[wikiActivityKindKey(revision.revisionKind)])}</span>
                  <span>· {getActorName(revision.createdByType, revision.createdById)}{revision.createdByType === "agent" ? ` · ${t(($) => $.wiki.actorAgent)}` : ""}</span>
                  <span>· <time dateTime={revision.createdAt}>{formatRelativeDate(revision.createdAt)}</time></span>
                  {revision.sourceIssueId ? <Badge variant="outline" className="h-4 px-1 text-micro">OL</Badge> : null}
                </span>
              </span>
            </button>
          );
        })}
        {historyQuery.hasNextPage ? (
          <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => void historyQuery.fetchNextPage()} disabled={historyQuery.isFetchingNextPage}>
            {historyQuery.isFetchingNextPage ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {t(($) => $.wiki.historyMore)}
          </Button>
        ) : null}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-canvas px-4 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={props.onBack}><ArrowLeft aria-hidden="true" />{t(($) => $.wiki.historyBack)}</Button>
          <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.wiki.historyTabsLabel)}>
            {(["rendered", "preview"] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={tab === item}
                className={cn("rounded-sm px-2.5 py-1 text-caption", tab === item ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
                onClick={() => setTab(item)}
              >{t(($) => $.wiki.historyTab[item])}</button>
            ))}
          </div>
          {(() => {
            const options: { value: CompareBase; label: string }[] = [
              { value: "previous", label: t(($) => $.wiki.historyBasePrevious) },
              { value: "current", label: t(($) => $.wiki.historyBaseCurrent, { number: props.page.currentRevisionNumber }) },
              ...numbers.filter((number) => number !== selected).map((number) => ({
                value: `since:${number}` as CompareBase, label: t(($) => $.wiki.historyBaseSince, { number }),
              })),
            ];
            return (
              <Select items={options} value={compareBase} onValueChange={(value) => setCompareBase(value as CompareBase)}>
                <SelectTrigger size="sm" className="w-44" aria-label={t(($) => $.wiki.historyBaseLabel)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          })()}
          <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <Switch checked={changesOnly} onCheckedChange={setChangesOnly} aria-label={t(($) => $.wiki.historyChangesOnly)} />
            {t(($) => $.wiki.historyChangesOnly)}
          </label>
          <div className="ml-auto flex items-center gap-2">
            <WikiDiffLegend />
            <WikiDiffSummary before={before} after={after} />
          </div>
        </div>
        <div className="px-4 py-3 max-w-[812px]">
          {selectedQuery.isLoading || baseQuery.isLoading ? <Skeleton className="h-40 w-full" /> : tab === "rendered" ? (
            <>
              <WikiStructureBar changes={structureChanges} />
              <WikiDiffView before={before} after={after} changesOnly={changesOnly} links={diffLinks} onNavigate={props.onNavigate} />
              <WikiSourceDiff before={before} after={after} />
            </>
          ) : (
            <WikiMarkdown markdown={after} sections={props.page.sections} links={previewLinks} onNavigate={props.onNavigate} />
          )}
        </div>
      </div>
      <div className="absolute bottom-4 right-4">
        <Button
          type="button"
          size="sm"
          disabled={selected === props.page.currentRevisionNumber || props.saving}
          title={selected === props.page.currentRevisionNumber ? t(($) => $.wiki.rollbackCurrentHint) : undefined}
          onClick={() => setRollbackOpen(true)}
          data-wiki-rollback
        >
          <RotateCcw aria-hidden="true" />{t(($) => $.wiki.rollbackTo, { number: selected })}
        </Button>
      </div>
      {rollbackOpen ? (
        <Dialog open onOpenChange={(open) => !open && setRollbackOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(($) => $.wiki.rollbackTitle, { number: selected })}</DialogTitle>
              <DialogDescription>{t(($) => $.wiki.rollbackDescription, { number: selected, next: props.page.currentRevisionNumber + 1 })}</DialogDescription>
            </DialogHeader>
            <label className="flex items-center gap-2 text-caption">
              <Checkbox checked={contentOnly} onCheckedChange={(checked) => setContentOnly(checked === true)} />
              {t(($) => $.wiki.rollbackContentOnly)}
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRollbackOpen(false)}>{t(($) => $.actions.cancel)}</Button>
              <Button type="button" size="sm" disabled={props.saving} onClick={() => void rollback()}>
                <CheckCircle2 aria-hidden="true" />{t(($) => $.wiki.rollbackConfirm)}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

