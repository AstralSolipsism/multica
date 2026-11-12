"use client";

// Rendered rich-diff view over the core block/word diff primitives
// (OL-1329 §7). Used by the history compare pane and the editor's
// "what did the other side change" conflict panel. Colors follow the UX spec
// add/del/mod token palette; they are expressed as arbitrary values so the
// wiki owns them without adding global UI tokens.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";
import {
  diffSequence,
  diffWikiMarkdown,
  diffWikiSourceLines,
  segmentWikiText,
  wikiDiffHasChanges,
  type WikiBlockDiffEntry,
  type WikiStructureChange,
} from "@multica/core/projects/baseline-wiki-diff";
import type { WikiLink } from "@multica/core/api";
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

/** Block containers terminate the inline formatting chain used for del clones. */
const BLOCK_STOP: Record<string, true> = {
  P: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, LI: true, UL: true, OL: true,
  BLOCKQUOTE: true, TD: true, TH: true, TR: true, THEAD: true, TBODY: true, TABLE: true, PRE: true,
  DIV: true, SECTION: true, ARTICLE: true,
};

/** Attribute tagging diff-injected marks so native GFM <del> (~~…~~) stays content. */
const DIFF_MARK = "data-wiki-diff-mark";

function isDiffMark(element: Element): boolean {
  return (element.tagName === "INS" || element.tagName === "DEL") && element.hasAttribute(DIFF_MARK);
}

/** Inline ancestors of a node, up to (excluding) its block container. */
function inlineChainOf(node: Node, root: HTMLElement): Element[] {
  const chain: Element[] = [];
  for (let cur = node.parentElement; cur && cur !== root && !BLOCK_STOP[cur.tagName]; cur = cur.parentElement) {
    chain.unshift(cur);
  }
  return chain;
}

/** Signature of an inline chain: `a[href=/old]`, `strong`, `code`, `button[data-wiki-link=slug]`… */
function signatureOfChain(chain: readonly Element[]): string {
  return chain.map((element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return `a[href=${element.getAttribute("href") ?? ""}]`;
    if (tag === "img") return `img[${element.getAttribute("src") ?? ""},${element.getAttribute("alt") ?? ""}]`;
    const target = element.getAttribute("data-wiki-link");
    return target === null ? tag : `${tag}[data-wiki-link=${target}]`;
  }).join(">");
}

/** One flattened token of a rendered block: a word segment, or an image as an atomic token. */
type DomToken = {
  text: string;
  signature: string;
  /** Absolute offset in the container's flattened text; images sit between characters. */
  offset: number;
  node: Text | HTMLImageElement;
  /** Character range inside the text node; 0/0 for images. */
  start: number;
  end: number;
};

/**
 * Flatten a rendered container into word tokens with inline signatures. Marks
 * (<ins>/<del> left over from an earlier pass) are skipped so re-runs see the
 * same underlying content.
 */
function tokenizeRendered(root: HTMLElement): { tokens: DomToken[]; total: number } {
  const tokens: DomToken[] = [];
  let offset = 0;
  const visit = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Text) {
        const signature = signatureOfChain(inlineChainOf(child, root));
        let local = 0;
        for (const segment of segmentWikiText(child.data)) {
          tokens.push({ text: segment.text, signature, offset: offset + local, node: child, start: local, end: local + segment.text.length });
          local += segment.text.length;
        }
        offset += local;
      } else if (child instanceof Element) {
        if (isDiffMark(child)) continue;
        if (child.tagName === "IMG") {
          tokens.push({
            text: "",
            signature: `img[${child.getAttribute("src") ?? ""},${child.getAttribute("alt") ?? ""}]`,
            offset,
            node: child as HTMLImageElement,
            start: 0,
            end: 0,
          });
        } else {
          visit(child);
        }
      }
    }
  };
  visit(root);
  return { tokens, total: offset };
}

type DomRun = { op: "same" | "del" | "add"; tokens: DomToken[] };

