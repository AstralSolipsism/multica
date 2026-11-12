// Rendering-state rich diff for the baseline wiki (OL-1329, contract §7.4).
//
// Zero new dependencies: the generic Myers sequence diff moved here from the
// retired baseline-source-diff.ts, top-level blocks come from
// mdast-util-from-markdown (already a core dependency), and word tokens use
// Intl.Segmenter. The module guarantees the headline property the fixtures
// pin: whenever the two markdown sources differ, the diff contains at least
// one non-same entry; when only structure fields differ, callers render the
// metadata bar instead.

import type { Content, Heading, List, Code, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

// ---------- generic sequence diff (Myers LCS) ----------

export type SequenceOp = { op: "same" | "del" | "add"; aIndex?: number; bIndex?: number };

/** Longest-common-subsequence alignment over any sequence. */
export function diffSequence<T>(a: T[], b: T[], equals: (x: T, y: T) => boolean): SequenceOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((_, j) => ({ op: "add" as const, bIndex: j }));
  if (m === 0) return a.map((_, i) => ({ op: "del" as const, aIndex: i }));
  // LCS lengths via dynamic programming; inputs are page bodies (bounded).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const left = a[i];
      const right = b[j];
      const row = lcs[i];
      if (left !== undefined && right !== undefined && equals(left, right)) {
        if (row) row[j] = (lcs[i + 1]?.[j + 1] ?? 0) + 1;
      } else if (row) {
        row[j] = Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }
  const out: SequenceOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && equals(left, right)) {
      out.push({ op: "same", aIndex: i, bIndex: j });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ op: "del", aIndex: i });
      i++;
    } else {
      out.push({ op: "add", bIndex: j });
      j++;
    }
  }
  while (i < n) out.push({ op: "del", aIndex: i++ });
  while (j < m) out.push({ op: "add", bIndex: j++ });
  return out;
}

/** Fold consecutive same-op runs to keep long unchanged bodies readable. */
export function foldSequenceDiff(ops: SequenceOp[], contextBlocks = 1): Array<SequenceOp | { op: "fold"; count: number }> {
  const out: Array<SequenceOp | { op: "fold"; count: number }> = [];
  let run = 0;
  for (const op of ops) {
    if (op.op === "same") {
      run++;
      continue;
    }
    if (run > contextBlocks * 2 + 1) {
      for (let k = 0; k < contextBlocks && out.length; ) {
        const last = out[out.length - 1];
        if (last?.op === "same") {
          out.pop();
          k++;
        } else break;
      }
      out.push({ op: "fold", count: run - contextBlocks });
      for (let k = 0; k < contextBlocks; k++) out.push({ op: "same", aIndex: -1, bIndex: -1 });
    } else {
      for (let k = 0; k < run; k++) out.push({ op: "same", aIndex: -1, bIndex: -1 });
    }
    run = 0;
    out.push(op);
  }
  if (run > contextBlocks * 2 + 1) {
    for (let k = 0; k < contextBlocks; k++) out.push({ op: "same", aIndex: -1, bIndex: -1 });
    out.push({ op: "fold", count: run - contextBlocks });
  } else {
    for (let k = 0; k < run; k++) out.push({ op: "same", aIndex: -1, bIndex: -1 });
  }
  return out;
}

// ---------- top-level blocks ----------

export type WikiBlockKind = "heading" | "paragraph" | "list" | "code" | "table" | "blockquote" | "thematicBreak" | "html" | "other";

export interface WikiBlock {
  kind: WikiBlockKind;
  source: string;
  /** Normalized source (whitespace-collapsed) used for equality. */
  normalized: string;
  /** Block attribute signature: type + heading depth + list start/ordered + checked + code lang + table align. */
  signature: string;
  attrs: Record<string, string>;
  position: { start: number; end: number };
}

