import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MessageSquarePlus, Plus } from "@multica/ui/icons";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import type { BaselineChapter, BaselineRevision } from "@multica/core/api";
import {
  BASELINE_ANNOTATION_LINE_LIMIT,
  BASELINE_ANNOTATION_QUOTE_LIMIT,
  type BaselineAnnotationDraft,
  type BaselineAnnotationDraftItem,
} from "@multica/core/projects/baseline-annotation-draft-store";
import {
  diffBaselineSourceLines,
  findBaselineSourceSection,
  foldBaselineSourceDiff,
  type BaselineSourceDiffRow,
} from "@multica/core/projects/baseline-source-diff";
import { useT } from "../../i18n";
import { parseBaselineChapter, type BaselineDisplaySection } from "./engineering-baseline-utils";
import {
  annotationLines,
  annotationSide,
  isBaselineAnnotationReply,
  type BaselineAnnotationSide,
  type BaselineAnnotationThread,
  type BaselineComposerAnchor,
} from "./engineering-baseline-annotation-model";
import {
  BaselineAnnotationComposer,
  BaselineSubmittedThread,
  PendingBaselineAnnotationCard,
} from "./engineering-baseline-annotation-card";
import { BaselineStandaloneThreads } from "./engineering-baseline-reading-annotations";

interface SharedAnnotationProps {
  canDecide: boolean;
  limitReached: boolean;
  onUpdatePending: (id: string, note: string) => void;
  onDeletePending: (id: string) => void;
  onResolve: (annotationId: string, resolved: boolean) => Promise<boolean>;
  onAddReply: (thread: BaselineAnnotationThread, note: string) => boolean;
}

interface BaselineSourceDiffProps extends SharedAnnotationProps {
  chapter: BaselineChapter;
  sections: readonly BaselineDisplaySection[];
  beforeContent: string;
  afterContent: string;
  candidate: BaselineRevision;
  adopted: BaselineRevision | null;
  threads: readonly BaselineAnnotationThread[];
  pendingItems: readonly BaselineAnnotationDraftItem[];
  onAddAnnotation: (anchor: BaselineComposerAnchor, note: string) => boolean;
}

type DisplayAnnotation =
  | { kind: "thread"; thread: BaselineAnnotationThread }
  | { kind: "pending"; item: BaselineAnnotationDraft };

interface ComposerState {
  sectionKey: string;
  anchor: BaselineComposerAnchor;
}

export function baselineSourceDisplaySections(
  chapter: BaselineChapter,
  beforeContent: string,
  afterContent: string,
): BaselineDisplaySection[] {
  const beforeSections = parseBaselineChapter(chapter, beforeContent).sections;
  const afterSections = parseBaselineChapter(chapter, afterContent).sections;
  const result: BaselineDisplaySection[] = afterSections.map((section) => {
    const previous = beforeSections.find((entry) => entry.anchor === section.anchor);
    const before = findBaselineSourceSection(beforeContent, section.anchor);
    const after = findBaselineSourceSection(afterContent, section.anchor);
    return {
      ...section,
      change: !previous ? "added" : before?.ownMarkdown !== after?.ownMarkdown ? "modified" : "same",
      beforeBody: previous?.body ?? "",
    };
  });
  for (const section of beforeSections) {
    if (afterSections.some((entry) => entry.anchor === section.anchor)) continue;
    result.push({ ...section, change: "removed", beforeBody: "" });
  }
  return result;
}

function locatedRowRange(
  rows: readonly BaselineSourceDiffRow[],
  item: BaselineAnnotationThread["root"] | BaselineAnnotationDraft,
  baseRevisionId: string | null,
): { start: number; end: number } | null {
  if ("location" in item && (item.location === "outdated" || item.location === "section_only")) return null;
  const lines = annotationLines(item);
  if (!lines) return null;
  const side = annotationSide(item, baseRevisionId);
  const key = side === "before" ? "beforeLine" : "afterLine";
  const start = rows.findIndex((row) => row[key] === lines.start);
  const end = rows.findIndex((row) => row[key] === lines.end);
  return start >= 0 && end >= 0 ? { start: Math.min(start, end), end: Math.max(start, end) } : null;
}

function lineSelection(
  rows: readonly BaselineSourceDiffRow[],
  startIndex: number,
  endIndex: number,
  side: BaselineAnnotationSide,
): { lineStart: number; lineEnd: number; quote: string; count: number } | null {
  const key = side === "before" ? "beforeLine" : "afterLine";
  const selected = rows.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1)
    .filter((row) => row[key] != null);
  const first = selected[0]?.[key];
  const last = selected.at(-1)?.[key];
  if (first == null || last == null) return null;
  return {
    lineStart: Math.min(first, last),
    lineEnd: Math.max(first, last),
    quote: selected.map((row) => row.text).join("\n"),
    count: Math.abs(last - first) + 1,
  };
}