/** Build the <del> for a deleted run by cloning the before-DOM inline chains with sliced text. */
function buildDelElement(tokens: readonly DomToken[], beforeRoot: HTMLElement): HTMLElement {
  const del = document.createElement("del");
  del.setAttribute(DIFF_MARK, "");
  del.className = `${DEL_BG} rounded-xs px-0.5`;
  let index = 0;
  while (index < tokens.length) {
    const node = tokens[index]!.node;
    let last = index;
    while (last + 1 < tokens.length && tokens[last + 1]!.node === node) last += 1;
    const text = tokens.slice(index, last + 1).map((token) => token.text).join("");
    if (node instanceof HTMLImageElement) {
      del.appendChild(node.cloneNode(false));
    } else if (text) {
      let host: HTMLElement = del;
      for (const ancestor of inlineChainOf(node, beforeRoot)) {
        const clone = ancestor.cloneNode(false) as HTMLElement;
        host.appendChild(clone);
        host = clone;
      }
      host.appendChild(document.createTextNode(text));
    }
    index = last + 1;
  }
  return del;
}

/**
 * Overlay the word diff of two RENDERED containers onto the after DOM: added
 * runs are wrapped in <ins> (text-node splitting), deleted runs become <del>
 * elements holding clones of the before-DOM inline nodes. Returns false when
 * the two rendered sides share no token at all — the caller falls back to
 * stacked rendered views (never source text).
 */
/** Unwrap prior diff marks so a re-run starts clean; native <del> content stays. */
function clearDiffMarks(root: HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll(`ins[${DIFF_MARK}], del[${DIFF_MARK}]`))) {
    if (mark.tagName === "INS") mark.replaceWith(...Array.from(mark.childNodes));
    else mark.remove();
  }
}

function applyRenderedDiff(beforeRoot: HTMLElement, afterRoot: HTMLElement): boolean {
  clearDiffMarks(afterRoot);
  const before = tokenizeRendered(beforeRoot);
  const after = tokenizeRendered(afterRoot);
  const ops = diffSequence(before.tokens, after.tokens, (a, b) => a.text === b.text && a.signature === b.signature);
  const runs: DomRun[] = [];
  for (const op of ops) {
    // same/add runs must carry AFTER-side tokens: anchorAfter() turns their
    // offsets into insertion points in the after DOM, and before-side offsets
    // drift right by everything deleted before them. Only del runs read the
    // before side (their tokens feed the <del> clones).
    const useAfter = op.op !== "del";
    const side = useAfter ? after.tokens : before.tokens;
    const token = side[(useAfter ? op.bIndex : op.aIndex) as number];
    if (!token) continue;
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.op === op.op) lastRun.tokens.push(token);
    else runs.push({ op: op.op, tokens: [token] });
  }
  if (runs.length && !runs.some((run) => run.op === "same") && before.tokens.length && after.tokens.length) {
    return false; // no overlap: stacked renders read better than del+ins of everything
  }
  if (runs.every((run) => run.op === "same")) {
    // Rendered output is identical (escape-only source changes and the like):
    // per §7.4 item 6 the whole-block compare must still show something.
    return false;
  }
  // Offset of the first after token of the next run that consumes after-side
  // content; del marks are inserted there, or at the very end.
  const anchorAfter = (index: number): number => {
    for (let scan = index; scan < runs.length; scan++) {
      const run = runs[scan]!;
      if (run.op === "del") continue;
      const first = run.tokens[0];
      if (first) return first.offset;
    }
    return after.total;
  };
  const insertions: Array<{ anchor: number; element: HTMLElement }> = [];
  const wraps: Array<{ start: number; end: number }> = [];
  const imageAdds: DomToken[] = [];
  runs.forEach((run, index) => {
    if (run.op === "add") {
      const textTokens = run.tokens.filter((token) => !(token.node instanceof HTMLImageElement) && token.text);
      const first = textTokens[0];
      const last = textTokens[textTokens.length - 1];
      if (first && last) wraps.push({ start: first.offset, end: last.offset + last.text.length });
      imageAdds.push(...run.tokens.filter((token) => token.node instanceof HTMLImageElement));
    } else if (run.op === "del") {
      insertions.push({ anchor: anchorAfter(index + 1), element: buildDelElement(run.tokens, beforeRoot) });
    }
  });
  // Del insertions first: marks are skipped by the walker below, so flattened
  // offsets never shift. Applying in reverse keeps document order stable when
  // several del marks share an anchor.
  for (let index = insertions.length - 1; index >= 0; index--) {
    const live = textNodesOf(afterRoot);
    insertDelElementAt(live, afterRoot, insertions[index]!.element, insertions[index]!.anchor);
  }
  // Then ins wraps back-to-front so earlier offsets survive splitText surgery.
  for (let index = wraps.length - 1; index >= 0; index--) {
    const live = textNodesOf(afterRoot);
    wrapRangeIns(live, wraps[index]!.start, wraps[index]!.end);
  }
  for (const token of imageAdds) wrapImageIns(token.node as Element);
  return true;
}

