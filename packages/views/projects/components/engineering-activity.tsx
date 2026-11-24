"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, X } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import type { WikiActivityItem, WikiTreePage } from "@multica/core/api";
import { projectWikiRevisionOptions } from "@multica/core/projects/queries";
import { paths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { IssueMentionCard } from "../../issues/components/issue-mention-card";
import { WikiDiffSummary, WikiDiffView } from "./engineering-baseline-diff";
import { wikiActivityKindKey } from "./engineering-utils";
import { useFormatRelativeDate } from "./labels";

export function EngineeringActivity({ workspaceSlug, workspaceId, projectId, items, pages, loading, error, onRetry, hasMore, loadingMore, loadMoreError, onLoadMore }: {
  workspaceSlug: string;
  workspaceId: string;
  projectId: string;
  items: readonly WikiActivityItem[];
  pages: readonly WikiTreePage[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useT("engineering");
  const navigation = useNavigation();
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const [actorFilter, setActorFilter] = useState<"all" | "member" | "agent">("all");
  const [pageFilter, setPageFilter] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const filtered = useMemo(() => items.filter((item) =>
    (actorFilter === "all" || item.createdByType === actorFilter)
    && (pageFilter === "all" || item.pageId === pageFilter),
  ), [actorFilter, items, pageFilter]);
  useEffect(() => {
    if (!loading && !error && !filtered.length && hasMore && !loadingMore && !loadMoreError) onLoadMore();
  }, [error, filtered.length, hasMore, loading, loadingMore, loadMoreError, onLoadMore]);
  const selected = filtered.find((item) => `${item.pageId}:${item.number}` === selectedKey) ?? filtered[0] ?? null;
  const selectedRevision = useQuery({
    ...projectWikiRevisionOptions(workspaceId, projectId, selected?.slug ?? "", selected?.number ?? 1),
    enabled: !!selected,
  });
  const previousRevision = useQuery({
    ...projectWikiRevisionOptions(workspaceId, projectId, selected?.slug ?? "", Math.max(1, (selected?.number ?? 1) - 1)),
    enabled: !!selected && selected.number > 1,
  });
  const before = selected && selected.number > 1 ? previousRevision.data?.revision.contentMarkdown ?? "" : "";
  const after = selectedRevision.data?.revision.contentMarkdown ?? "";
  const diffLoading = selectedRevision.isLoading || (selected !== null && selected.number > 1 && previousRevision.isLoading);
  const diffError = selectedRevision.isError || previousRevision.isError;
  const pageOptions = [
    { value: "all", label: t(($) => $.activity.allPages) },
    ...pages.map((page) => ({ value: page.id, label: page.title || page.slug })),
  ];

  const openWiki = (item: WikiActivityItem, history: boolean) => {
    navigation.push(paths.workspace(workspaceSlug).projectEngineering(projectId, {
      tab: "wiki", page: item.slug, history, rev: history ? item.number : undefined,
    }));
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden" data-engineering-activity>
      <div className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2 md:px-5">
        <div className="flex rounded-md border p-0.5" role="group" aria-label={t(($) => $.views.activity)}>
          {(["all", "member", "agent"] as const).map((filter) => <Button key={filter} type="button" variant={actorFilter === filter ? "secondary" : "ghost"} size="sm" className="h-7" aria-pressed={actorFilter === filter} onClick={() => setActorFilter(filter)}>{t(($) => filter === "all" ? $.activity.all : filter === "member" ? $.activity.humans : $.activity.agents)}</Button>)}
        </div>
        <Select items={pageOptions} value={pageFilter} onValueChange={(value) => setPageFilter(value ?? "all")}>
          <SelectTrigger size="sm" aria-label={t(($) => $.activity.allPages)}><SelectValue /></SelectTrigger>
          <SelectContent>{pageOptions.map((page) => <SelectItem key={page.value} value={page.value}>{page.label}</SelectItem>)}</SelectContent>
        </Select>
        <p className="ml-auto text-caption text-muted-foreground">{t(($) => $.activity.future)}</p>
      </div>
      <div className="relative grid min-h-0 flex-1 grid-cols-1 @[1024px]:grid-cols-[minmax(380px,1.05fr)_minmax(0,1fr)]">
        <section className="min-h-0 overflow-y-auto @[1024px]:border-r" aria-label={t(($) => $.views.activity)}>
          {loading ? <div className="space-y-3 p-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : error ? (
            <div className="p-6 text-center text-body text-destructive"><p>{t(($) => $.wiki.activityError)}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>{t(($) => $.actions.retry)}</Button></div>
          ) : filtered.length ? filtered.map((item) => {
            const key = `${item.pageId}:${item.number}`;
            const active = !!selected && `${selected.pageId}:${selected.number}` === key;
            return (
              <button key={key} type="button" className={cn("grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b px-4 py-3 text-left hover:bg-muted/40", active && "bg-muted/60")} aria-pressed={active} data-activity-row={key} onClick={() => { setSelectedKey(key); setPreviewOpen(true); }}>
                <ActorAvatar actorType={item.createdByType} actorId={item.createdById} size="sm" profileLink={false} />
                <span className="min-w-0">
                  <span className="block truncate text-label"><span className="font-medium">{item.title || item.slug}</span> · {t(($) => $.wiki.activityKind[wikiActivityKindKey(item.kind)])}</span>
                  <span className="mt-0.5 block truncate text-caption text-muted-foreground">{getActorName(item.createdByType, item.createdById)} · <time dateTime={item.createdAt}>{formatRelativeDate(item.createdAt)}</time></span>
                  <span className="mt-1 block truncate text-caption text-muted-foreground">{item.changeSummary || t(($) => $.wiki.activityNoSummary)}</span>
                  {item.sourceIssueId ? <span className="mt-1 inline-flex" onClick={(event) => event.stopPropagation()}><IssueMentionCard issueId={item.sourceIssueId} /></span> : null}
                </span>
                <span className="text-caption text-muted-foreground">{t(($) => $.wiki.versionPill, { number: item.number })}</span>
              </button>
            );
          }) : <p className="p-8 text-center text-body text-muted-foreground">{t(($) => $.activity.empty)}</p>}
          {!loading && !error && hasMore ? <div className="p-3 text-center"><Button type="button" variant="ghost" size="sm" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.wiki.historyMore)}</Button></div> : null}
        </section>
        <aside className={cn("absolute inset-0 min-h-0 flex-col bg-page-canvas @[1024px]:static @[1024px]:flex", previewOpen ? "flex" : "hidden")} data-activity-preview>
          {selected ? (
            <>
              <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
                <Button type="button" variant="ghost" size="icon-sm" className="@[1024px]:hidden" aria-label={t(($) => $.actions.close)} onClick={() => setPreviewOpen(false)}><X aria-hidden="true" /></Button>
                <div className="min-w-0 flex-1"><div className="truncate text-label font-medium">{selected.title || selected.slug} <span className="text-muted-foreground">{t(($) => $.wiki.versionPill, { number: selected.number })}</span></div>{!diffLoading && !diffError ? <WikiDiffSummary before={before} after={after} /> : null}</div>
                <Button type="button" variant="ghost" size="sm" onClick={() => openWiki(selected, false)}>{t(($) => $.activity.openPage)}</Button>
                <Button type="button" variant="link" size="sm" onClick={() => openWiki(selected, true)}>{t(($) => $.activity.fullHistory)}</Button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
                {diffLoading ? <Skeleton className="h-48 w-full" /> : diffError ? <div className="text-body text-destructive"><p>{t(($) => $.activity.diffError)}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => { void selectedRevision.refetch(); void previousRevision.refetch(); }}>{t(($) => $.actions.retry)}</Button></div> : <WikiDiffView before={before} after={after} changesOnly />}
              </div>
            </>
          ) : <p className="m-auto p-6 text-center text-body text-muted-foreground">{t(($) => $.activity.select)}</p>}
        </aside>
      </div>
    </main>
  );
}