export function BaselineSourceDiff(props: BaselineSourceDiffProps) {
  const { t } = useT("engineering");
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [selectionError, setSelectionError] = useState<"lines" | "quote" | null>(null);
  const baseRevisionId = props.candidate.baseRevisionId ?? props.adopted?.id ?? null;
  const pendingAnnotations = props.pendingItems.filter((item): item is BaselineAnnotationDraft => !isBaselineAnnotationReply(item));
  const placedPending = new Set<string>();
  const changedSections = props.sections.filter((section) => section.change !== "same");
  const unchangedCount = props.sections.length - changedSections.length;
  for (const item of pendingAnnotations) {
    const section = changedSections.find((entry) => entry.anchor === item.sectionAnchor);
    if (!section) continue;
    if (item.targetRevisionId !== baseRevisionId) {
      placedPending.add(item.id);
      continue;
    }
    if (item.anchorKind !== "lines") continue;
    const before = findBaselineSourceSection(props.beforeContent, section.anchor);
    const after = findBaselineSourceSection(props.afterContent, section.anchor);
    const rows = diffBaselineSourceLines(before?.ownMarkdown ?? "", after?.ownMarkdown ?? "");
    if (locatedRowRange(rows, item, baseRevisionId)) placedPending.add(item.id);
  }

  const openLineComposer = (
    section: BaselineDisplaySection,
    rows: readonly BaselineSourceDiffRow[],
    startIndex: number,
    endIndex: number,
    side: BaselineAnnotationSide,
  ) => {
    const targetRevisionId = side === "before" ? baseRevisionId : props.candidate.id;
    if (!targetRevisionId) return;
    const selected = lineSelection(rows, startIndex, endIndex, side);
    if (!selected) return;
    if (selected.count > BASELINE_ANNOTATION_LINE_LIMIT) {
      setSelectionError("lines");
      setComposer(null);
      return;
    }
    if (Array.from(selected.quote).length > BASELINE_ANNOTATION_QUOTE_LIMIT) {
      setSelectionError("quote");
      setComposer(null);
      return;
    }
    setSelectionError(null);
    setComposer({
      sectionKey: section.key,
      anchor: {
        anchorKind: "lines",
        targetRevisionId,
        sectionAnchor: section.anchor,
        sectionTitle: section.title,
        lineStart: selected.lineStart,
        lineEnd: selected.lineEnd,
        quote: selected.quote,
        side,
        targetLabel: side === "before"
          ? t(($) => $.baseline.baseMode, { number: props.adopted?.revisionNumber ?? props.candidate.anchorsDiff.baseRevisionNumber })
          : t(($) => $.baseline.compareMode, { number: props.candidate.revisionNumber }),
        endRowIndex: Math.max(startIndex, endIndex),
      },
    });
  };

  const openSectionComposer = (section: BaselineDisplaySection) => {
    const beforeOnly = section.change === "removed";
    const targetRevisionId = beforeOnly ? baseRevisionId : props.candidate.id;
    if (!targetRevisionId) return;
    setSelectionError(null);
    setComposer({
      sectionKey: section.key,
      anchor: {
        anchorKind: "section",
        targetRevisionId,
        sectionAnchor: section.anchor,
        sectionTitle: section.title,
        side: beforeOnly ? "before" : "after",
        targetLabel: beforeOnly
          ? t(($) => $.baseline.baseMode, { number: props.adopted?.revisionNumber ?? props.candidate.anchorsDiff.baseRevisionNumber })
          : t(($) => $.baseline.compareMode, { number: props.candidate.revisionNumber }),
      },
    });
  };

  const renderThread = (thread: BaselineAnnotationThread) => (
    <BaselineSubmittedThread
      key={thread.root.id}
      thread={thread}
      canDecide={props.canDecide}
      limitReached={props.limitReached}
      onAddReply={(note) => props.onAddReply(thread, note)}
      onUpdatePending={props.onUpdatePending}
      onDeletePending={props.onDeletePending}
      onResolve={(resolved) => props.onResolve(thread.root.id, resolved)}
    />
  );
  const renderPending = (item: BaselineAnnotationDraft) => (
    <PendingBaselineAnnotationCard
      key={item.id}
      item={item}
      side={annotationSide(item, baseRevisionId)}
      targetLabel={item.targetRevisionId === baseRevisionId
        ? t(($) => $.baseline.baseMode, { number: props.adopted?.revisionNumber ?? props.candidate.anchorsDiff.baseRevisionNumber })
        : t(($) => $.baseline.compareMode, { number: props.candidate.revisionNumber })}
      onUpdate={props.onUpdatePending}
      onDelete={props.onDeletePending}
    />
  );

  return (
    <div data-baseline-source-diff>
      {selectionError ? (
        <Alert className="mb-4" variant="destructive"><AlertDescription>{t(($) => selectionError === "lines" ? $.annotations.lineSelectionLimit : $.annotations.quoteLimit)}</AlertDescription></Alert>
      ) : null}
      {changedSections.map((section) => (
        <BaselineDiffSection
          key={section.key}
          section={section}
          beforeContent={props.beforeContent}
          afterContent={props.afterContent}
          baseRevisionId={baseRevisionId}
          threads={props.threads.filter((thread) => thread.root.sectionAnchor === section.anchor)}
          pendingAnnotations={pendingAnnotations.filter((item) => item.sectionAnchor === section.anchor)}
          composer={composer?.sectionKey === section.key ? composer.anchor : null}
          canAnnotate={props.canDecide}
          limitReached={props.limitReached}
          onOpenLineComposer={openLineComposer}
          onOpenSectionComposer={openSectionComposer}
          onAddAnnotation={props.onAddAnnotation}
          onCancelComposer={() => setComposer(null)}
          placedPending={placedPending}
          renderThread={renderThread}
          renderPending={renderPending}
        />
      ))}
      {unchangedCount ? <p className="mt-4 text-caption text-muted-foreground">{t(($) => $.annotations.unchangedSections, { count: unchangedCount })}</p> : null}
      <BaselinePendingGroup
        title={t(($) => $.annotations.baselinePendingGroup)}
        items={pendingAnnotations.filter((item) => item.targetRevisionId === baseRevisionId && !placedPending.has(item.id))}
        renderPending={renderPending}
      />
      <BaselinePendingGroup
        title={t(($) => $.annotations.unlocatedPendingGroup)}
        items={pendingAnnotations.filter((item) => item.targetRevisionId !== baseRevisionId && !placedPending.has(item.id) && !changedSections.some((section) => section.anchor === item.sectionAnchor))}
        renderPending={renderPending}
      />
      <BaselineStandaloneThreads
        title={t(($) => $.annotations.unlocatedPendingGroup)}
        threads={props.threads.filter((thread) => !changedSections.some((section) => section.anchor === thread.root.sectionAnchor))}
        canDecide={props.canDecide}
        limitReached={props.limitReached}
        onAddReply={props.onAddReply}
        onUpdatePending={props.onUpdatePending}
        onDeletePending={props.onDeletePending}
        onResolve={props.onResolve}
      />
    </div>
  );
}