/** Text nodes of a container with cumulative offsets; ins/del marks are skipped. */
function textNodesOf(root: HTMLElement): { nodes: Text[]; starts: number[]; total: number } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let total = 0;
  const visit = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Text) {
        nodes.push(child);
        starts.push(total);
        total += child.data.length;
      } else if (child instanceof Element && !isDiffMark(child)) {
        visit(child);
      }
    }
  };
  visit(root);
  return { nodes, starts, total };
}

function wrapRangeIns(live: { nodes: Text[]; starts: number[] }, start: number, end: number): void {
  const { nodes, starts } = live;
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
    ins.setAttribute(DIFF_MARK, "");
    ins.className = `${ADD_BG} rounded-xs px-0.5 no-underline`;
    target.parentNode?.insertBefore(ins, target);
    ins.appendChild(target);
  }
}

function insertDelElementAt(live: { nodes: Text[]; starts: number[]; total: number }, root: HTMLElement, element: HTMLElement, at: number): void {
  const { nodes, starts, total } = live;
  if (!nodes.length) {
    root.appendChild(element);
    return;
  }
  if (at >= total) {
    // Trailing deletions stay inline: append right after the last text node
    // (inside its paragraph), not at the container root.
    const last = nodes[nodes.length - 1]!;
    last.parentNode?.insertBefore(element, last.nextSibling);
    return;
  }
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1]! <= at) index += 1;
  const node = nodes[index]!;
  const local = at - starts[index]!;
  // Insert relative to the OUTERMOST inline ancestor: dropping the mark
  // inside a neighbouring <strong>/<a> would restyle deleted plain text.
  const hoist = (target: Node, before: boolean): void => {
    const chain = inlineChainOf(target, root).filter((el) => !isDiffMark(el));
    const outermost = chain[0];
    const anchor = outermost ?? target;
    const parent = anchor.parentElement;
    if (!parent) return;
    parent.insertBefore(element, before ? anchor : anchor.nextSibling);
  };
  if (local >= node.data.length) {
    hoist(node, false);
    return;
  }
  const rest = local > 0 ? node.splitText(local) : node;
  hoist(rest, true);
}

function wrapImageIns(image: Element): void {
  if (image.parentElement?.tagName === "INS") return;
  const ins = document.createElement("ins");
  ins.setAttribute(DIFF_MARK, "");
  ins.className = `${ADD_BG} rounded-xs px-0.5 no-underline`;
  image.parentNode?.insertBefore(ins, image);
  ins.appendChild(image);
}

