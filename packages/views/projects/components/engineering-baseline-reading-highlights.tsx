"use client";

import { useEffect, useId, useState, type RefObject } from "react";
import { MessageSquare } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import type { WikiCommentAnchor, WikiThread } from "@multica/core/api";
import { locateComment } from "@multica/core/projects/queries";
import { indexWikiCommentText, wikiSelectionAnchor } from "./engineering-baseline-comment-text";
import { useT } from "../../i18n";

interface Mark { ids: string[]; count: number; top: number; left: number }
export function WikiReadingHighlights({ readerRef, threads, contentKey, revisionNumber, activeThreadId, pendingAnchor, onThread, onCompose }: {
  readerRef: RefObject<HTMLDivElement | null>; threads: WikiThread[]; contentKey: string; revisionNumber: number;
  activeThreadId?: string; pendingAnchor?: WikiCommentAnchor; onThread: (id: string, siblings: string[]) => void; onCompose: (a: WikiCommentAnchor) => void;
}) {
  const { t } = useT("engineering");
  const name = `wiki-comment-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selection, setSelection] = useState<{ anchor: WikiCommentAnchor; top: number; left: number } | null>(null);
  useEffect(() => {
    const root = readerRef.current; if (!root) return;
    const canHighlight = typeof Highlight !== "undefined" && typeof CSS !== "undefined" && !!CSS.highlights;
    let located: { id: string; range: Range; count: number }[] = [];
    const update = () => {
      const sections = [...root.querySelectorAll<HTMLElement>("[data-wiki-comment-section]")].flatMap((element) => {
        const body = element.querySelector<HTMLElement>("[data-wiki-markdown]"); if (!body) return [];
        const index = indexWikiCommentText(body);
        return [{ anchor: element.dataset.wikiCommentSection!, title: element.dataset.sectionTitle ?? "", text: index.text, index, element }];
      });
      const locateRange = (anchor: WikiCommentAnchor) => {
        const location = locateComment(sections, anchor);
        if (location.state === "orphaned" || (anchor.kind === "text" && location.state === "section_only")) return null;
        const section = sections.find((s) => s.anchor === location.sectionAnchor);
        return section?.index.range(location.start ?? 0, anchor.kind === "section" ? Math.max(1, section.title.length) : anchor.exact.length) ?? null;
      };
      located = threads.filter((thread) => !thread.resolvedAt).flatMap((thread) => {
        const range = locateRange(thread.anchor); return range ? [{ id: thread.id, range, count: thread.comments.length }] : [];
      });
      const pending = pendingAnchor ? locateRange(pendingAnchor) : null;
      if (canHighlight) {
        CSS.highlights.set(name, new Highlight(...located.map((m) => m.range)));
        CSS.highlights.set(`${name}-active`, new Highlight(...located.filter((m) => m.id === activeThreadId).map((m) => m.range)));
        CSS.highlights.set(`${name}-pending`, new Highlight(...(pending ? [pending] : [])));
      }
      const rect = root.getBoundingClientRect();
      const groups: Mark[] = [];
      for (const mark of located) {
        if (typeof mark.range.getClientRects !== "function") continue;
        const bounds = mark.range.getClientRects()[0]; if (!bounds) continue;
        const top = bounds.top - rect.top + root.scrollTop;
        const group = groups.find((g) => Math.abs(g.top - top) < 8);
        if (group) { group.ids.push(mark.id); group.count += mark.count; }
        else groups.push({ ids: [mark.id], count: mark.count, top, left: Math.max(0, root.clientWidth - 48) });
      }
      setMarks(groups);
    };
    const click = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed || (event.target as Element).closest("button, a")) return;
      for (const mark of located) {
        if (typeof mark.range.getClientRects !== "function") continue;
        if ([...mark.range.getClientRects()].some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) { onThread(mark.id, [mark.id]); return; }
      }
    };
    update(); root.addEventListener("click", click);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update); observer?.observe(root);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect(); root.removeEventListener("click", click); window.removeEventListener("resize", update);
      if (canHighlight) { CSS.highlights.delete(name); CSS.highlights.delete(`${name}-active`); CSS.highlights.delete(`${name}-pending`); }
    };
  }, [readerRef, threads, contentKey, activeThreadId, pendingAnchor, name, onThread]);

  useEffect(() => {
    const root = readerRef.current; if (!root) return;
    const capture = () => {
      const picked = wikiSelectionAnchor(root, window.getSelection(), revisionNumber);
      if (!picked || typeof picked.range.getBoundingClientRect !== "function") { setSelection(null); return; }
      const bounds = picked.range.getBoundingClientRect(), rect = root.getBoundingClientRect();
      setSelection({ anchor: picked.anchor, top: Math.max(root.scrollTop, bounds.top - rect.top + root.scrollTop - 36), left: Math.max(8, Math.min(root.clientWidth - 180, bounds.left - rect.left)) });
    };
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "m") {
        const picked = wikiSelectionAnchor(root, window.getSelection(), revisionNumber);
        if (picked) { event.preventDefault(); onCompose(picked.anchor); setSelection(null); }
      }
    };
    root.addEventListener("mouseup", capture); root.addEventListener("keyup", capture); document.addEventListener("keydown", shortcut);
    return () => { root.removeEventListener("mouseup", capture); root.removeEventListener("keyup", capture); document.removeEventListener("keydown", shortcut); };
  }, [readerRef, revisionNumber, onCompose]);

  return <>
    <style>{`::highlight(${name}) { background: color-mix(in srgb, #eab308 22%, transparent); } ::highlight(${name}-active) { background: color-mix(in srgb, #eab308 40%, transparent); text-decoration: underline; } ::highlight(${name}-pending) { background: color-mix(in srgb, #eab308 28%, transparent); text-decoration: underline dashed; }`}</style>
    {marks.map((mark) => <button key={mark.ids.join("-")} type="button" data-comment-ignore data-wiki-comment-count className="absolute z-10 flex items-center gap-1 rounded-md border bg-page-canvas px-1.5 py-0.5 text-micro shadow-sm" style={{ top: mark.top, left: mark.left }} aria-label={t(($) => $.wikiComments.count, { count: mark.count })} onClick={() => onThread(mark.ids[0]!, mark.ids)}><MessageSquare className="size-3" />{mark.count}</button>)}
    {selection ? <Button type="button" size="sm" data-comment-ignore className="absolute z-20 shadow-md" style={{ top: selection.top, left: selection.left }} onMouseDown={(e) => e.preventDefault()} onClick={() => { onCompose(selection.anchor); setSelection(null); window.getSelection()?.removeAllRanges(); }}><MessageSquare className="size-3.5" />{t(($) => $.wikiComments.add)}</Button> : null}
  </>;
}