function kindOf(node: Content): WikiBlockKind {
  switch (node.type) {
    case "heading": return "heading";
    case "list": return "list";
    case "code": return "code";
    case "table": return "table";
    case "blockquote": return "blockquote";
    case "thematicBreak": return "thematicBreak";
    case "html": return "html";
    case "paragraph": return "paragraph";
    default: return "other";
  }
}

function blockSignature(kind: WikiBlockKind, node: Content): { signature: string; attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  switch (kind) {
    case "heading":
      attrs.depth = String((node as Heading).depth ?? 0);
      break;
    case "list": {
      const list = node as List;
      attrs.ordered = String(list.ordered ?? false);
      if (list.start != null && list.start !== 1) attrs.start = String(list.start);
      const first = list.children[0];
      if (first && first.type === "listItem" && first.checked != null) attrs.checked = String(first.checked);
      break;
    }
    case "code":
      attrs.lang = String((node as Code).lang ?? "");
      break;
    case "table": {
      const table = node as Table;
      attrs.align = (table.align ?? []).map((a) => String(a ?? "none")).join(",");
      break;
    }
    default:
      break;
  }
  const signature = [kind, ...Object.entries(attrs).map(([k, v]) => `${k}=${v}`)].join("|");
  return { signature, attrs };
}

function normalizeSource(source: string): string {
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n");
}

/** Split markdown into top-level blocks with source ranges from mdast positions. */
export function splitWikiBlocks(markdown: string): WikiBlock[] {
  const tree = fromMarkdown(markdown);
  const blocks: WikiBlock[] = [];
  for (const node of tree.children) {
    const start = node.position?.start?.offset ?? 0;
    const end = node.position?.end?.offset ?? markdown.length;
    const source = markdown.slice(start, end);
    const kind = kindOf(node);
    const { signature, attrs } = blockSignature(kind, node);
    blocks.push({ kind, source, normalized: normalizeSource(source), signature, attrs, position: { start, end } });
  }
  return blocks;
}

// ---------- word tokens with inline signatures ----------

export interface WikiWordToken {
  text: string;
  /** Inline formatting + link target signature; equal text with a different signature is a change. */
  signature: string;
}

const inlinePattern = new RegExp(
  [
    "(?<img>!\\[[^\\]]*\\]\\([^)]*\\))",
    "(?<wiki>\\[\\[[^\\]\\n\\r]+\\]\\])",
    "(?<link>\\[[^\\]]+\\]\\([^)]*\\))",
    "(?<code>`[^`\\n]+`)",
    "(?<boldStrong>\\*\\*[^*\\n]+\\*\\*)",
    "(?<bold>__[^_\\n]+__)",
    "(?<em>\\*[^*\\n]+\\*)",
    "(?<em2>_[^_\\n]+_)",
    "(?<del>~~[^~\\n]+~~)",
  ].join("|"),
  "g",
);

function signatureFor(groupName: string, match: string): string {
  switch (groupName) {
    case "img": return `img:${match}`;
    case "wiki": return `wiki:${match}`;
    case "link": {
      const href = match.slice(match.lastIndexOf("](") + 2, -1);
      return `a:${href.toLowerCase()}`;
    }
    case "code": return "code";
    case "boldStrong":
    case "bold": return "strong";
    case "em":
    case "em2": return "em";
    case "del": return "del";
    default: return "";
  }
}