/** Whole-block stacked compare: old (red, struck) above / new (green) below. */
function StackedCompare({ beforeSource, afterSource, links }: { beforeSource: string; afterSource: string; links?: readonly WikiLink[] }) {
  return (
    <div className="mt-1 space-y-1" data-wiki-diff-mod-fallback>
      <div className={cn("rounded-xs px-2", DEL_BG, DEL_BAR, DEL_TEXT)}>
        <WikiMarkdown markdown={beforeSource} links={links} />
      </div>
      <div className={cn("rounded-xs px-2", ADD_BG, ADD_BAR)}>
        <WikiMarkdown markdown={afterSource} links={links} />
      </div>
    </div>
  );
}

function ModBlock({ entry, links }: { entry: ModDiffEntry; links?: readonly WikiLink[] }) {
  const beforeRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const beforeSource = entry.before.source;
  const afterSource = entry.after.source;
  // Fenced code (plain, mermaid, html) renders into code shells or sandboxed
  // iframes with no comparable text nodes, and the contract wants whole-block
  // old/new compare there anyway (§7.4 item 5) — skip word-level entirely.
  const fenceCompare = entry.before.kind === "code" || entry.after.kind === "code";
  useLayoutEffect(() => {
    if (failed || fenceCompare) return;
    const beforeRoot = beforeRef.current;
    const afterRoot = afterRef.current;
    if (!beforeRoot || !afterRoot) return;
    try {
      if (!applyRenderedDiff(beforeRoot, afterRoot)) setFailed(true);
    } catch {
      setFailed(true);
    }
  }, [beforeSource, afterSource, failed, fenceCompare]);
  return (
    <div className={cn("my-1 rounded-xs px-2", MOD_BAR)} data-wiki-diff-mod>
      {entry.attrChanges.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {entry.attrChanges.map((label) => (
            <span key={label} className="rounded-full bg-warning/15 px-1.5 py-0.5 text-micro text-warning-foreground">{label}</span>
          ))}
        </div>
      ) : null}
      {failed || fenceCompare ? (
        <StackedCompare beforeSource={beforeSource} afterSource={afterSource} links={links} />
      ) : (
        <>
          {/* Both sides render through the same markdown pipeline; the before
              copy stays hidden and is only read for del clones. */}
          <div ref={beforeRef} hidden aria-hidden="true" data-wiki-diff-mod-before>
            <WikiMarkdown markdown={beforeSource} links={links} />
          </div>
          <div ref={afterRef}>
            <WikiMarkdown markdown={afterSource} links={links} />
          </div>
        </>
      )}
    </div>
  );
}

function BlockDiff({ entry, links, onExpandFold }: { entry: FoldedDiffEntry; links?: readonly WikiLink[]; onExpandFold: () => void }) {
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
    return <WikiMarkdown markdown={entry.block.source} links={links} />;
  }
  if (entry.op === "add") {
    return (
      <div className={cn("my-1 rounded-xs px-2", ADD_BG, ADD_BAR)} data-wiki-diff-add>
        <WikiMarkdown markdown={entry.block.source} links={links} />
      </div>
    );
  }
  if (entry.op === "del") {
    return (
      <div className={cn("my-1 rounded-xs px-2 opacity-80", DEL_BG, DEL_BAR, DEL_TEXT)} data-wiki-diff-del>
        <WikiMarkdown markdown={entry.block.source} links={links} />
      </div>
    );
  }
  return <ModBlock entry={entry} links={links} />;
}

export interface WikiDiffViewProps {
  before: string;
  after: string;
  /** Fold unchanged runs (仅看变更); defaults to true per the UX spec. */
  changesOnly?: boolean;
  /** Wiki link resolution data so both diff sides render chips, not `[[…]]` source. */
  links?: readonly WikiLink[];
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

export function WikiDiffView({ before, after, changesOnly = true, links, className }: WikiDiffViewProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = diffWikiMarkdown(before, after);
  const folded = changesOnly && !expanded ? foldEntries(entries) : entries;
  return (
    <div className={className} data-wiki-diff-view>
      {folded.map((entry, index) => (
        <BlockDiff key={index} entry={entry} links={links} onExpandFold={() => setExpanded(true)} />
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