function BaselinePendingGroup({ title, items, renderPending }: {
  title: string;
  items: readonly BaselineAnnotationDraft[];
  renderPending: (item: BaselineAnnotationDraft) => React.ReactNode;
}) {
  if (!items.length) return null;
  return (
    <section className="mt-5 rounded-lg border border-dashed p-3" data-baseline-pending-group={title}>
      <h3 className="mb-3 text-caption font-medium">{title}</h3>
      <div className="space-y-2">{items.map(renderPending)}</div>
    </section>
  );
}

function BaselineDiffSection({
  section,
  beforeContent,
  afterContent,
  baseRevisionId,
  threads,
  pendingAnnotations,
  composer,
  canAnnotate,
  limitReached,
  onOpenLineComposer,
  onOpenSectionComposer,
  onAddAnnotation,
  onCancelComposer,
  placedPending,
  renderThread,
  renderPending,
}: {
  section: BaselineDisplaySection;
  beforeContent: string;
  afterContent: string;
  baseRevisionId: string | null;
  threads: readonly BaselineAnnotationThread[];
  pendingAnnotations: readonly BaselineAnnotationDraft[];
  composer: BaselineComposerAnchor | null;
  canAnnotate: boolean;
  limitReached: boolean;
  onOpenLineComposer: (section: BaselineDisplaySection, rows: readonly BaselineSourceDiffRow[], start: number, end: number, side: BaselineAnnotationSide) => void;
  onOpenSectionComposer: (section: BaselineDisplaySection) => void;
  onAddAnnotation: (anchor: BaselineComposerAnchor, note: string) => boolean;
  onCancelComposer: () => void;
  placedPending: Set<string>;
  renderThread: (thread: BaselineAnnotationThread) => React.ReactNode;
  renderPending: (item: BaselineAnnotationDraft) => React.ReactNode;
}) {
  const { t } = useT("engineering");
  const [expandedFoldStarts, setExpandedFoldStarts] = useState<ReadonlySet<number>>(new Set());
  const [dragRange, setDragRange] = useState<{ start: number; end: number; side: BaselineAnnotationSide } | null>(null);
  const dragRef = useRef<{ start: number; end: number; side: BaselineAnnotationSide } | null>(null);
  const suppressClickRef = useRef(false);
  const before = findBaselineSourceSection(beforeContent, section.anchor);
  const after = findBaselineSourceSection(afterContent, section.anchor);
  const rows = useMemo(
    () => diffBaselineSourceLines(before?.ownMarkdown ?? "", after?.ownMarkdown ?? ""),
    [before?.ownMarkdown, after?.ownMarkdown],
  );
  const added = rows.filter((row) => row.kind === "added").length;
  const removed = rows.filter((row) => row.kind === "removed").length;
  const annotationsByRow = new Map<number, DisplayAnnotation[]>();
  const extra: DisplayAnnotation[] = [];
  const requiredRowIndexes = new Set<number>();

  for (const thread of threads) {
    const range = locatedRowRange(rows, thread.root, baseRevisionId);
    if (thread.root.anchorKind === "lines" && range) {
      const list = annotationsByRow.get(range.end) ?? [];
      list.push({ kind: "thread", thread });
      annotationsByRow.set(range.end, list);
      for (let index = range.start; index <= range.end; index++) requiredRowIndexes.add(index);
    } else {
      extra.push({ kind: "thread", thread });
    }
  }
  for (const item of pendingAnnotations) {
    const range = locatedRowRange(rows, item, baseRevisionId);
    const isBaseline = item.targetRevisionId === baseRevisionId;
    if (item.anchorKind === "lines" && range) {
      const list = annotationsByRow.get(range.end) ?? [];
      list.push({ kind: "pending", item });
      annotationsByRow.set(range.end, list);
      placedPending.add(item.id);
      for (let index = range.start; index <= range.end; index++) requiredRowIndexes.add(index);
    } else if (!isBaseline) {
      extra.push({ kind: "pending", item });
      placedPending.add(item.id);
    }
  }
  if (composer?.anchorKind === "lines" && composer.endRowIndex != null) {
    requiredRowIndexes.add(composer.endRowIndex);
  }
  const displayRows = foldBaselineSourceDiff(rows, { context: 3, requiredRowIndexes, expandedFoldStarts });

  useEffect(() => {
    const finish = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setDragRange(null);
      suppressClickRef.current = true;
      onOpenLineComposer(section, rows, drag.start, drag.end, drag.side);
    };
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [onOpenLineComposer, rows, section]);

  const startDrag = (event: React.MouseEvent, index: number, side: BaselineAnnotationSide) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const drag = { start: index, end: index, side };
    dragRef.current = drag;
    setDragRange(drag);
  };
  const extendDrag = (index: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    const key = drag.side === "before" ? "beforeLine" : "afterLine";
    if (rows[index]?.[key] == null) return;
    const next = { ...drag, end: index };
    dragRef.current = next;
    setDragRange(next);
  };
  const rowSelected = (index: number) => {
    if (!dragRange || index < Math.min(dragRange.start, dragRange.end) || index > Math.max(dragRange.start, dragRange.end)) return false;
    const key = dragRange.side === "before" ? "beforeLine" : "afterLine";
    return rows[index]?.[key] != null;
  };
  const lineButton = (row: BaselineSourceDiffRow, index: number, side: BaselineAnnotationSide) => {
    const line = side === "before" ? row.beforeLine : row.afterLine;
    if (line == null) return null;
    return (
      <button
        type="button"
        className="absolute left-0.5 top-0.5 grid size-5 place-items-center rounded-sm bg-brand text-brand-foreground opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 max-md:opacity-60 [@media(hover:none)]:opacity-60"
        aria-label={t(($) => $.annotations.annotateLine, { side: t(($) => $.annotations.side[side]), line, section: section.title })}
        onMouseDown={(event) => startDrag(event, index, side)}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onOpenLineComposer(section, rows, index, index, side);
        }}
      ><Plus className="size-3.5" aria-hidden="true" /></button>
    );
  };

  return (
    <section id={`baseline-section-${encodeURIComponent(section.key)}`} data-baseline-section-key={section.key} data-diff-kind={section.change} className="mt-5 scroll-mt-32 overflow-hidden rounded-lg border first:mt-0">
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2">
        <div className="min-w-0 flex-1">
          <span className="mr-2 font-mono text-caption text-muted-foreground">{section.anchor}</span>
          <span className="font-medium">{section.title || t(($) => $.wiki.untitled)}</span>
        </div>
        <Badge variant={section.change === "removed" ? "destructive" : "secondary"}>{t(($) => section.change === "added" ? $.baseline.added : section.change === "removed" ? $.baseline.removed : $.baseline.modified)}</Badge>
        <span className="font-mono text-micro"><span className="text-success">+{added}</span><span className="ml-2 text-destructive">−{removed}</span></span>
        {canAnnotate ? <Button type="button" size="xs" variant="ghost" onClick={() => onOpenSectionComposer(section)}><MessageSquarePlus aria-hidden="true" />{t(($) => $.annotations.annotateSection)}</Button> : null}
      </header>
      {extra.length || composer?.anchorKind === "section" ? (
        <div className="space-y-2 border-b p-3" data-section-annotations={section.anchor}>
          {extra.map((item) => item.kind === "thread" ? renderThread(item.thread) : renderPending(item.item))}
          {composer?.anchorKind === "section" ? <BaselineAnnotationComposer anchor={composer} limitReached={limitReached} onAdd={(note) => onAddAnnotation(composer, note)} onCancel={onCancelComposer} /> : null}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse font-mono text-caption" aria-label={t(($) => $.annotations.diffTable, { title: section.title })}>
          <colgroup><col className="w-16" /><col className="w-16" /><col className="w-7" /><col /></colgroup>
          <tbody>
            {displayRows.map((displayRow) => {
              if (displayRow.kind === "folded") {
                return (
                  <tr key={`fold-${displayRow.start}`} className="bg-info/5">
                    <td colSpan={4} className="px-3 py-1 text-center">
                      <Button type="button" size="xs" variant="ghost" onClick={() => setExpandedFoldStarts((current) => new Set([...current, displayRow.start]))}>
                        <ChevronDown aria-hidden="true" />{t(($) => $.annotations.expandLines, { count: displayRow.count })}
                      </Button>
                    </td>
                  </tr>
                );
              }
              const originalIndex = rows.indexOf(displayRow);
              const annotations = annotationsByRow.get(originalIndex) ?? [];
              const showComposer = composer?.anchorKind === "lines" && composer.endRowIndex === originalIndex;
              return (
                <Fragment key={`row-${originalIndex}`}>
                  <tr
                    data-diff-row={originalIndex}
                    data-before-line={displayRow.beforeLine ?? undefined}
                    data-after-line={displayRow.afterLine ?? undefined}
                    className={cn("group/row", displayRow.kind === "added" && "bg-success/10", displayRow.kind === "removed" && "bg-destructive/10", rowSelected(originalIndex) && "bg-brand/20")}
                    onMouseEnter={() => extendDrag(originalIndex)}
                  >
                    <td className="relative select-none pl-6 pr-2 text-right tabular-nums text-muted-foreground">{canAnnotate ? lineButton(displayRow, originalIndex, "before") : null}{displayRow.beforeLine ?? ""}</td>
                    <td className="relative select-none pl-6 pr-2 text-right tabular-nums text-muted-foreground">{canAnnotate ? lineButton(displayRow, originalIndex, "after") : null}{displayRow.afterLine ?? ""}</td>
                    <td className="select-none text-center text-muted-foreground">{displayRow.kind === "added" ? "+" : displayRow.kind === "removed" ? "−" : ""}</td>
                    <td className="whitespace-pre-wrap break-words pr-3">{displayRow.text || "\u00a0"}</td>
                  </tr>
                  {annotations.length || showComposer ? (
                    <tr><td colSpan={4} className="border-y bg-background p-3 font-sans">
                      <div className="ml-0 space-y-2 md:ml-12">
                        {annotations.map((item) => item.kind === "thread" ? renderThread(item.thread) : renderPending(item.item))}
                        {showComposer ? <BaselineAnnotationComposer anchor={composer} limitReached={limitReached} onAdd={(note) => onAddAnnotation(composer, note)} onCancel={onCancelComposer} /> : null}
                      </div>
                    </td></tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {!before || !after ? <p className="border-t px-3 py-2 text-micro text-muted-foreground">{t(($) => !before ? $.annotations.addedSource : $.annotations.removedSource)}</p> : null}
    </section>
  );
}
