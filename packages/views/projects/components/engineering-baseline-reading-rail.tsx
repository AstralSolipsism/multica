"use client";

import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import type { BaselineDisplaySection } from "./engineering-baseline-utils";
import { BaselineReadingEntryCard, type BaselineReadingEntry } from "./engineering-baseline-reading-card";
import { baselineSourceBlockForLines, locateBaselineTextAnnotation } from "./engineering-baseline-text-annotations";

export interface BaselineRailLayoutItem {
  id: string;
  idealTop: number;
  height: number;
}

export function layoutBaselineReadingRail(items: readonly BaselineRailLayoutItem[], gap = 8): Record<string, number> {
  const positions: Record<string, number> = {};
  let bottom = -gap;
  items.forEach((item) => {
    const top = Math.max(item.idealTop, bottom + gap);
    positions[item.id] = top;
    bottom = top + Math.max(0, item.height);
  });
  return positions;
}

function sectionArticles(sections: readonly BaselineDisplaySection[]): Map<string, HTMLElement> {
  const byKey = new Map<string, HTMLElement>();
  for (const element of document.querySelectorAll<HTMLElement>("[data-baseline-section-key]")) {
    const key = element.dataset.baselineSectionKey!;
    if (!byKey.has(key)) byKey.set(key, element);
  }
  const articles = new Map<string, HTMLElement>();
  for (const section of sections) {
    const article = byKey.get(section.key);
    if (article) articles.set(section.anchor, article);
  }
  return articles;
}

function entryAnchorTop(entry: BaselineReadingEntry, article: HTMLElement | undefined, railTop: number, fallback: number, exact: boolean): number {
  if (!article) return 0;
  if (!exact) return fallback;
  const root = article.querySelector<HTMLElement>("[data-baseline-markdown]");
  if (!root) return fallback;
  if (entry.anchor.anchorKind === "text") {
    const location = locateBaselineTextAnnotation(root, entry.anchor);
    const range = location.range;
    if (!range) return fallback;
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return rect.top - railTop;
  }
  if (entry.anchor.anchorKind === "lines" && entry.anchor.lineStart != null) {
    const block = baselineSourceBlockForLines(root, entry.anchor.lineStart, entry.anchor.lineEnd ?? entry.anchor.lineStart);
    if (block) return block.getBoundingClientRect().top - railTop;
  }
  return fallback;
}

interface BaselineReadingRailProps extends Omit<ComponentProps<typeof BaselineReadingEntryCard>, "entry" | "hovered"> {
  sections: readonly BaselineDisplaySection[];
  entries: readonly BaselineReadingEntry[];
  hoveredId: string | null;
}

export function BaselineReadingRail(props: BaselineReadingRailProps) {
  const { t } = useT("engineering");
  const railRef = useRef<HTMLElement>(null);
  const entryIds = props.entries.map((entry) => entry.id).join(",");
  const sections = props.sections;

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    const layout = () => {
      frame = 0;
      const railTop = rail.getBoundingClientRect().top;
      const articles = sectionArticles(sections);
      const entries = new Map(props.entries.map((entry) => [entry.id, entry]));
      const cards = Array.from(rail.querySelectorAll<HTMLElement>(":scope > [data-reading-rail-item]"));
      const items = cards.map((card, order) => {
        const entry = entries.get(card.dataset.readingRailItem!);
        const article = entry ? articles.get(entry.anchor.sectionAnchor) : undefined;
        const heading = article?.querySelector("h3");
        const headingTop = heading?.getBoundingClientRect().top ?? 0;
        const near = headingTop >= window.innerHeight * -2 && headingTop <= window.innerHeight * 3;
        return {
          card, id: card.dataset.readingRailItem!, order,
          idealTop: entry && heading ? entryAnchorTop(entry, article, railTop, headingTop - railTop, near) : 0,
          height: card.offsetHeight,
        };
      });
      const positions = layoutBaselineReadingRail([...items].sort((a, b) => a.idealTop - b.idealTop || a.order - b.order));
      let bottom = 0;
      // Finish every geometry read before changing styles, including heights
      // used for the rail extent, to avoid a forced layout for each card.
      for (const item of items) {
        const top = positions[item.id] ?? 0;
        item.card.style.top = `${top}px`;
        item.card.dataset.layoutTop = String(top);
        bottom = Math.max(bottom, top + item.height);
      }
      rail.style.minHeight = `${Math.max(192, bottom + 8)}px`;
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(layout);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(rail);
    for (const card of rail.querySelectorAll(":scope > [data-reading-rail-item]")) observer.observe(card);
    for (const article of sectionArticles(sections).values()) observer.observe(article);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, { passive: true, capture: true });
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [entryIds, sections, props.entries]);

  return (
    <aside ref={railRef} className="relative min-h-48 self-stretch" aria-label={t(($) => $.annotations.annotationRail)} data-reading-rail>
      {props.entries.map((entry) => (
        <div key={entry.id} data-reading-rail-item={entry.id} className={cn("absolute inset-x-0 motion-safe:transition-[top]", props.hoveredId === entry.id && "z-10")}>
          <BaselineReadingEntryCard {...props} entry={entry} hovered={props.hoveredId === entry.id} />
        </div>
      ))}
    </aside>
  );
}