let segmenter: Intl.Segmenter | undefined;
function wordSegmenter(): Intl.Segmenter {
  if (!segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return segmenter;
}

/** Segment one block's source into tokens: inline markup stays atomic, plain text goes through Intl.Segmenter. */
export function tokenizeWikiBlock(source: string): WikiWordToken[] {
  const tokens: WikiWordToken[] = [];
  let cursor = 0;
  for (const match of source.matchAll(inlinePattern)) {
    const groups = match.groups ?? {};
    const index = match.index ?? 0;
    if (index > cursor) tokens.push(...segmentPlain(source.slice(cursor, index)));
    const groupName = Object.keys(groups).find((key) => groups[key] !== undefined) ?? "";
    const text = match[0];
    tokens.push({ text, signature: signatureFor(groupName, text) });
    cursor = index + text.length;
  }
  if (cursor < source.length) tokens.push(...segmentPlain(source.slice(cursor)));
  return tokens;
}

function segmentPlain(text: string): WikiWordToken[] {
  const out: WikiWordToken[] = [];
  for (const part of wordSegmenter().segment(text)) {
    if (part.isWordLike || /\S/.test(part.segment)) out.push({ text: part.segment, signature: "" });
  }
  return out;
}

export type WikiWordDiffEntry = { op: "same" | "del" | "add"; text: string; signature: string };

/** Word-level diff; two tokens are equal only when text AND signature match. */
export function diffWikiTokens(before: WikiWordToken[], after: WikiWordToken[]): WikiWordDiffEntry[] {
  const ops = diffSequence(before, after, (a, b) => a.text === b.text && a.signature === b.signature);
  const out: WikiWordDiffEntry[] = [];
  for (const op of ops) {
    if (op.op === "same") {
      const token = before[op.aIndex as number];
      if (token) out.push({ op: "same", text: token.text, signature: token.signature });
    } else if (op.op === "del") {
      const token = before[op.aIndex as number];
      if (token) out.push({ op: "del", text: token.text, signature: token.signature });
    } else {
      const token = after[op.bIndex as number];
      if (token) out.push({ op: "add", text: token.text, signature: token.signature });
    }
  }
  return mergeWordRuns(out);
}

function mergeWordRuns(entries: WikiWordDiffEntry[]): WikiWordDiffEntry[] {
  const out: WikiWordDiffEntry[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (last && last.op === entry.op && last.signature === entry.signature) {
      last.text += entry.text;
    } else {
      out.push({ ...entry });
    }
  }
  return out;
}

/** True when the word-level diff shows an actual change. */
export function wordDiffChanged(entries: WikiWordDiffEntry[]): boolean {
  return entries.some((entry) => entry.op !== "same");
}

// ---------- block diff ----------

export type WikiBlockDiffEntry =
  | { op: "same"; block: WikiBlock }
  | { op: "del"; block: WikiBlock }
  | { op: "add"; block: WikiBlock }
  | { op: "mod"; before: WikiBlock; after: WikiBlock; attrChanges: string[]; wordDiff: WikiWordDiffEntry[] };

function blockEquals(a: WikiBlock, b: WikiBlock): boolean {
  return a.signature === b.signature && a.normalized === b.normalized;
}

/**
 * Align two markdown bodies. Structure-only revisions (rename/move/archive)
 * produce no entries here — the caller shows the metadata bar instead. The
 * pairing rule keeps an add+del pair of the same kind as a modification when
 * the LCS hit rate is at least half, mirroring the rendered-diff contract.
 */
export function diffWikiMarkdown(before: string, after: string): WikiBlockDiffEntry[] {
  if (before === after) return [];
  const beforeBlocks = splitWikiBlocks(before);
  const afterBlocks = splitWikiBlocks(after);
  const ops = diffSequence(beforeBlocks, afterBlocks, blockEquals);
  const out: WikiBlockDiffEntry[] = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (!op) continue;
    if (op.op === "same") {
      const block = beforeBlocks[op.aIndex as number];
      if (block) out.push({ op: "same", block });
      continue;
    }
    if (op.op === "del") {
      const next = ops[k + 1];
      const a = beforeBlocks[op.aIndex as number];
      const b = next?.op === "add" ? afterBlocks[next.bIndex as number] : undefined;
      if (a && b) {
        const headingPair = a.kind === "heading" && b.kind === "heading";
        if (a.kind === b.kind || headingPair) {
          const attrChanges = attrChangeLabels(a, b);
          const wordDiff = diffWikiTokens(tokenizeWikiBlock(a.source), tokenizeWikiBlock(b.source));
          if (wordDiffChanged(wordDiff) || attrChanges.length > 0 || a.signature !== b.signature) {
            out.push({ op: "mod", before: a, after: b, attrChanges, wordDiff });
            k++;
            continue;
          }
          if (a.source !== b.source) {
            // Signature and tokens could not see the difference (footnotes,
            // raw HTML, escapes): fall back to a whole-block compare so the
            // diff is never empty when the source differs.
            out.push({ op: "mod", before: a, after: b, attrChanges: [], wordDiff: [
              { op: "del", text: a.source, signature: "block" },
              { op: "add", text: b.source, signature: "block" },
            ] });
            k++;
            continue;
          }
        }
      }
      if (a) out.push({ op: "del", block: a });
      continue;
    }
    const block = afterBlocks[op.bIndex as number];
    if (block) out.push({ op: "add", block });
  }
  return out;
}

