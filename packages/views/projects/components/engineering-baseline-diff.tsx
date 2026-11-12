"use client";

// Rendered rich-diff view over the core block/word diff primitives
// (OL-1329 §7). Used by the history compare pane and the editor's
// "what did the other side change" conflict panel. Colors follow the UX spec
// add/del/mod token palette; they are expressed as arbitrary values so the
// wiki owns them without adding global UI tokens.

import { useState, type ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";
import {
  diffWikiMarkdown,
  diffWikiSourceLines,
  wikiDiffHasChanges,
  type WikiBlockDiffEntry,
  type WikiStructureChange,
} from "@multica/core/projects/baseline-wiki-diff";
import { useT } from "../../i18n";
import { WikiMarkdown } from "./engineering-baseline-markdown";

const ADD_BG = "bg-[oklch(0.94_0.07_150)] dark:bg-[oklch(0.34_0.07_150/0.55)]";
const DEL_BG = "bg-[oklch(0.945_0.05_22)] dark:bg-[oklch(0.36_0.09_22/0.5)]";
const ADD_BAR = "border-l-2 border-[oklch(0.62_0.15_150)] dark:border-[oklch(0.65_0.15_150)]";
const DEL_BAR = "border-l-2 border-[oklch(0.62_0.20_25)] dark:border-[oklch(0.65_0.18_25)]";
const MOD_BAR = "border-l-2 border-[oklch(0.75_0.15_80)]";
const DEL_TEXT = "line-through decoration-[oklch(0.44_0.14_25)] dark:decoration-[oklch(0.85_0.09_25)]";

export interface WikiDiffStats {
  added: number;
  removed: number;
  modified: number;
}

export function wikiDiffStats(entries: readonly WikiBlockDiffEntry[]): WikiDiffStats {
  const stats: WikiDiffStats = { added: 0, removed: 0, modified: 0 };
  for (const entry of entries) {
    if (entry.op === "add") stats.added += 1;
    else if (entry.op === "del") stats.removed += 1;
    else if (entry.op === "mod") stats.modified += 1;
  }
  return stats;
}

function WordDiff({ entry }: { entry: Extract<WikiBlockDiffEntry, { op: "mod" }> }) {
  return (
    <p className="my-2">
      {entry.wordDiff.map((token, index) => {
        if (token.op === "same") return <span key={index}>{token.text}</span>;
        if (token.op === "del") return <del key={index} className={cn(DEL_BG, "rounded-xs px-0.5")}>{token.text}</del>;
        return <ins key={index} className={cn(ADD_BG, "rounded-xs px-0.5 no-underline")}>{token.text}</ins>;
      })}
    </p>
  );
}

function BlockDiff({ entry, onExpandFold }: { entry: FoldedDiffEntry; onExpandFold: () => void }) {
  const { t } = useT("engineering");
  if (entry.op === "fold") {
    return (
      <button
        type="button"
        className="my-1 block w-full rounded-sm border border-dashed border-border px-2 py-1 text-left text-caption text-muted-foreground hover:text-foreground"
        onClick={onExpandFold}
        data-wiki-diff-fold
      >
        {t(($) => $.wiki.diffFolded, { count: entry.count })}
      </button>
    );
  }
  if (entry.op === "same") {
    return <WikiMarkdown markdown={entry.block.source} />;
  }
  if (entry.op === "add") {
    return (
      <div className={cn("my-1 rounded-xs px-2", ADD_BG, ADD_BAR)} data-wiki-diff-add>
        <WikiMarkdown markdown={entry.block.source} />
      </div>
    );
  }
  if (entry.op === "del") {
    return (
      <div className={cn("my-1 rounded-xs px-2 opacity-80", DEL_BG, DEL_BAR, DEL_TEXT)} data-wiki-diff-del>
        <WikiMarkdown markdown={entry.block.source} />
      </div>
    );
  }
  return (
    <div className={cn("my-1 rounded-xs px-2", MOD_BAR)} data-wiki-diff-mod>
      {entry.attrChanges.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {entry.attrChanges.map((label) => (
            <span key={label} className="rounded-full bg-warning/15 px-1.5 py-0.5 text-micro text-warning-foreground">{label}</span>
          ))}
        </div>
      ) : null}
      <WordDiff entry={entry} />
    </div>
  );
}

