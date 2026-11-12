"use client";

// Rendered rich-diff view over the core block/word diff primitives
// (OL-1329 §7). Used by the history compare pane and the editor's
// "what did the other side change" conflict panel. Colors follow the UX spec
// add/del/mod token palette; they are expressed as arbitrary values so the
// wiki owns them without adding global UI tokens.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";
import {
  diffWikiMarkdown,
  diffWikiSourceLines,
  wikiDiffHasChanges,
  type WikiBlockDiffEntry,
  type WikiStructureChange,
  type WikiWordDiffEntry,
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

type ModDiffEntry = Extract<WikiBlockDiffEntry, { op: "mod" }>;

type DomSegment =
  | { kind: "ins"; start: number; end: number }
  | { kind: "del"; at: number; text: string };

/** Text nodes of a rendered block with their cumulative offsets. */
function textNodesOf(root: HTMLElement): { nodes: Text[]; starts: number[]; total: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(total);
    total += (node as Text).data.length;
  }
  return { nodes, starts, total };
}

/**
 * Map the word-diff runs onto the already-rendered AFTER block. Same/add runs
 * consume after-side text; the rendered DOM may carry extra characters or drop
 * markup syntax, so each expected character is matched with a bounded forward
 * scan and skipped when absent. Returns false when the mapping cannot be
 * trusted — the caller falls back to stacked renders.
 */
function mapWordDiffToDom(root: HTMLElement, wordDiff: readonly WikiWordDiffEntry[]): boolean {
  const initial = textNodesOf(root);
  const { nodes } = initial;
  const total = initial.total;
  const text = nodes.reduce((acc, node) => acc + node.data, "");
  const LOOKAHEAD = 64;
  const segments: DomSegment[] = [];
  let dom = 0;
  for (const run of wordDiff) {
    if (run.op === "del") {
      segments.push({ kind: "del", at: dom, text: run.text });
      continue;
    }
    let start = -1;
    let end = dom;
    for (const ch of run.text) {
      if (dom >= total) return false; // DOM exhausted while content is still unmapped
      const limit = Math.min(total, dom + LOOKAHEAD);
      let scan = dom;
      while (scan < limit && text[scan] !== ch) scan += 1;
      if (scan >= limit) continue; // renderer dropped or rewrote this character
      if (start === -1) start = scan;
      dom = scan + 1;
      end = dom;
    }
    if (run.op === "add" && start !== -1) segments.push({ kind: "ins", start, end });
  }
  // Apply back-to-front so earlier offsets survive the splitText surgery.
  // Every step re-walks the text nodes because splitText rewires them.
  const order = (segment: DomSegment) => (segment.kind === "del" ? segment.at : segment.start);
  segments.sort((a, b) => order(b) - order(a) || (a.kind === "ins" ? -1 : 1));
  for (const segment of segments) {
    const live = textNodesOf(root);
    if (segment.kind === "del") insertDelAt(live.nodes, live.starts, live.total, root, segment.at, segment.text);
    else wrapRangeIns(live.nodes, live.starts, segment.start, segment.end);
  }
  return true;
}

function wrapRangeIns(nodes: Text[], starts: number[], start: number, end: number): void {
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1]! <= start) index += 1;
  for (; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const nodeStart = starts[index]!;
    if (nodeStart >= end) break;
    const length = node.data.length;
    const from = Math.max(start, nodeStart) - nodeStart;
    const to = Math.min(end, nodeStart + length) - nodeStart;
    if (from >= to) continue;
    if (to < length) node.splitText(to);
    const target = from > 0 ? node.splitText(from) : node;
    const ins = document.createElement("ins");
    ins.className = `${ADD_BG} rounded-xs px-0.5 no-underline`;
    target.parentNode?.insertBefore(ins, target);
    ins.appendChild(target);
  }
}

function insertDelAt(nodes: Text[], starts: number[], total: number, root: HTMLElement, at: number, text: string): void {
  const del = document.createElement("del");
  del.className = `${DEL_BG} rounded-xs px-0.5`;
  del.textContent = text;
  if (!nodes.length || at >= total) {
    root.appendChild(del);
    return;
  }
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1]! <= at) index += 1;
  const node = nodes[index]!;
  const local = at - starts[index]!;
  if (local >= node.data.length) {
    node.parentNode?.insertBefore(del, node.nextSibling);
    return;
  }
  const rest = local > 0 ? node.splitText(local) : node;
  rest.parentNode?.insertBefore(del, rest);
}

/** Text of del runs that are not part of a replace (no adjacent add run). */
function pureDeletionText(wordDiff: readonly WikiWordDiffEntry[]): string | null {
  const parts: string[] = [];
  wordDiff.forEach((run, index) => {
    if (run.op !== "del") return;
    const prev = wordDiff[index - 1];
    const next = wordDiff[index + 1];
    if (prev?.op === "add" || next?.op === "add") return;
    parts.push(run.text);
  });
  return parts.length ? parts.join("") : null;
}

function ModBlock({ entry }: { entry: ModDiffEntry }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const afterSource = entry.after.source;
  useLayoutEffect(() => {
    if (failed) return;
    const host = hostRef.current;
    if (!host) return;
    try {
      if (!mapWordDiffToDom(host, entry.wordDiff)) setFailed(true);
    } catch {
      setFailed(true);
    }
  }, [afterSource, entry.wordDiff, failed]);
  const deleted = pureDeletionText(entry.wordDiff);
  return (
    <>
      {deleted && !failed ? (
        <div className={cn("my-1 rounded-xs px-2 text-caption", DEL_BG, DEL_TEXT)} data-wiki-diff-mod-deleted>
          {deleted}
        </div>
      ) : null}
      <div className={cn("my-1 rounded-xs px-2", MOD_BAR)} data-wiki-diff-mod>
        {entry.attrChanges.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.attrChanges.map((label) => (
              <span key={label} className="rounded-full bg-warning/15 px-1.5 py-0.5 text-micro text-warning-foreground">{label}</span>
            ))}
          </div>
        ) : null}
        {failed ? (
          <div className="mt-1 space-y-1" data-wiki-diff-mod-fallback>
            <div className={cn("rounded-xs px-2", DEL_BG, DEL_BAR, DEL_TEXT)}>
              <WikiMarkdown markdown={entry.before.source} />
            </div>
            <div className={cn("rounded-xs px-2", ADD_BG, ADD_BAR)}>
              <WikiMarkdown markdown={entry.after.source} />
            </div>
          </div>
        ) : (
          <div ref={hostRef}>
            <WikiMarkdown markdown={afterSource} />
          </div>
        )}
      </div>
    </>
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
  return <ModBlock entry={entry} />;
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
