"use client";

import { useLayoutEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import type { BaselineDisplaySection } from "./engineering-baseline-utils";
import { BaselineReadingEntryCard, type BaselineReadingEntry } from "./engineering-baseline-reading-card";
import { baselineSourceBlockForLines, locateBaselineTextAnnotation } from "./engineering-baseline-text-annotations";

interface BaselineInlineReadingEntryProps extends Omit<ComponentProps<typeof BaselineReadingEntryCard>, "entry" | "hovered"> {
  section: BaselineDisplaySection;
  entry: BaselineReadingEntry;
  hoveredId: string | null;
}

export function BaselineInlineReadingEntry({ section, entry, hoveredId, ...props }: BaselineInlineReadingEntryProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const anchor = entry.anchor;
  const lineStart = anchor.lineStart;
  const lineEnd = anchor.lineEnd;
  const quote = anchor.quote;
  const prefix = anchor.prefix;
  const suffix = anchor.suffix;
  const start = anchor.start;

  useLayoutEffect(() => {
    const article = Array.from(document.querySelectorAll<HTMLElement>("[data-baseline-section-key]"))
      .find((element) => element.dataset.baselineSectionKey === section.key);
    if (!article) return;
    const root = article.querySelector<HTMLElement>("[data-baseline-markdown]");
    let target: HTMLElement | null = null;
    if (root && anchor.anchorKind === "text") {
      const location = locateBaselineTextAnnotation(root, { quote, prefix, suffix, start });
      const node = location.range?.endContainer;
      const element = node instanceof Element ? node : node?.parentElement;
      target = element?.closest<HTMLElement>("[data-source-start][data-source-end]") ?? null;
      if (target && !root.contains(target)) target = null;
    } else if (root && anchor.anchorKind === "lines" && lineStart != null) {
      target = baselineSourceBlockForLines(root, lineStart, lineEnd ?? lineStart);
    }
    target ??= article.querySelector<HTMLElement>("h3");
    if (!target) return;
    const element = document.createElement("div");
    element.dataset.readingAnnotations = section.anchor;
    element.dataset.readingAnnotationPlacement = anchor.anchorKind;
    element.className = "my-2 max-w-3xl border-l-2 border-brand/30 pl-3";
    target.insertAdjacentElement("afterend", element);
    setContainer(element);
    return () => {
      setContainer(null);
      element.remove();
    };
  }, [section.key, section.anchor, anchor.anchorKind, lineStart, lineEnd, quote, prefix, suffix, start]);

  return container ? createPortal(
    <BaselineReadingEntryCard {...props} entry={entry} hovered={hoveredId === entry.id} />,
    container,
  ) : null;
}