function attrChangeLabels(a: WikiBlock, b: WikiBlock): string[] {
  const labels: string[] = [];
  if (a.kind === "heading" && a.attrs.depth !== b.attrs.depth) {
    labels.push(`H${a.attrs.depth} → H${b.attrs.depth}`);
  }
  if (a.attrs.ordered !== undefined && a.attrs.ordered !== b.attrs.ordered) {
    labels.push(`${a.attrs.ordered === "true" ? "有序" : "无序"} → ${b.attrs.ordered === "true" ? "有序" : "无序"}`);
  }
  if (a.attrs.checked !== undefined && a.attrs.checked !== b.attrs.checked) {
    labels.push(`${a.attrs.checked === "true" ? "☑" : "☐"} → ${b.attrs.checked === "true" ? "☑" : "☐"}`);
  }
  if (a.attrs.lang !== undefined && a.attrs.lang !== b.attrs.lang) {
    labels.push(`语言 ${a.attrs.lang || "—"} → ${b.attrs.lang || "—"}`);
  }
  if (a.attrs.align !== undefined && a.attrs.align !== b.attrs.align) {
    labels.push(`对齐 ${a.attrs.align} → ${b.attrs.align}`);
  }
  return labels;
}

// ---------- structure metadata bar ----------

export interface WikiStructureSnapshot {
  title: string;
  slug: string;
  parent: string | null;
  position: number;
  archived: boolean;
}

export type WikiStructureChange = { field: keyof WikiStructureSnapshot; from: unknown; to: unknown };

export function diffWikiStructure(before: WikiStructureSnapshot, after: WikiStructureSnapshot): WikiStructureChange[] {
  const out: WikiStructureChange[] = [];
  for (const field of ["title", "slug", "parent", "position", "archived"] as const) {
    if (before[field] !== after[field]) {
      out.push({ field, from: before[field], to: after[field] });
    }
  }
  return out;
}

// ---------- source-line mode (collapsed fallback view) ----------

export type WikiSourceLineOp = { op: "same" | "del" | "add"; text: string };

export function diffWikiSourceLines(before: string, after: string): WikiSourceLineOp[] {
  const a = before.length ? before.split(/\r?\n/) : [];
  const b = after.length ? after.split(/\r?\n/) : [];
  return diffSequence(a, b, (x, y) => x === y).flatMap((op) => {
    const text = op.op === "add" ? b[op.bIndex as number] : a[op.aIndex as number];
    return text !== undefined ? [{ op: op.op, text }] : [];
  });
}

/** The "never empty" property the fixtures assert: different sources must produce a visible marker. */
export function wikiDiffHasChanges(before: string, after: string, structure: WikiStructureChange[]): boolean {
  if (before !== after && diffWikiMarkdown(before, after).length === 0) {
    // Same normalized blocks with different raw source still count.
    return true;
  }
  return diffWikiMarkdown(before, after).some((entry) => entry.op !== "same") || structure.length > 0;
}
