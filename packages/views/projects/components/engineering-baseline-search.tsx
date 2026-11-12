"use client";

// Cmd/Ctrl+K global search palette for the baseline wiki (OL-1329 §3).
// Empty input: local pages/sections index only (instant). Typed input: the same
// local index filtered immediately, plus a 150ms-debounced server body search.
// Results group 页面 → 小节 → 正文 (body max 8); ↑↓/Enter navigate.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSearch, FileText, Hash, Search } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { projectWikiSearchOptions } from "@multica/core/projects/queries";
import type { WikiTreePage } from "@multica/core/api";
import { useT } from "../../i18n";

export interface WikiSearchTarget {
  slug: string;
  title: string;
  anchor?: string;
}

export interface WikiSearchPaletteProps {
  wsId: string;
  projectId: string;
  pages: readonly WikiTreePage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJump: (target: WikiSearchTarget) => void;
}

const BODY_RESULTS_LIMIT = 8;

interface PaletteRow {
  key: string;
  group: "page" | "section" | "body";
  slug: string;
  title: string;
  anchor?: string;
  sectionTitle?: string;
  snippet?: string;
}

export function WikiSearchPalette(props: WikiSearchPaletteProps) {
  const { t } = useT("engineering");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.open) {
      setQuery("");
      setDebounced("");
      setActiveIndex(0);
      return;
    }
    inputRef.current?.focus();
  }, [props.open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  const bodyQuery = useQuery({
    ...projectWikiSearchOptions(props.wsId, props.projectId, debounced, 50),
    enabled: props.open && debounced.length > 0,
  });

  const needle = query.trim().toLowerCase();
  const localRows = useMemo<PaletteRow[]>(() => {
    if (!needle) return [];
    const rows: PaletteRow[] = [];
    for (const page of props.pages) {
      if (page.title.toLowerCase().includes(needle) || page.slug.toLowerCase().includes(needle)) {
        rows.push({ key: `page:${page.id}`, group: "page", slug: page.slug, title: page.title });
      }
      for (const section of page.sections) {
        if (section.title.toLowerCase().includes(needle)) {
          rows.push({ key: `section:${page.id}:${section.anchor}`, group: "section", slug: page.slug, title: page.title, anchor: section.anchor, sectionTitle: section.title });
        }
      }
    }
    return rows;
  }, [needle, props.pages]);
  const bodyRows = useMemo<PaletteRow[]>(() => {
    if (!debounced) return [];
    return (bodyQuery.data?.results ?? [])
      .filter((hit) => hit.match === "body")
      .slice(0, BODY_RESULTS_LIMIT)
      .map((hit) => ({ key: `body:${hit.pageId}:${hit.sectionAnchor}`, group: "body" as const, slug: hit.slug, title: hit.title, anchor: hit.sectionAnchor || undefined, sectionTitle: hit.sectionTitle, snippet: hit.snippet }));
  }, [bodyQuery.data, debounced]);
  const rows = useMemo(() => [...localRows, ...bodyRows], [localRows, bodyRows]);

  useEffect(() => setActiveIndex(0), [rows.length]);

  if (!props.open) return null;

  const jump = (row: PaletteRow) => {
    props.onJump({ slug: row.slug, title: row.title, anchor: row.anchor });
    props.onOpenChange(false);
  };

  const groupLabel = { page: t(($) => $.wiki.searchGroupPage), section: t(($) => $.wiki.searchGroupSection), body: t(($) => $.wiki.searchGroupBody) } as const;
  let lastGroup = "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/30 pt-[12vh]" onClick={() => props.onOpenChange(false)} data-wiki-search-mask>
      <div
        className="w-[min(560px,calc(100%-2rem))] rounded-lg border bg-canvas shadow-lg"
        onClick={(event) => event.stopPropagation()}
        data-wiki-search
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body outline-none"
            placeholder={t(($) => $.wiki.searchPlaceholder)}
            aria-label={t(($) => $.wiki.searchPlaceholder)}
            data-wiki-search-input
            onKeyDown={(event) => {
              if (event.key === "Escape") props.onOpenChange(false);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, rows.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter" && rows[activeIndex]) jump(rows[activeIndex]);
            }}
          />
          <kbd className="rounded-xs border px-1.5 py-0.5 text-micro text-muted-foreground">{t(($) => $.wiki.searchEscKey)}</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5" role="listbox" aria-label={t(($) => $.wiki.searchResultsLabel)}>
          {!needle && !debounced ? (
            <p className="px-2 py-6 text-center text-caption text-muted-foreground">{t(($) => $.wiki.searchEmptyInput)}</p>
          ) : rows.length === 0 ? (
            <div className="px-2 py-6 text-center" data-wiki-search-empty>
              <p className="text-body text-muted-foreground">{t(($) => $.wiki.searchNoResults, { query })}</p>
              <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.wiki.searchNoResultsHint)}</p>
            </div>
          ) : rows.map((row, index) => {
            const header = row.group !== lastGroup ? groupLabel[row.group] : null;
            lastGroup = row.group;
            return (
              <div key={row.key}>
                {header ? <div className="px-2 pb-1 pt-2 text-micro uppercase tracking-wide text-muted-foreground">{header}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left",
                    index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => jump(row)}
                  data-wiki-search-row={`${row.slug}#${row.anchor ?? ""}`}
                >
                  {row.group === "page" ? <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    : row.group === "section" ? <Hash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    : <FileSearch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">
                      {row.group === "section" || row.group === "body" ? `${row.title} › ${row.sectionTitle}` : row.title}
                    </span>
                    {row.group === "body" && row.snippet ? <span className="block truncate text-caption text-muted-foreground">{row.snippet}</span> : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