export interface WikiDiffViewProps {
  before: string;
  after: string;
  /** Fold unchanged runs (仅看变更); defaults to true per the UX spec. */
  changesOnly?: boolean;
  className?: string;
}

type FoldedDiffEntry = WikiBlockDiffEntry | { op: "fold"; count: number };

/** Collapse unchanged runs to `context` blocks on each side of a change. */
function foldEntries(entries: readonly WikiBlockDiffEntry[], context = 1): FoldedDiffEntry[] {
  const out: FoldedDiffEntry[] = [];
  let run: WikiBlockDiffEntry[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length <= context * 2 + 1) out.push(...run);
    else {
      out.push(...run.slice(0, context));
      out.push({ op: "fold", count: run.length - context * 2 });
      out.push(...run.slice(run.length - context));
    }
    run = [];
  };
  for (const entry of entries) {
    if (entry.op === "same") run.push(entry);
    else {
      flush();
      out.push(entry);
    }
  }
  flush();
  return out;
}

export function WikiDiffView({ before, after, changesOnly = true, className }: WikiDiffViewProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = diffWikiMarkdown(before, after);
  const folded = changesOnly && !expanded ? foldEntries(entries) : entries;
  return (
    <div className={className} data-wiki-diff-view>
      {folded.map((entry, index) => (
        <BlockDiff key={index} entry={entry} onExpandFold={() => setExpanded(true)} />
      ))}
    </div>
  );
}

export function WikiDiffSummary({ before, after }: { before: string; after: string }) {
  const { t } = useT("engineering");
  const stats = wikiDiffStats(diffWikiMarkdown(before, after));
  return (
    <span className="text-caption text-muted-foreground" data-wiki-diff-summary>
      {t(($) => $.wiki.diffSummary, { added: stats.added, removed: stats.removed, modified: stats.modified })}
      {wikiDiffHasChanges(before, after, []) ? null : ` · ${t(($) => $.wiki.diffNoChanges)}`}
    </span>
  );
}

export function WikiStructureBar({ changes }: { changes: readonly WikiStructureChange[] }) {
  const { t } = useT("engineering");
  if (!changes.length) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-sm border border-warning/40 bg-warning/5 px-2 py-1.5 text-caption" data-wiki-diff-structure>
      {changes.map((change) => (
        <span key={String(change.field)}>
          {t(($) => $.wiki.structureChange, { field: String(change.field), from: String(change.from), to: String(change.to) })}
        </span>
      ))}
    </div>
  );
}

export function WikiSourceDiff({ before, after }: { before: string; after: string }) {
  const { t } = useT("engineering");
  const [open, setOpen] = useState(false);
  const ops = diffWikiSourceLines(before, after);
  return (
    <div className="mt-4 border-t pt-2" data-wiki-source-diff>
      <button type="button" className="text-caption text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t(($) => $.wiki.sourceDiffToggle)}
      </button>
      {open ? (
        <pre className="mt-2 overflow-x-auto text-mono text-caption leading-5">
          {ops.map((op, index) => (
            <div
              key={index}
              className={cn(
                op.op === "add" && cn(ADD_BG, "text-foreground"),
                op.op === "del" && cn(DEL_BG, DEL_TEXT),
              )}
            >
              {op.op === "add" ? "+" : op.op === "del" ? "-" : " "} {op.text}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

export function WikiDiffLegend(): ReactNode {
  const { t } = useT("engineering");
  return (
    <div className="flex items-center gap-3 text-micro text-muted-foreground" data-wiki-diff-legend>
      <span className="inline-flex items-center gap-1"><span className={cn("inline-block size-2 rounded-xs", ADD_BG)} />{t(($) => $.wiki.diffAdded)}</span>
      <span className="inline-flex items-center gap-1"><span className={cn("inline-block size-2 rounded-xs", DEL_BG)} />{t(($) => $.wiki.diffRemoved)}</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block size-2 rounded-xs border border-[oklch(0.75_0.15_80)] bg-[oklch(0.96_0.03_80)] dark:bg-[oklch(0.3_0.05_80/0.5)]" />{t(($) => $.wiki.diffModified)}</span>
    </div>
  );
}
