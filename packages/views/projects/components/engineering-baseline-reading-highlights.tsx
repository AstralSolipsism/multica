"use client";

import { useEffect, useId, type RefObject } from "react";
import type { BaselineDisplaySection } from "./engineering-baseline-utils";
import type { BaselineReadingEntry } from "./engineering-baseline-reading-card";
import { locateBaselineTextAnnotation } from "./engineering-baseline-text-annotations";

export function BaselineReadingHighlights({ articleRef, sections, entries, enabled, hoveredId, contentKey }: {
  articleRef: RefObject<HTMLDivElement | null>;
  sections: readonly BaselineDisplaySection[];
  entries: readonly BaselineReadingEntry[];
  enabled: boolean;
  hoveredId: string | null;
  contentKey: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const openName = `baseline-open-${id}`;
  const pendingName = `baseline-pending-${id}`;
  const focusName = `baseline-focus-${id}`;

  useEffect(() => {
    const supported = typeof Highlight !== "undefined" && typeof CSS !== "undefined" && !!CSS.highlights;
    if (!enabled || !supported || !articleRef.current) return;
    const open: Range[] = [];
    const pending: Range[] = [];
    for (const entry of entries) {
      if (entry.anchor.anchorKind !== "text") continue;
      const key = sections.find((section) => section.anchor === entry.anchor.sectionAnchor)?.key;
      const article = key ? Array.from(articleRef.current.querySelectorAll<HTMLElement>("[data-baseline-section-key]"))
        .find((element) => element.dataset.baselineSectionKey === key) : null;
      const root = article?.querySelector<HTMLElement>("[data-baseline-markdown]");
      const range = root ? locateBaselineTextAnnotation(root, entry.anchor).range : null;
      if (!range) continue;
      if (entry.kind === "thread" && entry.thread.root.state === "open") open.push(range);
      else if (entry.kind !== "thread") pending.push(range);
    }
    CSS.highlights.set(openName, new Highlight(...open));
    CSS.highlights.set(pendingName, new Highlight(...pending));
    const focused = entries.find((entry) => entry.id === hoveredId && entry.anchor.anchorKind === "text");
    if (focused) {
      const key = sections.find((section) => section.anchor === focused.anchor.sectionAnchor)?.key;
      const article = key ? Array.from(articleRef.current.querySelectorAll<HTMLElement>("[data-baseline-section-key]"))
        .find((element) => element.dataset.baselineSectionKey === key) : null;
      const root = article?.querySelector<HTMLElement>("[data-baseline-markdown]");
      const range = root ? locateBaselineTextAnnotation(root, focused.anchor).range : null;
      CSS.highlights.set(focusName, new Highlight(...(range ? [range] : [])));
    } else CSS.highlights.set(focusName, new Highlight());
    return () => {
      CSS.highlights.delete(openName);
      CSS.highlights.delete(pendingName);
      CSS.highlights.delete(focusName);
    };
  }, [articleRef, sections, entries, enabled, hoveredId, contentKey, openName, pendingName, focusName]);

  if (!enabled) return null;
  return <style>{`
    ::highlight(${openName}) { background-color: color-mix(in srgb, var(--warning) 26%, transparent); text-decoration: underline color-mix(in srgb, var(--warning) 70%, transparent) 1.5px; text-underline-offset: 4px; }
    ::highlight(${pendingName}) { background-color: color-mix(in srgb, var(--brand) 18%, transparent); text-decoration: underline dashed color-mix(in srgb, var(--brand) 65%, transparent) 1.5px; text-underline-offset: 4px; }
    ::highlight(${focusName}) { background-color: var(--find-match); color: var(--find-match-foreground); }
  `}</style>;
}
